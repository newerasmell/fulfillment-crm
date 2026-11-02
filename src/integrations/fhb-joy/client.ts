import { z } from "zod";
import { FhbTokenCache } from "@/integrations/fhb-v3/client";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import {
  JOY_LIMITS,
  JoyDeliveryPoints,
  JoyErrorBody,
  JoyHalLink,
  JoyLabels,
  JoyLoginResponse,
  JoyPackageCreate,
  JoyPackageInfo,
  JoyShipmentCreate,
  JoyShipmentInfo,
  JoyShipmentLabel,
} from "./schemas";

/**
 * FHB Joy API HTTP client (production only; every label is real and billable — INTEGRATION_NOTES §3, §6).
 *
 * Auth: POST /login {appId, secret} (camelCase) → token valid 6 h; every call sends
 * `X-Authentication-Simple: base64(token)`. Tokens are cached per credential set until `expiration - 5 min`
 * (the FHB v3 cache is reused); on a 401 the client logs in again once and repeats the call once.
 *
 * Id placement (reference "Resource identifiers"): POST carries `id` in the JSON body; GET/PUT/DELETE carry it
 * in the query string — the client builds both, callers never choose.
 *
 * Retries: reads retry on network errors / 429 / 5xx with backoff; a write that times out or gets a 5xx is NOT
 * retried here — its outcome is unknown and the outbox resolves it by reading back GET /shipment?id=.
 */

export const JOY_BASE_URL = "https://system.fhb.sk/api/joy";
const REQUEST_TIMEOUT_MS = 30_000;

export const JoyCredentials = z.object({
  appId: z.string().trim().min(1).max(200),
  secret: z.string().trim().min(1).max(500),
});
export type JoyCredentials = z.infer<typeof JoyCredentials>;

export function parseJoyCredentials(secret: string): JoyCredentials {
  return JoyCredentials.parse(JSON.parse(secret));
}

export type JoyErrorCode =
  | "auth_failed" // login refused or 401 after a fresh login
  | "validation" // 400 {status, message, id}
  | "not_found" // 404
  | "conflict" // 409: already exists / wrong state
  | "http_error" // other 4xx (e.g. 405: id in the wrong place — a bug on our side)
  | "server_error" // 5xx (or 429 after all retries)
  | "network" // timeout / connection error: outcome unknown for writes
  | "invalid_response"; // 2xx whose body does not match the schema

export class JoyError extends Error {
  constructor(
    public readonly code: JoyErrorCode,
    message: string,
    public readonly status?: number,
    public readonly body?: JoyErrorBody,
    /** The call itself never left (login failed, or throttled until the retries ran out). */
    public readonly notSent = false,
  ) {
    super(message);
    this.name = "JoyError";
  }

  /** For a write: may Joy have acted on it? (Then only a read-back may decide what happened.) */
  get outcomeUnknown() {
    return (
      !this.notSent &&
      (this.code === "network" || this.code === "server_error" || this.code === "invalid_response")
    );
  }

  /** The field Joy names in a validation error (`id` of the error envelope). */
  get field() {
    return this.body?.id ?? null;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface JoyClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  tokens?: FhbTokenCache;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
}

type Method = "GET" | "POST" | "PUT" | "DELETE";
type Query = Record<string, string | undefined>;

const sharedTokens = new FhbTokenCache();
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class JoyClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly tokens: FhbTokenCache;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly key: string;

