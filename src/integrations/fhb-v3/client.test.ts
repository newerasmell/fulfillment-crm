import { describe, expect, it, vi } from "vitest";
import examples from "./__fixtures__/openapi-examples.json";
import { FhbClient, FhbError, FhbTokenCache, parseFhbDate, type FetchLike } from "./client";
import {
  FhbDeliveryPoints,
  FhbErrorBody,
  FhbOrderCreate,
  FhbOrderPage,
  FhbOrderUpdate,
  FhbOrderView,
  FhbParcelServices,
  FhbProductCreate,
  FhbProductPage,
  FhbProductUpdate,
  FhbProductView,
  FhbStockReceiptCreate,
  FhbStockReceiptView,
} from "./schemas";

// Fixtures are the vendor's documentation examples (docs/integrations/raw/fhb-kika-v3.openapi.json) — no real data.
const ex = examples as Record<string, unknown>;
const CREDS = { appId: "test-app-id", secret: "test-secret" };
const BASE = "https://api.fhb.sk/v3";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function fake(handlers: Handler[], opts: { expiration?: string } = {}) {
  const calls: { method: string; url: URL; headers: Record<string, string>; body: unknown }[] = [];
  let logins = 0;
  let i = 0;
  const fetchImpl = vi.fn<FetchLike>(async (u, init = {}) => {
    const url = new URL(u);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/v3/login") {
      logins++;
      return json({ token: `token-${logins}`, expiration: opts.expiration ?? "2099-01-01T00:00:00+0200" });
    }
    calls.push({ method: init.method ?? "GET", url, headers, body });
    const h = handlers[Math.min(i++, handlers.length - 1)];
    if (!h) throw new Error("no handler");
    return h(url, init);
  });
  const client = new FhbClient(CREDS, { fetchImpl, sleep: async () => {}, random: () => 0 });
  return { client, calls, fetchImpl, logins: () => logins };
}

describe("schemas accept every documented example", () => {
  const cases: [string, { safeParse: (v: unknown) => { success: boolean } }][] = [
    ["POST /product request", FhbProductCreate],
    ["PUT /product request", FhbProductUpdate],
    ["POST /product 200 response", FhbProductView],
    ["PUT /product 200 response", FhbProductView],
    ["GET /product 200 response", FhbProductView],
    ["GET /product/all 200 response", FhbProductPage],
    ["POST /order request", FhbOrderCreate],
    ["PUT /order request", FhbOrderUpdate],
    ["POST /order 200 response", FhbOrderView],
    ["PUT /order 200 response", FhbOrderView],
    ["GET /order 200 response", FhbOrderView],
    ["GET /order/history 200 response", FhbOrderPage],
    ["GET /parcel-service 200 example", FhbParcelServices],
    ["GET /delivery-point/{deliveryService} 200 example", FhbDeliveryPoints],
    ["POST /stock-receipt request", FhbStockReceiptCreate],
    ["POST /stock-receipt 200 response", FhbStockReceiptView],
    ["GET /stock-receipt 200 response", FhbStockReceiptView],
    ["PUT /product 400 demoteNotSupported", FhbErrorBody],
    ["DELETE /order 400 response", FhbErrorBody],
    ["GET /delivery-point/{deliveryService} 400 emptyCountry", FhbErrorBody],
  ];
  for (const [key, schema] of cases) {
    it(key, () => {
      expect(ex[key], `fixture ${key}`).toBeDefined();
      const res = schema.safeParse(ex[key]);
      expect(res.success, JSON.stringify((res as { error?: unknown }).error)).toBe(true);
    });
  }

  it("keeps unknown statuses and new fields instead of failing", () => {
    const order = {
      ...(ex["GET /order 200 response"] as object),
      status: "brand_new_status",
      extra_field: 1,
    };
    const parsed = FhbOrderView.parse(order);
    expect(parsed.status).toBe("brand_new_status");
    expect((parsed as Record<string, unknown>).extra_field).toBe(1);
  });

  it("accepts [] for empty objects and numeric ids", () => {
    const parsed = FhbOrderView.parse({ id: 123, proof_of_delivery: [], recipient: [] });
    expect(parsed.id).toBe("123");
    expect(parsed.proof_of_delivery).toBeNull();
  });

  it("refuses request keys that are not in the spec", () => {
    expect(FhbOrderCreate.safeParse({ ...(ex["POST /order request"] as object), made_up: 1 }).success).toBe(
      false,
    );
    expect(
      FhbOrderUpdate.safeParse({ ...(ex["PUT /order request"] as object), validate: true }).success,
    ).toBe(false);
  });
});

