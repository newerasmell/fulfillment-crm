import { beforeAll, describe, expect, it, vi } from "vitest";
import examples from "@/integrations/fhb-v3/__fixtures__/openapi-examples.json";
import type { FetchLike } from "@/integrations/fhb-v3/client";
import type { Actor } from "@/server/accounts";
import { systemDb } from "@/server/db/client";
import {
  authenticateFhbCallbackPath,
  fhbCallbackToken,
  fhbOrderNotificationUrls,
  fhbStockNotifyUrl,
} from "./callback-token";
import { processFhbCallback, receiveFhbCallback, staleFhbEvents } from "./callbacks";
import { createFhbConnection } from "./connection";

// Synthetic data only; FHB answers are the vendor's documentation examples.
const ex = examples as unknown as Record<string, Record<string, unknown>>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeAll(() => {
  process.env.APP_URL = "https://crm.example.test";
});

const segmentsOf = (url: string) => new URL(url).pathname.split("/").slice(4);

function fakeFhb(handlers: Record<string, (url: URL) => Response>) {
  const calls: string[] = [];
  const fetchImpl = vi.fn<FetchLike>(async (u, init = {}) => {
    const url = new URL(u);
    if (url.pathname === "/v3/login") return json({ token: "t", expiration: null });
    const key = `${init.method ?? "GET"} ${url.pathname.replace("/v3", "")}`;
    calls.push(`${key}?${url.searchParams.toString()}`);
    const h = handlers[key];
    if (!h) throw new Error(`unexpected ${key}`);
    return h(url);
  });
  return { calls, opts: { fetchImpl, sleep: async () => {} } };
}

let seq = 0;
async function setup() {
  const sys = systemDb();
  const account = await sys.account.create({ data: { name: `FHB cb ${++seq}` } });
  const company = await sys.company.create({ data: { accountId: account.id, name: "Demo Co" } });
  const owner: Actor = { userId: "u-owner", accountId: account.id, role: "OWNER" };
  const connection = await createFhbConnection(owner, {
    companyId: company.id,
    name: "FHB test",
    appId: "test-app",
    secret: "test-secret",
  });
  const order = await sys.order.create({
    data: {
      accountId: account.id,
      companyId: company.id,
      source: "MANUAL",
      number: "M-1",
      currency: "EUR",
      subtotal: "1.00",
      total: "1.00",
      paymentMethod: "PREPAID",
      placedAt: new Date(),
    },
  });
  const fulfillment = await sys.fulfillment.create({
    data: {
      accountId: account.id,
      orderId: order.id,
      connectionId: connection.id,
      externalId: "TST-2001",
      variableSymbol: "7",
      status: "ACCEPTED",
      rawStatus: "pending",
    },
  });
  return { account, connection, fulfillment };
}

describe("callback URL tokens", () => {
  it("authenticates only our own signed paths", () => {
    const urls = fhbOrderNotificationUrls("conn1", "ful1", "https://crm.example.test");
    expect(authenticateFhbCallbackPath(segmentsOf(urls.sent))).toEqual({
      connectionId: "conn1",
      scope: { kind: "order", fulfillmentId: "ful1", event: "sent" },
    });
    const stock = fhbStockNotifyUrl("conn1", "https://crm.example.test");
    expect(authenticateFhbCallbackPath(segmentsOf(stock))).toEqual({
      connectionId: "conn1",
      scope: { kind: "stock" },
    });

    const token = fhbCallbackToken("conn1", { kind: "order", fulfillmentId: "ful1", event: "sent" });
    // token of one event/shipment/connection does not open another
    expect(authenticateFhbCallbackPath(["conn1", "order", "ful1", "delivered", token])).toBeNull();
    expect(authenticateFhbCallbackPath(["conn1", "order", "ful2", "sent", token])).toBeNull();
    expect(authenticateFhbCallbackPath(["conn2", "order", "ful1", "sent", token])).toBeNull();
    expect(authenticateFhbCallbackPath(["conn1", "stock", token])).toBeNull();
    expect(authenticateFhbCallbackPath(["conn1", "order", "ful1", "made_up", token])).toBeNull();
    expect(authenticateFhbCallbackPath(["conn1", "stock", "x".repeat(32)])).toBeNull();
    expect(authenticateFhbCallbackPath(["../x", "stock", token])).toBeNull();
    expect(authenticateFhbCallbackPath([])).toBeNull();
  });
});