  constructor(
    private readonly creds: JoyCredentials,
    opts: JoyClientOptions = {},
  ) {
    this.baseUrl = (opts.baseUrl ?? JOY_BASE_URL).replace(/\/+$/, "");
    if (!/^https:\/\//.test(this.baseUrl)) throw new Error("Joy base URL must be https");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.tokens = opts.tokens ?? (opts.fetchImpl ? new FhbTokenCache() : sharedTokens);
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.key = `joy|${this.baseUrl}|${creds.appId}`;
  }

  private async login(): Promise<{ token: string; expiration?: string | null }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ appId: this.creds.appId, secret: this.creds.secret }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new JoyError(
        "network",
        `login failed: ${scrubText((err as Error).message)}`,
        undefined,
        undefined,
        true,
      );
    }
    if (res.status === 400 || res.status === 401 || res.status === 403)
      throw new JoyError("auth_failed", "Joy refused the appId / secret", res.status, undefined, true);
    if (!res.ok)
      throw new JoyError(
        res.status >= 500 ? "server_error" : "http_error",
        `login HTTP ${res.status}`,
        res.status,
        undefined,
        true,
      );
    const parsed = JoyLoginResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success)
      throw new JoyError("invalid_response", "login response has no token", res.status, undefined, true);
    return parsed.data;
  }

  private async readError(res: Response): Promise<JoyErrorBody | undefined> {
    const parsed = JoyErrorBody.safeParse(await res.json().catch(() => null));
    return parsed.success ? parsed.data : undefined;
  }

  /** One call. Returns the parsed body (undefined for 204 / no schema). Throws JoyError otherwise. */
  async request<S extends z.ZodTypeAny>(
    method: Method,
    path: string,
    opts: { query?: Query; body?: unknown; schema?: S } = {},
  ): Promise<z.infer<S>> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const isRead = method === "GET";
    let attempt = 0;
    let relogged = false;
    for (;;) {
      const token = await this.tokens.get(this.key, () => this.login());
      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), {
          method,
          headers: {
            Accept: "application/json",
            "X-Authentication-Simple": Buffer.from(token, "utf8").toString("base64"),
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const detail = scrubText((err as Error).message);
        if (isRead && attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt++);
          continue;
        }
        throw new JoyError("network", `${method} ${path}: ${detail}`);
      }
      if (res.status === 401 && !relogged) {
        relogged = true;
        this.tokens.invalidate(this.key, token);
        continue;
      }
      if (res.status === 429 || (isRead && res.status >= 500)) {
        if (attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt++);
          continue;
        }
        throw new JoyError(
          "server_error",
          `${method} ${path}: HTTP ${res.status}`,
          res.status,
          undefined,
          res.status === 429,
        );
      }
      if (res.status >= 500)
        throw new JoyError("server_error", `${method} ${path}: HTTP ${res.status}`, res.status);
      if (res.status === 401 || res.status === 403)
        throw new JoyError("auth_failed", `${method} ${path}: HTTP ${res.status}`, res.status);
      if (!res.ok) {
        const body = await this.readError(res);
        const message = scrubText(body?.message ?? `HTTP ${res.status}`);
        const code: JoyErrorCode =
          res.status === 400
            ? "validation"
            : res.status === 404
              ? "not_found"
              : res.status === 409
                ? "conflict"
                : "http_error";
        throw new JoyError(code, message, res.status, body);
      }
      if (res.status === 204 || !opts.schema) {
        await res.body?.cancel().catch(() => undefined);
        return undefined as never;
      }
      const json = await res.json().catch(() => undefined);
      const parsed = opts.schema.safeParse(json);
      if (!parsed.success) {
        logger.error(
          {
            path,
            issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), code: i.code })),
          },
          "joy response failed schema",
        );
        throw new JoyError(
          "invalid_response",
          `${method} ${path}: response does not match the schema`,
          res.status,
        );
      }
      return parsed.data as z.infer<S>;
    }
  }

  private async orNull<T>(p: Promise<T>): Promise<T | null> {
    try {
      return await p;
    } catch (err) {
      if (err instanceof JoyError && err.code === "not_found") return null;
      throw err;
    }
  }

  /** Login only (connection test). Forces a fresh token so a rotated secret is really tried. */
  async testLogin() {
    this.tokens.invalidate(this.key);
    await this.tokens.get(this.key, () => this.login());
    return true;
  }

  // ── shipments (synchronous flow) ──
  /** POST /shipments — creates the shipment and returns tracking + the base64 PDF label. BILLABLE. */
  async createShipment(body: JoyShipmentCreate) {
    return this.request("POST", "/shipments", {
      body: JoyShipmentCreate.parse(body),
      schema: JoyShipmentLabel,
    });
  }
  /** GET /shipments?id= — reprint (refused more than 5 days after creation). null on 404. */
  reprintShipment(id: string, labelOrientation?: "L" | "P") {
    return this.orNull(
      this.request("GET", "/shipments", { query: { id, labelOrientation }, schema: JoyShipmentLabel }),
    );
  }
  /** DELETE /shipments?id= — soft reject, only in `printed` state (409 otherwise). */
  async rejectShipment(id: string): Promise<void> {
    await this.request("DELETE", "/shipments", { query: { id } });
  }
  /** GET /shipment?id= — status + tracking; null on 404 (the read-back of a create). */
  getShipment(id: string) {
    return this.orNull(this.request("GET", "/shipment", { query: { id }, schema: JoyShipmentInfo }));
  }

  // ── labels ──
  /** GET /labels?ids=a,b,c (≤100) — one combined A6 PDF (base64). */
  async labels(ids: string[]) {
    if (ids.length === 0) throw new Error("at least one id");
    if (ids.length > JOY_LIMITS.labelsMax) throw new Error(`at most ${JOY_LIMITS.labelsMax} labels per call`);
    const q = ids.length === 1 ? { id: ids[0] } : { ids: ids.join(",") };
    return (await this.request("GET", "/labels", { query: q, schema: JoyLabels })).labels;
  }

  // ── packages (asynchronous flow; not used by the outbox yet — see notes) ──
  async createPackage(body: JoyPackageCreate) {
    return this.request("POST", "/packages", { body: JoyPackageCreate.parse(body), schema: JoyHalLink });
  }
  getPackage(id: string) {
    return this.orNull(this.request("GET", "/packages", { query: { id }, schema: JoyPackageInfo }));
  }
  async deletePackage(id: string): Promise<void> {
    await this.request("DELETE", "/packages", { query: { id } });
  }

  // ── delivery points ──
  deliveryPoints(parcelService: string) {
    return this.request("GET", "/delivery-point", { query: { parcelService }, schema: JoyDeliveryPoints });
  }
}
