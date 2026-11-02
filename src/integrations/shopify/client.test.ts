import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ShopifyClient } from "./client";
import { normaliseShopDomain } from "./config";
import { ShopifyError } from "./errors";
import { SHOP_QUERY, ShopResponse } from "./queries";
import { TokenProvider } from "./token";

const creds = { clientId: "client-id-123", clientSecret: "client-secret-456" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function fakeShopify(handlers: ((url: string, init?: RequestInit) => Response)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/admin/oauth/access_token"))
      return json({ access_token: `tok-${calls.length}`, expires_in: 86399 });
    const h = handlers.shift();
    if (!h) throw new Error("unexpected call");
    return h(url, init);
  });
  return { fetchImpl, calls };
}

const shopOk = () =>
  json({ data: { shop: { name: "Demo", myshopifyDomain: "demo.myshopify.com", currencyCode: "EUR" } } });

describe("shop domain", () => {
  it("accepts only *.myshopify.com hosts", () => {
    expect(normaliseShopDomain("https://Demo-Store.myshopify.com/admin")).toBe("demo-store.myshopify.com");
    for (const bad of ["evil.com", "demo.myshopify.com.evil.com", "localhost", "demo.shopify.com", ""]) {
      expect(() => normaliseShopDomain(bad), bad).toThrow("invalid_shop_domain");
    }
  });
});

describe("ShopifyClient", () => {
  it("gets a token with the client credentials grant, pins the API version and parses the answer", async () => {
    const { fetchImpl, calls } = fakeShopify([shopOk]);
    const c = new ShopifyClient("demo.myshopify.com", creds, { fetchImpl, sleep: async () => {} });
    expect((await c.query(SHOP_QUERY, {}, ShopResponse)).shop.currencyCode).toBe("EUR");
    const tokenCall = calls[0]!;
    expect(tokenCall.url).toBe("https://demo.myshopify.com/admin/oauth/access_token");
    expect(String(tokenCall.init?.body)).toContain("grant_type=client_credentials");
    expect(calls[1]!.url).toBe("https://demo.myshopify.com/admin/api/2026-10/graphql.json");
    expect((calls[1]!.init?.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe("tok-1");
  });

  it("reuses the token, refreshes it near expiry and once on a 401", async () => {
    let now = 1_000_000;
    const { fetchImpl, calls } = fakeShopify([shopOk, shopOk, () => json({}, 401), shopOk]);
    const tokens = new TokenProvider(fetchImpl, () => now);
    const c = new ShopifyClient("demo.myshopify.com", creds, { fetchImpl, tokens, sleep: async () => {} });
    await c.query(SHOP_QUERY, {}, ShopResponse);
    now += 23 * 3600_000 + 55 * 60_000; // inside the refresh margin
    await c.query(SHOP_QUERY, {}, ShopResponse);
    await c.query(SHOP_QUERY, {}, ShopResponse); // 401 → new token → ok
    expect(calls.filter((x) => x.url.endsWith("access_token"))).toHaveLength(3);
  });

  it("explains the different-organisation error", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"shop_not_permitted"}', { status: 400 }));
    const c = new ShopifyClient("demo.myshopify.com", creds, { fetchImpl, sleep: async () => {} });
    await expect(c.query(SHOP_QUERY, {}, ShopResponse)).rejects.toMatchObject({ code: "shop_not_permitted" });
  });

  it("waits for exactly the missing points when THROTTLED, then retries", async () => {
    const sleeps: number[] = [];
    const throttled = () =>
      json({
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        extensions: {
          cost: {
            requestedQueryCost: 500,
            throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 100, restoreRate: 100 },
          },
        },
      });
    const { fetchImpl } = fakeShopify([throttled, shopOk]);
    const c = new ShopifyClient("demo.myshopify.com", creds, {
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
    });
    await c.query(SHOP_QUERY, {}, ShopResponse);
    expect(sleeps[0]).toBeGreaterThanOrEqual(3900); // (500 - 100) / 100 per second ≈ 4 s
    expect(sleeps[0]).toBeLessThanOrEqual(4100);
  });

  it("retries 5xx and 429 with backoff, then gives up", async () => {
    const { fetchImpl } = fakeShopify([
      () => json({}, 502),
      () => json({}, 429, { "retry-after": "2" }),
      shopOk,
    ]);
    const sleeps: number[] = [];
    const c = new ShopifyClient("demo.myshopify.com", creds, {
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
    });
    await c.query(SHOP_QUERY, {}, ShopResponse);
    expect(sleeps).toEqual([1000, 2000]);
    const failing = fakeShopify(Array.from({ length: 10 }, () => () => json({}, 503)));
    const c2 = new ShopifyClient("demo.myshopify.com", creds, {
      fetchImpl: failing.fetchImpl,
      sleep: async () => {},
      maxRetries: 2,
    });
    await expect(c2.query(SHOP_QUERY, {}, ShopResponse)).rejects.toMatchObject({
      code: "http_error",
      status: 503,
    });
  });

  it("rejects GraphQL errors and answers of the wrong shape", async () => {
    const { fetchImpl } = fakeShopify([
      () => json({ errors: [{ message: "Field 'x' doesn't exist" }] }),
      () => json({ data: { shop: { name: 1 } } }),
    ]);
    const c = new ShopifyClient("demo.myshopify.com", creds, { fetchImpl, sleep: async () => {} });
    await expect(c.query(SHOP_QUERY, {}, ShopResponse)).rejects.toMatchObject({ code: "graphql_error" });
    await expect(c.query(SHOP_QUERY, {}, ShopResponse)).rejects.toBeInstanceOf(ShopifyError);
  });

  it("never sends credentials to a non-Shopify host", () => {
    expect(() => new ShopifyClient("attacker.example", creds)).toThrow("invalid_shop_domain");
    expect(z.string().safeParse("x").success).toBe(true);
  });
});
