import type { z } from "zod";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { normaliseShopDomain, SHOPIFY_API_VERSION } from "./config";
import type { AppCredentials } from "./credentials";
import { ShopifyError } from "./errors";
import { TokenProvider, type FetchLike } from "./token";

/**
 * Read-side GraphQL Admin API client for one store. Writes to Shopify (fulfillments, inventory) go through
 * the outbox from phase 4; this client is for queries and the few app-configuration mutations (webhooks).
 *
 * Rate limits: Shopify meters by query cost (leaky bucket, `extensions.cost.throttleStatus`). The client
 * remembers the bucket after each call and waits before the next one when the bucket is too low for the
 * last cost seen; a THROTTLED answer waits for exactly the missing points and retries.
 */

interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

interface GraphQLResponse {
  data?: unknown;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: ThrottleStatus } };
}

export interface ShopifyClientOptions {
  fetchImpl?: FetchLike;
  tokens?: TokenProvider;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sharedTokens = new TokenProvider();

export class ShopifyClient {
  readonly domain: string;
  private readonly fetchImpl: FetchLike;
  private readonly tokens: TokenProvider;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private bucket: { status: ThrottleStatus; at: number; lastCost: number } | null = null;

  constructor(
    domain: string,
    private readonly creds: AppCredentials,
    opts: ShopifyClientOptions = {},
  ) {
    this.domain = normaliseShopDomain(domain);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.tokens = opts.tokens ?? (opts.fetchImpl ? new TokenProvider(opts.fetchImpl) : sharedTokens);
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 4;
  }

  /** Seconds to wait so that `cost` points are available, given the last known bucket. */
  private waitForBudgetMs(cost: number): number {
    if (!this.bucket) return 0;
    const { status, at } = this.bucket;
    const restored = ((Date.now() - at) / 1000) * status.restoreRate;
    const available = Math.min(status.maximumAvailable, status.currentlyAvailable + restored);
    if (available >= cost) return 0;
    return Math.ceil(((cost - available) / Math.max(status.restoreRate, 1)) * 1000);
  }

  async query<S extends z.ZodTypeAny>(
    document: string,
    variables: Record<string, unknown>,
    schema: S,
  ): Promise<z.infer<S>> {
    let attempt = 0;
    let authRetried = false;
    for (;;) {
      const pre = this.waitForBudgetMs(this.bucket?.lastCost ?? 0);
      if (pre > 0) await this.sleep(pre);

      let res: Response;
      try {
        res = await this.fetchImpl(`https://${this.domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Shopify-Access-Token": await this.tokens.get(this.domain, this.creds),
          },
          body: JSON.stringify({ query: document, variables }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (err instanceof ShopifyError) throw err; // token errors are final
        if (attempt++ >= this.maxRetries)
          throw new ShopifyError("http_error", scrubText((err as Error).message));
        await this.sleep(500 * 2 ** attempt);
        continue;
      }

      if (res.status === 401 && !authRetried) {
        authRetried = true; // token expired or revoked early: fetch a new one once
        this.tokens.invalidate(this.domain, this.creds);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt++ >= this.maxRetries)
          throw new ShopifyError("http_error", `HTTP ${res.status}`, res.status);
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt,
        );
        continue;
      }
      if (!res.ok)
        throw new ShopifyError(
          res.status === 401 || res.status === 403 ? "auth_failed" : "http_error",
          `HTTP ${res.status}`,
          res.status,
        );

      let body: GraphQLResponse;
      try {
        body = (await res.json()) as GraphQLResponse;
      } catch {
        throw new ShopifyError("invalid_response", "response is not JSON");
      }
      const cost = body.extensions?.cost;
      if (cost?.throttleStatus) {
        this.bucket = { status: cost.throttleStatus, at: Date.now(), lastCost: cost.requestedQueryCost ?? 0 };
      }
      if (body.errors?.some((e) => e.extensions?.code === "THROTTLED")) {
        if (attempt++ >= this.maxRetries)
          throw new ShopifyError("throttled", "still throttled after retries");
        await this.sleep(Math.max(1000, this.waitForBudgetMs(cost?.requestedQueryCost ?? 100)));
        continue;
      }
      if (body.errors?.length) {
        throw new ShopifyError("graphql_error", scrubText(body.errors.map((e) => e.message).join("; ")));
      }
      const parsed = schema.safeParse(body.data);
      if (!parsed.success) {
        logger.error(
          { shop: this.domain, issues: parsed.error.issues.slice(0, 5) },
          "shopify response failed schema",
        );
        throw new ShopifyError("invalid_response", "response does not match the expected shape");
      }
      return parsed.data;
    }
  }
}
