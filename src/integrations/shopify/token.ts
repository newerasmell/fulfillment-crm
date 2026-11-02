import type { AppCredentials } from "./credentials";
import { ShopifyError } from "./errors";

/**
 * Client credentials grant (shopify.dev "Authenticate an app for stores in your organization", checked
 * 2026-11-02): POST https://{shop}/admin/oauth/access_token, form-encoded client_id / client_secret /
 * grant_type=client_credentials. Only works when the Dev Dashboard app and the store are in the same Shopify
 * organisation (otherwise `shop_not_permitted`). Tokens last 24 h (expires_in 86399); refresh = same request.
 * Tokens live only in memory: every process (web, worker) fetches its own.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface CachedToken {
  token: string;
  expiresAt: number;
}

const REFRESH_MARGIN_MS = 10 * 60_000;

export class TokenProvider {
  private cache = new Map<string, CachedToken>();
  private inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private key(domain: string, creds: AppCredentials) {
    return `${domain}|${creds.clientId}`;
  }

  invalidate(domain: string, creds: AppCredentials) {
    this.cache.delete(this.key(domain, creds));
  }

  async get(domain: string, creds: AppCredentials): Promise<string> {
    const key = this.key(domain, creds);
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt - REFRESH_MARGIN_MS > this.now()) return hit.token;
    // One request per store at a time, however many callers ask concurrently.
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.fetchToken(domain, creds).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async fetchToken(domain: string, creds: AppCredentials): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`https://${domain}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new ShopifyError("http_error", `token request failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      if (/shop_not_permitted/i.test(text)) {
        throw new ShopifyError(
          "shop_not_permitted",
          "app and store are not in the same Shopify organisation",
          res.status,
        );
      }
      throw new ShopifyError("auth_failed", `token request returned HTTP ${res.status}`, res.status);
    }
    let body: { access_token?: unknown; expires_in?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      throw new ShopifyError("invalid_response", "token response is not JSON");
    }
    if (typeof body.access_token !== "string") throw new ShopifyError("invalid_response", "no access_token");
    const ttl = typeof body.expires_in === "number" ? body.expires_in : 3600;
    this.cache.set(this.key(domain, creds), { token: body.access_token, expiresAt: this.now() + ttl * 1000 });
    return body.access_token;
  }
}
