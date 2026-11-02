import { z } from "zod";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import {
  FhbCod,
  FhbCodPage,
  FhbDeliveryPoints,
  FhbErrorBody,
  FhbLoginResponse,
  FhbOrderCreate,
  FhbOrderPage,
  FhbOrderUpdate,
  FhbOrderView,
  FhbParcelServices,
  FhbProductCreate,
  FhbProductPage,
  FhbProductUpdate,
  FhbProductView,
  FhbReturn,
  FhbReturnPage,
  FhbRmaPage,
  FhbStockLevel,
  FhbStockLevels,
  FhbStockMovementPage,
  FhbStockReceiptCreate,
  FhbStockReceiptUpdate,
  FhbStockReceiptView,
} from "./schemas";

/**
 * FHB Kika API v3 HTTP client (production only — there is no test flag; INTEGRATION_NOTES §2, §6).
 *
 * Auth: POST /login {app_id, secret} → {token, expiration}; every call sends `X-Authentication-Simple:
 * base64(token)`. Tokens are cached per credential set until `expiration - 5 min`; on a 401 the client logs in
 * again once and repeats the call once (a 401 means the call was not processed, so this is safe for writes).
 *
 * Retries: no rate limits are documented, so at most 4 concurrent requests per credential set, and exponential
 * backoff with jitter on 429 (all methods: a throttled call was not processed) and on 5xx / network errors for
 * READS only. A write that times out or gets a 5xx is NOT retried here: its outcome is unknown and the outbox
 * resolves it by reading back by id (CLAUDE.md: never create a duplicate shipment).
 */

export const FHB_BASE_URL = "https://api.fhb.sk/v3";
const TOKEN_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

export const FhbCredentials = z.object({
  appId: z.string().trim().min(1).max(200),
  secret: z.string().trim().min(1).max(500),
});
export type FhbCredentials = z.infer<typeof FhbCredentials>;

export function parseFhbCredentials(secret: string): FhbCredentials {
  return FhbCredentials.parse(JSON.parse(secret));
}

export type FhbErrorCode =
  | "auth_failed" // login refused or 401 after a fresh login
  | "validation" // 400 with {message, violations}
  | "not_found" // 404
  | "http_error" // other 4xx
  | "server_error" // 5xx (or 429 after all retries)
  | "network" // timeout / connection error: outcome unknown for writes
  | "invalid_response"; // 2xx whose body does not match the schema

export class FhbError extends Error {
  constructor(
    public readonly code: FhbErrorCode,
    message: string,
    public readonly status?: number,
    public readonly body?: FhbErrorBody,
    /** The call itself never left (login failed, or throttled with 429 until retries ran out). */
    public readonly notSent = false,
  ) {
    super(message);
    this.name = "FhbError";
  }

  /** For a write: did the vendor possibly act on it? (Then only a read-back may decide what happened.) */
  get outcomeUnknown() {
    return (
      !this.notSent &&
      (this.code === "network" || this.code === "server_error" || this.code === "invalid_response")
    );
  }