describe("FHB callbacks", () => {
  it("an order event re-reads the order from FHB and ignores the body", async () => {
    const s = await setup();
    const url = fhbOrderNotificationUrls(s.connection.id, s.fulfillment.id).sent;
    // The body claims "delivered"; FHB itself says "sent" — FHB's read wins.
    const rec = await receiveFhbCallback(segmentsOf(url), JSON.stringify({ status: "delivered" }));
    expect(rec).toMatchObject({ status: 200, duplicate: false });
    const eventId = (rec as { eventId: string }).eventId;
    const ev = await systemDb().webhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(ev).toMatchObject({
      source: "FHB",
      topic: "order.sent",
      payload: { fulfillmentId: s.fulfillment.id },
    });

    const fhb = fakeFhb({
      "GET /order": (u) =>
        json({
          ...ex["GET /order 200 response"],
          id: u.searchParams.get("id"),
          status: "sent",
          tracking_numbers: ["TRK1"],
        }),
    });
    expect(await processFhbCallback(s.account.id, eventId, fhb.opts)).toBe("PROCESSED");
    expect(fhb.calls).toEqual(["GET /order?id=TST-2001"]);
    const f = await systemDb().fulfillment.findUniqueOrThrow({ where: { id: s.fulfillment.id } });
    expect(f).toMatchObject({ status: "SHIPPED", rawStatus: "sent", trackingNumbers: ["TRK1"] });
    // processing again is a no-op
    expect(await processFhbCallback(s.account.id, eventId, fhb.opts)).toBe("PROCESSED");
    expect(fhb.calls).toHaveLength(1);
  });

  it("a stock notification only names the product; the numbers come from GET /product", async () => {
    const s = await setup();
    const url = fhbStockNotifyUrl(s.connection.id);
    const body = JSON.stringify({
      id: "RSKU-1",
      type: "out",
      qty: 1,
      stockQuantity: 999,
      reason: 2,
      serialNumbers: [],
    });
    const rec = (await receiveFhbCallback(segmentsOf(url), body)) as { eventId: string };
    const fhb = fakeFhb({
      "GET /product": (u) =>
        json({
          ...ex["GET /product 200 response"],
          id: u.searchParams.get("id"),
          stock_quantity: 5,
          free_quantity: 4,
        }),
    });
    expect(await processFhbCallback(s.account.id, rec.eventId, fhb.opts)).toBe("PROCESSED");
    const vp = await systemDb().vendorProduct.findFirstOrThrow({
      where: { connectionId: s.connection.id, vendorId: "RSKU-1" },
      include: { stockLevel: true },
    });
    expect(vp.stockLevel).toMatchObject({ physical: 5, free: 4, sellable: 4, source: "PUSH" });
  });

  it("forged, unknown and malformed calls do nothing", async () => {
    const s = await setup();
    expect(await receiveFhbCallback([s.connection.id, "stock", "A".repeat(32)], "{}")).toEqual({
      status: 404,
    });
    // valid token for a connection that does not exist
    expect(
      await receiveFhbCallback(segmentsOf(fhbStockNotifyUrl("cnotaconnection00000000000")), "{}"),
    ).toEqual({
      status: 404,
    });
    // a stock body without a product id is stored but ignored
    const rec = (await receiveFhbCallback(segmentsOf(fhbStockNotifyUrl(s.connection.id)), "not json")) as {
      eventId: string;
    };
    expect(await processFhbCallback(s.account.id, rec.eventId, fakeFhb({}).opts)).toBe("IGNORED");
  });

  it("dedupes repeats within a minute, and failed events are retried by the sweep", async () => {
    const s = await setup();
    const url = fhbOrderNotificationUrls(s.connection.id, s.fulfillment.id).confirmed;
    const now = new Date("2026-11-02T10:00:10Z");
    const a = await receiveFhbCallback(segmentsOf(url), "", now);
    const b = await receiveFhbCallback(segmentsOf(url), "", new Date("2026-11-02T10:00:40Z"));
    expect(b).toMatchObject({ status: 200, duplicate: true, eventId: null });
    const c = await receiveFhbCallback(segmentsOf(url), "", new Date("2026-11-02T10:05:00Z"));
    expect(c).toMatchObject({ duplicate: false });

    const eventId = (a as { eventId: string }).eventId;
    const down = fakeFhb({ "GET /order": () => json({ message: "down" }, 503) });
    await expect(
      processFhbCallback(s.account.id, eventId, { ...down.opts, maxRetries: 0 }),
    ).rejects.toThrow();
    expect((await systemDb().webhookEvent.findUniqueOrThrow({ where: { id: eventId } })).status).toBe(
      "FAILED",
    );
    await systemDb().webhookEvent.update({
      where: { id: eventId },
      data: { receivedAt: new Date(Date.now() - 600_000) },
    });
    expect((await staleFhbEvents()).map((e) => e.id)).toContain(eventId);
  });
});