describe("FhbClient", () => {
  it("logs in, sends base64(token) and caches the token", async () => {
    const { client, calls, logins } = fake([() => json(ex["GET /product 200 response"])]);
    const p = await client.getProduct("123");
    await client.getProduct("123");
    expect(p?.id).toBe("123");
    expect(logins()).toBe(1);
    expect(calls[0]!.headers["X-Authentication-Simple"]).toBe(Buffer.from("token-1").toString("base64"));
    expect(calls[0]!.url.searchParams.get("id")).toBe("123");
  });

  it("re-logs in once on 401 and repeats the call once", async () => {
    const { client, logins, calls } = fake([
      () => json(ex["GET /order 401 example"], 401),
      () => json(ex["GET /order 200 response"]),
    ]);
    const o = await client.getOrder("AB12345");
    expect(o?.id).toBe("AB12345");
    expect(logins()).toBe(2);
    expect(calls[1]!.headers["X-Authentication-Simple"]).toBe(Buffer.from("token-2").toString("base64"));
  });

  it("gives up after a second 401", async () => {
    const { client } = fake([() => json({ message: "Unauthorized" }, 401)]);
    await expect(client.getOrder("X")).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("re-logs in when the token is about to expire (expiration - 5 min)", async () => {
    let now = Date.parse("2026-11-02T10:00:00Z");
    const tokens = new FhbTokenCache(() => now);
    let logins = 0;
    const fetchImpl: FetchLike = async (u) =>
      new URL(u).pathname === "/v3/login"
        ? json({ token: `t${++logins}`, expiration: "2026-11-02T12:00:00+0100" }) // 11:00Z
        : json(ex["GET /product 200 response"]);
    const client = new FhbClient(CREDS, { fetchImpl, tokens, sleep: async () => {} });
    await client.getProduct("1");
    now = Date.parse("2026-11-02T10:54:00Z");
    await client.getProduct("1");
    expect(logins).toBe(1);
    now = Date.parse("2026-11-02T10:56:00Z");
    await client.getProduct("1");
    expect(logins).toBe(2);
  });

  it("refuses wrong credentials on login (400)", async () => {
    const fetchImpl: FetchLike = async () => json(ex["POST /login 400 invalidCredentials"], 400);
    const client = new FhbClient(CREDS, { fetchImpl, sleep: async () => {} });
    await expect(client.getProduct("1")).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("retries reads on 5xx and 429 with backoff", async () => {
    const sleep = vi.fn(async () => {});
    let n = 0;
    const fetchImpl: FetchLike = async (u) => {
      if (new URL(u).pathname === "/v3/login") return json({ token: "t", expiration: null });
      n++;
      if (n === 1) return json({ message: "busy" }, 503);
      if (n === 2) return json({ message: "slow down" }, 429, { "retry-after": "2" });
      return json(ex["GET /parcel-service 200 example"]);
    };
    const client = new FhbClient(CREDS, { fetchImpl, sleep, random: () => 0 });
    const services = await client.parcelServices();
    expect(services.map((s) => s.code)).toEqual(["gls", "intime"]);
    expect(sleep).toHaveBeenNthCalledWith(1, 500);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  it("never retries a write on 5xx or timeout: the outcome is unknown", async () => {
    const { client, calls } = fake([() => json({ message: "oops" }, 502)]);
    const err = await client.createOrder(ex["POST /order request"] as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FhbError);
    expect((err as FhbError).outcomeUnknown).toBe(true);
    expect(calls).toHaveLength(1);

    const net = fake([
      () => {
        throw new Error("The operation was aborted due to timeout");
      },
    ]);
    const err2 = await net.client.createOrder(ex["POST /order request"] as never).catch((e: unknown) => e);
    expect((err2 as FhbError).code).toBe("network");
    expect((err2 as FhbError).outcomeUnknown).toBe(true);
    expect(net.calls).toHaveLength(1);
  });

  it("a write that never left (login down, or 429 until retries ran out) is not an unknown outcome", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const client = new FhbClient(CREDS, { fetchImpl, sleep: async () => {} });
    const err = (await client
      .createOrder(ex["POST /order request"] as never)
      .catch((e: unknown) => e)) as FhbError;
    expect(err.code).toBe("network");
    expect(err.outcomeUnknown).toBe(false);

    const throttled = fake([() => json({ message: "slow down" }, 429)]);
    const err2 = (await throttled.client
      .createOrder(ex["POST /order request"] as never)
      .catch((e: unknown) => e)) as FhbError;
    expect(err2.outcomeUnknown).toBe(false);
  });

  it("retries a write on 429 (not processed)", async () => {
    const { client, calls } = fake([
      () => json({ message: "slow down" }, 429),
      () => json(ex["POST /order 200 response"]),
    ]);
    const created = await client.createOrder(ex["POST /order request"] as never);
    expect(created.uid).toBe("3c7ac0f0ab");
    expect(calls).toHaveLength(2);
  });

  it("turns a 400 into a validation error with field paths", async () => {
    const { client } = fake([() => json(ex["PUT /product 400 notUniqueProduct"], 400)]);
    const err = (await client
      .updateProduct("123", { name: "x", new_id: "dup" })
      .catch((e: unknown) => e)) as FhbError;
    expect(err.code).toBe("validation");
    expect(err.outcomeUnknown).toBe(false);
    expect(err.violationCodes()).toEqual({ new_id: ["NOT_UNIQUE_PRODUCT_ERROR"] });
  });

  it("returns null for a 404 read and [] for delivery points of an empty country", async () => {
    const { client } = fake([
      () => json(ex["GET /product 404 example"], 404),
      () => json(ex["GET /delivery-point/{deliveryService} 404 example"], 404),
    ]);
    expect(await client.getProduct("missing")).toBeNull();
    expect(await client.deliveryPoints("gls_eu_pudo", "SK")).toEqual([]);
  });

  it("handles 204 deletes", async () => {
    const { client, calls } = fake([() => new Response(null, { status: 204 })]);
    await expect(client.deleteOrder("AB12345")).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url.searchParams.get("id")).toBe("AB12345");
  });

  it("fails loudly (but without values) on a response that breaks the schema", async () => {
    const { client } = fake([() => json({ page: "x" })]);
    await expect(client.listProducts(1)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("validates request bodies before sending", async () => {
    const { client, calls } = fake([() => json({})]);
    await expect(
      client.createOrder({ ...(ex["POST /order request"] as object), variable_symbol: "ABC" } as never),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("limits concurrency per credential set", async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl: FetchLike = async (u) => {
      if (new URL(u).pathname === "/v3/login") return json({ token: "t", expiration: null });
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return json(ex["GET /product 200 response"]);
    };
    const client = new FhbClient(CREDS, { fetchImpl, concurrency: 2 });
    await Promise.all(Array.from({ length: 6 }, () => client.getProduct("1")));
    expect(peak).toBe(2);
  });

  it("a read sleeping in backoff does not hold a concurrency slot (writes are not starved)", async () => {
    let releaseSleep!: () => void;
    const sleeping = new Promise<void>((r) => (releaseSleep = r));
    let reads = 0;
    const fetchImpl: FetchLike = async (u, init = {}) => {
      if (new URL(u).pathname === "/v3/login") return json({ token: "t", expiration: null });
      if ((init.method ?? "GET") === "GET")
        return ++reads === 1 ? json({}, 503) : json(ex["GET /product 200 response"]);
      return json(ex["POST /order 200 response"]);
    };
    let sleepStarted!: () => void;
    const inSleep = new Promise<void>((r) => (sleepStarted = r));
    const client = new FhbClient(CREDS, {
      fetchImpl,
      concurrency: 1,
      sleep: () => {
        sleepStarted();
        return sleeping;
      },
    });
    const read = client.getProduct("1");
    await inSleep;
    // The only slot is free while the read waits: the write goes through now.
    await expect(client.createOrder(ex["POST /order request"] as never)).resolves.toBeTruthy();
    releaseSleep();
    await expect(read).resolves.toBeTruthy();
  });

  it("only talks https to the configured base", () => {
    expect(() => new FhbClient(CREDS, { baseUrl: "http://api.fhb.sk/v3" })).toThrow();
    expect(new FhbClient(CREDS).baseUrl).toBe(BASE);
  });

  it("parses FHB dates with offsets without a colon", () => {
    expect(parseFhbDate("2018-10-17T14:47:40+0200")?.toISOString()).toBe("2018-10-17T12:47:40.000Z");
    expect(parseFhbDate("garbage")).toBeNull();
    expect(parseFhbDate(null)).toBeNull();
  });
});

describe("describeIssues", () => {
  it("names the differing fields and types without any values", async () => {
    const { describeIssues } = await import("./client");
    const { z } = await import("zod");
    const schema = z.object({
      total: z.number(),
      items: z.array(z.object({ amount: z.string(), name: z.string() })),
    });
    const r = schema.safeParse({
      items: [
        { amount: 12.5, name: "Secret Customer" },
        { amount: 3, name: "x" },
      ],
    });
    expect(r.success).toBe(false);
    const text = describeIssues(r.error!.issues);
    expect(text).toContain("total: expected number, missing");
    expect(text).toContain("items[].amount: expected string, got number");
    expect(text).not.toContain("Secret Customer");
    expect(text).not.toContain("12.5");
  });
});