  /** Violation codes by field path, e.g. {"recipient.address.zip": ["IS_BLANK_ERROR"]}. */
  violationCodes(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [field, list] of Object.entries(this.body?.violations ?? {})) {
      out[field] = list.map((v) => (typeof v === "string" ? v : (v.code ?? v.message ?? "")));
    }
    return out;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Normalises "2018-10-17T14:47:40+0200" (offset without colon) so Date.parse reads it everywhere. */
export function parseFhbDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

interface CachedToken {
  token: string;
  until: number;
}

/** Login tokens per (base URL, app id). In memory only: every process (web, worker) logs in for itself. */
export class FhbTokenCache {
  private cache = new Map<string, CachedToken>();
  private inflight = new Map<string, Promise<string>>();
  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string, login: () => Promise<{ token: string; expiration?: string | null }>) {
    const hit = this.cache.get(key);
    if (hit && hit.until > this.now()) return hit.token;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = login()
        .then(({ token, expiration }) => {
          const exp = parseFhbDate(expiration)?.getTime() ?? this.now() + 15 * 60_000;
          // Clock skew must not cause a login per request: always keep a fresh token for at least a minute.
          this.cache.set(key, { token, until: Math.max(exp - TOKEN_MARGIN_MS, this.now() + 60_000) });
          return token;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  invalidate(key: string, token?: string) {
    const hit = this.cache.get(key);
    if (hit && (!token || hit.token === token)) this.cache.delete(key);
  }
}

/** Counting semaphore: at most `max` concurrent requests per credential set. */
class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const sharedTokens = new FhbTokenCache();
const sharedLimits = new Map<string, Semaphore>();

export interface FhbClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  tokens?: FhbTokenCache;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Retries for reads and 429s (default 4). */
  maxRetries?: number;
  /** Concurrent requests per credential set (default 4, INTEGRATION_NOTES §1.8). */
  concurrency?: number;
  timeoutMs?: number;
}

type Method = "GET" | "POST" | "PUT" | "DELETE";
type Query = Record<string, string | number | undefined>;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FhbClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly tokens: FhbTokenCache;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly limit: Semaphore;
  private readonly key: string;

  constructor(
    private readonly creds: FhbCredentials,
    opts: FhbClientOptions = {},
  ) {
    this.baseUrl = (opts.baseUrl ?? FHB_BASE_URL).replace(/\/+$/, "");
    if (!/^https:\/\//.test(this.baseUrl)) throw new Error("FHB base URL must be https");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.tokens = opts.tokens ?? (opts.fetchImpl ? new FhbTokenCache() : sharedTokens);
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.maxRetries = opts.maxRetries ?? 4;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.key = `${this.baseUrl}|${creds.appId}`;
    if (opts.concurrency || opts.fetchImpl) {
      this.limit = new Semaphore(opts.concurrency ?? 4);
    } else {
      let s = sharedLimits.get(this.key);
      if (!s) sharedLimits.set(this.key, (s = new Semaphore(4)));
      this.limit = s;
    }
  }

  private backoffMs(attempt: number, retryAfter: string | null) {
    const ra = Number(retryAfter);
    if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 60_000);
    return Math.min(30_000, 500 * 2 ** attempt) + Math.floor(this.random() * 250);
  }

  private async login(): Promise<{ token: string; expiration?: string | null }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ app_id: this.creds.appId, secret: this.creds.secret }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new FhbError(
        "network",
        `login failed: ${scrubText((err as Error).message)}`,
        undefined,
        undefined,
        true,
      );
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new FhbError("auth_failed", "FHB refused the app id / secret", res.status, undefined, true);
    }
    if (!res.ok)
      throw new FhbError(
        res.status >= 500 ? "server_error" : "http_error",
        `login HTTP ${res.status}`,
        res.status,
        undefined,
        true,
      );
    const parsed = FhbLoginResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success)
      throw new FhbError("invalid_response", "login response has no token", res.status, undefined, true);
    return parsed.data;
  }

  private async readError(res: Response): Promise<FhbErrorBody | undefined> {
    const body = await res.json().catch(() => null);
    const parsed = FhbErrorBody.safeParse(body);
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * One API call. Returns the parsed body (undefined for 204). Throws FhbError for everything else;
   * `err.outcomeUnknown` tells a write's caller that the vendor may have acted on it.
   */
  async request<S extends z.ZodTypeAny>(
    method: Method,
    path: string,
    opts: { query?: Query; body?: unknown; schema?: S; binary?: { maxBytes: number } } = {},
  ): Promise<z.infer<S>> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const isRead = method === "GET";
    // The concurrency slot is held only for the HTTP exchange itself, never across backoff sleeps: a degraded
    // read retrying with backoff must not keep queued writes waiting until the outbox marks them stale.
    {
      let attempt = 0;
      let relogged = false;
      for (;;) {
        const token = await this.tokens.get(this.key, () => this.login());
        let res: Response;
        try {
          res = await this.limit.run(() =>
            this.fetchImpl(url.toString(), {
              method,
              headers: {
                Accept: opts.binary ? "*/*" : "application/json",
                "X-Authentication-Simple": Buffer.from(token, "utf8").toString("base64"),
                ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
              },
              body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
              signal: AbortSignal.timeout(this.timeoutMs),
            }),
          );
        } catch (err) {
          const detail = scrubText((err as Error).message);
          if (isRead && attempt < this.maxRetries) {
            await this.sleep(this.backoffMs(attempt++, null));
            continue;
          }
          throw new FhbError("network", `${method} ${path}: ${detail}`);
        }

        if (res.status === 401 && !relogged) {
          relogged = true;
          this.tokens.invalidate(this.key, token);
          continue;
        }
        if (res.status === 429 || (isRead && res.status >= 500)) {
          if (attempt < this.maxRetries) {
            await this.sleep(this.backoffMs(attempt++, res.headers.get("retry-after")));
            continue;
          }
          // A final 429 was refused, not processed; a final 5xx on a read changes nothing either way.
          throw new FhbError(
            "server_error",
            `${method} ${path}: HTTP ${res.status}`,
            res.status,
            undefined,
            res.status === 429,
          );
        }
        if (res.status >= 500)
          throw new FhbError("server_error", `${method} ${path}: HTTP ${res.status}`, res.status);
        if (res.status === 401 || res.status === 403) {
          throw new FhbError("auth_failed", `${method} ${path}: HTTP ${res.status}`, res.status);
        }
        if (res.status === 400) {
          const body = await this.readError(res);
          throw new FhbError("validation", scrubText(body?.message ?? "Invalid request"), 400, body);
        }
        if (res.status === 404) {
          const body = await this.readError(res);
          throw new FhbError("not_found", scrubText(body?.message ?? "Not found"), 404, body);
        }
        if (!res.ok) {
          const body = await this.readError(res);
          throw new FhbError("http_error", `${method} ${path}: HTTP ${res.status}`, res.status, body);
        }
        if (opts.binary) {
          // Binary reads (return photos): capped, content type kept as sent; never parsed or logged.
          const declared = Number(res.headers.get("content-length") ?? 0);
          if (declared > opts.binary.maxBytes) {
            await res.body?.cancel().catch(() => undefined);
            throw new FhbError(
              "http_error",
              `${method} ${path}: file larger than ${opts.binary.maxBytes} bytes`,
            );
          }
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (bytes.byteLength > opts.binary.maxBytes)
            throw new FhbError(
              "http_error",
              `${method} ${path}: file larger than ${opts.binary.maxBytes} bytes`,
            );
          return { contentType: res.headers.get("content-type") ?? "", bytes } as never;
        }
        if (res.status === 204 || !opts.schema) {
          await res.body?.cancel().catch(() => undefined);
          return undefined as never;
        }
        const json = await res.json().catch(() => undefined);
        const parsed = opts.schema.safeParse(json);
        if (!parsed.success) {
          // Paths and codes only: the values may be customer data.
          logger.error(
            {
              path,
              issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), code: i.code })),
            },
            "fhb response failed schema",
          );
          // Field paths + expected types only (never values: they may be customer data), so the screen tells
          // exactly which part of the real response differs from the documented one.
          throw new FhbError(
            "invalid_response",
            `${method} ${path}: response does not match the schema (${describeIssues(parsed.error.issues, json)})`,
            res.status,
          );
        }
        return parsed.data as z.infer<S>;
      }
    }
  }

  /** Reads that answer 404 for "does not exist" return null instead of throwing. */
  private async orNull<T>(p: Promise<T>): Promise<T | null> {
    try {
      return await p;
    } catch (err) {
      if (err instanceof FhbError && err.code === "not_found") return null;
      throw err;
    }
  }

  // ── products ──
  getProduct(id: string) {
    return this.orNull(this.request("GET", "/product", { query: { id }, schema: FhbProductView }));
  }
  listProducts(page: number) {
    return this.request("GET", "/product/all", { query: { page }, schema: FhbProductPage });
  }
  async createProduct(body: FhbProductCreate) {
    return this.request("POST", "/product", { body: FhbProductCreate.parse(body), schema: FhbProductView });
  }
  async updateProduct(id: string, body: FhbProductUpdate) {
    return this.request("PUT", "/product", {
      query: { id },
      body: FhbProductUpdate.parse(body),
      schema: FhbProductView,
    });
  }

  // ── orders ──
  /** GET /order?id= — null when FHB answers 404 (the spec documents no 404 here; anything else throws). */
  getOrder(id: string) {
    return this.orNull(this.request("GET", "/order", { query: { id }, schema: FhbOrderView }));
  }
  orderHistory(q: { from?: string; to?: string; status?: string; page?: number }) {
    return this.request("GET", "/order/history", { query: q, schema: FhbOrderPage });
  }
  async createOrder(body: FhbOrderCreate) {
    return this.request("POST", "/order", { body: FhbOrderCreate.parse(body), schema: FhbOrderView });
  }
  async updateOrder(id: string, body: FhbOrderUpdate) {
    return this.request("PUT", "/order", {
      query: { id },
      body: FhbOrderUpdate.parse(body),
      schema: FhbOrderView,
    });
  }
  async deleteOrder(id: string): Promise<void> {
    await this.request("DELETE", "/order", { query: { id } });
  }

  // ── carriers ──
  parcelServices() {
    return this.request("GET", "/parcel-service", { schema: FhbParcelServices });
  }
  /** 404 = no delivery point of that service in the country (or unknown service) → []. */
  async deliveryPoints(service: string, country?: string) {
    const rows = await this.orNull(
      this.request("GET", `/delivery-point/${encodeURIComponent(service)}`, {
        query: { country },
        schema: FhbDeliveryPoints,
      }),
    );
    return rows ?? [];
  }

  // ── stock, returns, COD (read side, P2-02) ──
  /** GET /stock/all — physical quantity of every product (one response, no paging documented). */
  stockAll() {
    return this.request("GET", "/stock/all", { schema: FhbStockLevels });
  }
  /** GET /stock?id= — null on 404 (unknown product). */
  stock(id: string) {
    return this.orNull(this.request("GET", "/stock", { query: { id }, schema: FhbStockLevel }));
  }
  /** GET /stock/movements (500/page). `from`/`to` are timestamps, e.g. 2019-01-01T00:00:00.000Z (spec example). */
  stockMovements(q: { product?: string; receipt?: string; from?: string; to?: string; page?: number }) {
    return this.request("GET", "/stock/movements", { query: q, schema: FhbStockMovementPage });
  }
  /** GET /rma/list (100/page): `from`/`to` (ISO date) filter the RETURN date; sorted by order creation. */
  rmaList(q: { from?: string; to?: string; page?: number }) {
    return this.request("GET", "/rma/list", { query: q, schema: FhbRmaPage });
  }
  /** GET /return/list (100/page): local depot returns; empty unless the extra service is active. */
  returnList(q: { from?: string; to?: string; uid?: string; barcode?: string; page?: number }) {
    return this.request("GET", "/return/list", { query: q, schema: FhbReturnPage });
  }
  /** GET /return/{uid} — null on 404. */
  getReturn(uid: string) {
    return this.orNull(this.request("GET", `/return/${encodeURIComponent(uid)}`, { schema: FhbReturn }));
  }
  /** GET /return/{uid}/photo/{photoId} — the photo bytes (null on 404). Read only; capped at `maxBytes`. */
  returnPhoto(uid: string, photoId: string, maxBytes = 5 * 1024 * 1024) {
    return this.orNull(
      this.request("GET", `/return/${encodeURIComponent(uid)}/photo/${encodeURIComponent(photoId)}`, {
        binary: { maxBytes },
      }) as Promise<{ contentType: string; bytes: Uint8Array }>,
    );
  }
  /** GET /cod/list (100/page), status waiting|received|paid, `from`/`to` ISO dates on order creation. */
  codList(q: { status?: string; from?: string; to?: string; page?: number }) {
    return this.request("GET", "/cod/list", { query: q, schema: FhbCodPage });
  }
  /** GET /cod?id= — null on 404 (no COD on that order). */
  cod(id: string) {
    return this.orNull(this.request("GET", "/cod", { query: { id }, schema: FhbCod }));
  }

  // ── stock receipts ──
  getStockReceipt(id: string) {
    return this.orNull(this.request("GET", "/stock-receipt", { query: { id }, schema: FhbStockReceiptView }));
  }
  async createStockReceipt(body: FhbStockReceiptCreate) {
    return this.request("POST", "/stock-receipt", {
      body: FhbStockReceiptCreate.parse(body),
      schema: FhbStockReceiptView,
    });
  }
  async updateStockReceipt(id: string, body: FhbStockReceiptUpdate) {
    return this.request("PUT", "/stock-receipt", {
      query: { id },
      body: FhbStockReceiptUpdate.parse(body),
      schema: FhbStockReceiptView,
    });
  }
  async deleteStockReceipt(id: string): Promise<void> {
    await this.request("DELETE", "/stock-receipt", { query: { id } });
  }
}

/** "items.0.amount: expected string, got number; total: required" — paths with indexes collapsed, no values. */
export function describeIssues(issues: readonly z.core.$ZodIssue[], input?: unknown, max = 4) {
  const seen = new Set<string>();
  for (const i of issues) {
    const path =
      i.path
        .map((k) => (typeof k === "number" ? "[]" : String(k)))
        .join(".")
        .replace(/\.\[\]/g, "[]") || "(root)";
    // Zod's own messages name types only ("expected string, received number" / "received undefined").
    const typeText = (m: string) =>
      m
        .replace(/^Invalid input: /, "")
        .replace("received undefined", "missing")
        .replace("received", "got");
    let detail: string;
    if (i.code === "invalid_type") detail = typeText(i.message);
    else if (i.code === "invalid_union") {
      const first = (i as { errors?: z.core.$ZodIssue[][] }).errors?.[0]?.[0];
      detail = first?.code === "invalid_type" ? typeText(first.message) : "invalid_union";
    } else detail = i.code;
    // The field NAMES present next to the failing one (never values) show what the vendor really sends.
    const parent = at(input, i.path.slice(0, -1));
    const keys =
      parent && typeof parent === "object" && !Array.isArray(parent)
        ? ` [has: ${Object.keys(parent).slice(0, 15).join(", ")}]`
        : "";
    seen.add(`${path}: ${detail}${keys}`);
    if (seen.size >= max) break;
  }
  const rest = issues.length - seen.size;
  return [...seen].join("; ") + (rest > 0 ? ` (+${rest} more)` : "");
}

function at(v: unknown, path: readonly PropertyKey[]): unknown {
  let cur = v;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[k];
  }
  return cur;
}
