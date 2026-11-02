import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LiveMode } from "@/generated/prisma/client";
import examples from "@/integrations/fhb-v3/__fixtures__/openapi-examples.json";
import type { FetchLike } from "@/integrations/fhb-v3/client";
import type { Actor } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { accountDb, systemDb } from "@/server/db/client";
import { processOutbound } from "@/server/outbox/outbox";
import { checkOrder } from "@/server/checks";
import { transitionOrder } from "@/server/pipeline";
import { applyFhbOrderView } from "./apply";
import { authenticateFhbCallbackPath } from "./callback-token";
import { clientFailureCode } from "@/integrations/fhb-v3/adapter";
import { createFhbConnection } from "./connection";
import { createFhbStockReceipt, deleteFhbStockReceipt, resubmitFhbStockReceipt } from "./inbound";
import {
  cancelFhbOrder,
  FhbPreflightError,
  previewFhbOrderPayload,
  submitFhbOrder,
  updateFhbOrder,
} from "./orders";
import { queueFhbProduct } from "./products";
import { createFhbTransportResolver } from "./transport";

// Synthetic data only; FHB answers are built from the vendor's documentation examples.
const ex = examples as unknown as Record<string, Record<string, unknown>>;
const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeAll(() => {
  process.env.APP_URL = "https://crm.example.test";
});

type Route = (url: URL, body: unknown) => Response | Promise<Response>;

/** Fake FHB: login + handlers keyed "METHOD /path", consumed in order (last one repeats). */
function fakeFhb(routes: Record<string, Route[]>) {
  const calls: { key: string; url: URL; body: unknown }[] = [];
  const fetchImpl = vi.fn<FetchLike>(async (u, init = {}) => {
    const url = new URL(u);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/v3/login") return json({ token: "t", expiration: "2099-01-01T00:00:00+0000" });
    const key = `${init.method ?? "GET"} ${url.pathname.replace("/v3", "")}`;
    calls.push({ key, url, body });
    const list = routes[key];
    if (!list?.length) throw new Error(`unexpected ${key}`);
    const h = list.length > 1 ? list.shift()! : list[0]!;
    return h(url, body);
  });
  const resolve = createFhbTransportResolver({ fetchImpl, sleep: async () => {}, random: () => 0 });
  return { fetchImpl, calls, resolve, count: (key: string) => calls.filter((c) => c.key === key).length };
}

let seq = 0;
async function setup(mode: LiveMode = "LIVE") {
  const n = ++seq;
  const sys = systemDb();
  const account = await sys.account.create({ data: { name: `FHB write ${n}` } });
  const company = await sys.company.create({ data: { accountId: account.id, name: "Demo Co" } });
  const other = await sys.company.create({ data: { accountId: account.id, name: "Other Co" } });
  const owner: Actor = { userId: "u-owner", accountId: account.id, role: "OWNER" };
  const connection = await createFhbConnection(owner, {
    companyId: company.id,
    name: "FHB test",
    appId: "test-app",
    secret: "test-secret",
    skuPrefix: "R",
  });
  await sys.fulfillmentConnection.update({ where: { id: connection.id }, data: { liveMode: mode } });
  const store = await sys.store.create({
    data: {
      accountId: account.id,
      companyId: company.id,
      domain: `t${n}.myshopify.com`,
      code: "TST",
      name: "T",
      currency: "EUR",
      countries: ["SK"],
    },
  });
  await sys.countrySetting.create({ data: { accountId: account.id, country: "SK", currency: "EUR" } });
  const product = await sys.product.create({
    data: { accountId: account.id, sku: "SKU-1", name: "Sample Perfume 50ml" },
  });
  await sys.productEan.create({
    data: { accountId: account.id, productId: product.id, ean: "0000000000017" },
  });
  const vp = await sys.vendorProduct.create({
    data: {
      accountId: account.id,
      connectionId: connection.id,
      productId: product.id,
      vendorId: "RSKU-1",
      lastSyncAt: new Date(),
      raw: { id: "RSKU-1", type: "single" },
    },
  });
  await sys.stockLevel.create({
    data: {
      accountId: account.id,
      vendorProductId: vp.id,
      physical: 10,
      free: 8,
      sellable: 8,
      snapshotAt: new Date(),
      source: "POLL",
    },
  });
  const order = await sys.order.create({
    data: {
      accountId: account.id,
      companyId: company.id,
      source: "SHOPIFY",
      storeId: store.id,
      number: "#1001",
      email: "buyer@example.com",
      phone: "0900 000 000",
      customerName: "Test Buyer",
      shippingAddress: {
        name: "Test Buyer",
        address1: "Example street 1",
        city: "Testville",
        zip: "00000",
        countryCode: "SK",
      },
      countryCode: "SK",
      currency: "EUR",
      subtotal: "40.00",
      total: "45.00",
      paymentMethod: "COD",
      codAmount: "45.00",
      placedAt: new Date(),
      status: "APPROVED",
      lines: {
        create: [{ productId: product.id, sku: "SKU-1", title: "Sample", quantity: 2, unitPrice: "20.00" }],
      },
    },
  });
  return { account, company, other, owner, connection, store, product, vp, order };
}

const orderView = (over: Record<string, unknown> = {}) => ({ ...ex["POST /order 200 response"], ...over });

async function extraOrder(s: Awaited<ReturnType<typeof setup>>, number: string, quantity = 2) {
  return systemDb().order.create({
    data: {
      accountId: s.account.id,
      companyId: s.company.id,
      source: "SHOPIFY",
      storeId: s.store.id,
      number,
      email: "buyer@example.com",
      phone: "0900 000 000",
      customerName: "Test Buyer",
      shippingAddress: {
        name: "Test Buyer",
        address1: "Example street 1",
        city: "Testville",
        zip: "00000",
        countryCode: "SK",
      },
      countryCode: "SK",
      currency: "EUR",
      subtotal: "40.00",
      total: "45.00",
      paymentMethod: "COD",
      codAmount: "45.00",
      placedAt: new Date(),
      status: "APPROVED",
      lines: {
        create: [{ productId: s.product.id, sku: "SKU-1", title: "Sample", quantity, unitPrice: "20.00" }],
      },
    },
  });
}

const echo = (b: unknown) => {
  const body = b as { parcel_service?: string; delivery_point?: string; note?: string };
  return orderView({
    id: "TST-1001",
    status: "pending",
    parcel_service: body.parcel_service ?? null,
    delivery_point: body.delivery_point ?? null,
    note: body.note ?? null,
  });
};

/** Submits and sends the create, then marks the shipment `pending` at FHB (editable). */
async function pendingAtFhb(
  s: Awaited<ReturnType<typeof setup>>,
  extra: Partial<Parameters<typeof submitFhbOrder>[1]> = {},
) {
  const sub = await submitFhbOrder(s.owner, {
    orderId: s.order.id,
    connectionId: s.connection.id,
    acknowledgeWarnings: true,
    ...extra,
  });
  const fhb = fakeFhb({
    // FHB echoes what it holds (parcel service, point, note) — taken from the body it was sent.
    "POST /order": [(_u, b) => json(echo(b))],
    "PUT /order": [(_u, b) => json(echo(b))],
  });
  expect(await processOutbound(sub.request.id, fhb.resolve)).toBe("SENT");
  return { ...sub, fhb };
}

const bodyOf = async (id: string) =>
  (
    (await systemDb().outboundRequest.findUniqueOrThrow({ where: { id } })).payload as {
      body: Record<string, unknown>;
    }
  ).body;

describe("FHB order create through the outbox", () => {
  it("queues a validated payload: deterministic id, variable symbol sequence, local COD, validate:true, signed URLs", async () => {
    const s = await setup("LIVE");
    const res = await submitFhbOrder(s.owner, {
      orderId: s.order.id,
      connectionId: s.connection.id,
      acknowledgeWarnings: true,
    });
    expect(res.fulfillment.externalId).toBe("TST-1001");
    expect(res.fulfillment.variableSymbol).toBe("1");
    const conn = await systemDb().fulfillmentConnection.findUniqueOrThrow({ where: { id: s.connection.id } });
    expect(conn.variableSymbolNext).toBe(2n);

    const req = await systemDb().outboundRequest.findUniqueOrThrow({ where: { id: res.request.id } });
    expect(req.operation).toBe("fhb.order.create");
    expect(req.idempotencyKey).toBe("fhb.order.create:TST-1001");
    const body = (req.payload as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({
      id: "TST-1001",
      variable_symbol: "1",
      validate: true,
      cod: 45,
      value: 45,
      items: [{ id: "RSKU-1", quantity: 2 }],
      recipient: { address: { country: "SK" }, contact: { phone: "+421900000000" } },
    });
    const urls = body.notification as Record<string, string>;
    expect(Object.keys(urls)).toHaveLength(7);
    for (const url of Object.values(urls)) {
      expect(url.length).toBeLessThanOrEqual(255);
      const segments = new URL(url).pathname.split("/").slice(4);
      expect(authenticateFhbCallbackPath(segments)).not.toBeNull();
    }

    // The worker sends it; FHB's answer is applied to the shipment.
    const fhb = fakeFhb({
      "POST /order": [() => json(orderView({ id: "TST-1001", variable_symbol: "1", status: "pending" }))],
    });
    expect(await processOutbound(req.id, fhb.resolve)).toBe("SENT");
    const f = await systemDb().fulfillment.findUniqueOrThrow({ where: { id: res.fulfillment.id } });
    expect(f).toMatchObject({ status: "ACCEPTED", rawStatus: "pending", vendorUid: "3c7ac0f0ab" });

    // A second submit of the same order is refused (no second request, no second symbol).
    await expect(
      submitFhbOrder(s.owner, {
        orderId: s.order.id,
        connectionId: s.connection.id,
        acknowledgeWarnings: true,
      }),
    ).rejects.toMatchObject({
      code: "fhb_already_submitted",
    });
    expect(await systemDb().outboundRequest.count({ where: { connectionId: s.connection.id } })).toBe(1);
  });

  it("payload preview (P4-04): the body submit would build, without notification tokens, nothing consumed", async () => {
    const s = await setup("LIVE");
    const body = await previewFhbOrderPayload(s.account.id, {
      orderId: s.order.id,
      connectionId: s.connection.id,
    });
    expect(body).toMatchObject({
      id: "TST-1001",
      variable_symbol: "1",
      validate: true,
      cod: 45,
      items: [{ id: "RSKU-1", quantity: 2 }],
      recipient: { address: { country: "SK" }, contact: { phone: "+421900000000" } },
    });
    expect(body).not.toHaveProperty("notification"); // callback URLs carry HMAC tokens
    const conn = await systemDb().fulfillmentConnection.findUniqueOrThrow({ where: { id: s.connection.id } });
    expect(conn.variableSymbolNext).toBe(1n);
    expect(await systemDb().fulfillment.count({ where: { orderId: s.order.id } })).toBe(0);
    expect(await systemDb().outboundRequest.count({ where: { connectionId: s.connection.id } })).toBe(0);
    // A hard block: no body.
    await systemDb().order.update({
      where: { id: s.order.id },
      data: {
        shippingAddress: {
          name: "Test Buyer",
          address1: "Example street 1",
          city: "Testville",
          countryCode: "SK",
        },
      },
    });
    expect(
      await previewFhbOrderPayload(s.account.id, { orderId: s.order.id, connectionId: s.connection.id }),
    ).toBeNull();
  });

  it("duplicate-submit: a timed-out create that FHB did receive is recovered by read-back, never re-sent", async () => {
    const s = await setup("LIVE");
    const { request } = await submitFhbOrder(s.owner, {
      orderId: s.order.id,
      connectionId: s.connection.id,
      acknowledgeWarnings: true,
    });
    const fhb = fakeFhb({
      "POST /order": [
        () => {
          throw new Error("The operation was aborted due to timeout");
        },
      ],
      "GET /order": [
        (url) =>
          json(orderView({ id: url.searchParams.get("id"), variable_symbol: "1", status: "imported" })),
      ],
    });
    expect(await processOutbound(request.id, fhb.resolve)).toBe("SENT");
    expect(fhb.count("POST /order")).toBe(1);
    expect(fhb.calls.find((c) => c.key === "GET /order")?.url.searchParams.get("id")).toBe("TST-1001");
    const f = await systemDb().fulfillment.findFirstOrThrow({ where: { connectionId: s.connection.id } });
    expect(f).toMatchObject({ status: "ACCEPTED", rawStatus: "imported" });
    // Re-processing the same request does nothing.
    expect(await processOutbound(request.id, fhb.resolve)).toBe("skipped");
    expect(fhb.count("POST /order")).toBe(1);
  });

  it("duplicate-submit: 5xx with the order absent at FHB is retried later with the same id", async () => {
    const s = await setup("LIVE");
    const { request } = await submitFhbOrder(s.owner, {
      orderId: s.order.id,
      connectionId: s.connection.id,
      acknowledgeWarnings: true,
    });
    const fhb = fakeFhb({
      "POST /order": [
        () => json({ message: "Bad gateway" }, 502),
        () => json(orderView({ id: "TST-1001", status: "pending" })),
      ],
      "GET /order": [() => json({ message: "Order not found" }, 404)],
    });
    expect(await processOutbound(request.id, fhb.resolve)).toBe("PENDING");
    const later = new Date(Date.now() + 2 * 3600_000);
    expect(await processOutbound(request.id, fhb.resolve, later)).toBe("SENT");
    const posts = fhb.calls.filter((c) => c.key === "POST /order");
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => (p.body as { id: string }).id)).toEqual(["TST-1001", "TST-1001"]);
  });

  it("duplicate-submit: read-back failing too makes it UNCERTAIN with an operator task", async () => {
    const s = await setup("LIVE");
    const { request } = await submitFhbOrder(s.owner, {
      orderId: s.order.id,
      connectionId: s.connection.id,
      acknowledgeWarnings: true,
    });
    const fhb = fakeFhb({
      "POST /order": [() => json({}, 503)],
      "GET /order": [() => json({ message: "down" }, 503)],
    });
    expect(await processOutbound(request.id, fhb.resolve)).toBe("UNCERTAIN");
    const task = await systemDb().alert.findFirst({
      where: { accountId: s.account.id, kind: "outbox_uncertain" },
    });
    expect(task?.isTask).toBe(true);
    expect(await processOutbound(request.id, fhb.resolve, new Date(Date.now() + 86400_000))).toBe("skipped");
    expect(fhb.count("POST /order")).toBe(1);
  });

  it("a login failure is a definite refusal (nothing sent), not an UNCERTAIN task", async () => {
    const s = await setup("LIVE");
    const { request } = await submitFhbOrder(s.owner, {
      orderId: s.order.id,
      connectionId: s.connection.id,
      acknowledgeWarnings: true,
    });
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new Error("ECONNREFUSED");
    });
    const resolve = createFhbTransportResolver({ fetchImpl, sleep: async () => {} });
    expect(await processOutbound(request.id, resolve)).toBe("FAILED");
    expect(
      await systemDb().alert.count({ where: { accountId: s.account.id, kind: "outbox_uncertain" } }),
    ).toBe(0);
    // only the login was attempted
    expect(fetchImpl.mock.calls.every(([u]) => String(u).endsWith("/login"))).toBe(true);
  });

  it("a vendor 400 fails the shipment visibly and allows a corrected re-submit with the same id and symbol", async () => {
    const s = await setup("LIVE");
    const first = await submitFhbOrder(s.owner, {
      orderId: s.order.id,
      connectionId: s.connection.id,
      acknowledgeWarnings: true,
    });
    const fhb = fakeFhb({
      "POST /order": [
        () =>
          json(
            {
              message: "Invalid request",
              violations: { "recipient.address.zip": [{ code: "IS_BLANK_ERROR", message: "x" }] },
            },
            400,
          ),
      ],
    });
    expect(await processOutbound(first.request.id, fhb.resolve)).toBe("FAILED");
    const f = await systemDb().fulfillment.findUniqueOrThrow({ where: { id: first.fulfillment.id } });
    expect(f.status).toBe("SUBMIT_FAILED");
    expect(
      await systemDb().alert.count({ where: { accountId: s.account.id, kind: "fhb_rejected_request" } }),
    ).toBe(1);

    const again = await submitFhbOrder(s.owner, {
      orderId: s.order.id,
      connectionId: s.connection.id,
      acknowledgeWarnings: true,
    });
    expect(again.fulfillment.id).toBe(first.fulfillment.id);
    expect(again.request.id).toBe(first.request.id);
    expect(again.request.status).toBe("PENDING");
    expect(again.fulfillment.variableSymbol).toBe("1");
  });

  it("READ_ONLY refuses and DRY_RUN only records — nothing reaches FHB", async () => {
    const ro = await setup("READ_ONLY");
    const a = await submitFhbOrder(ro.owner, {
      orderId: ro.order.id,
      connectionId: ro.connection.id,
      acknowledgeWarnings: true,
    });
    const fhb = fakeFhb({});
    expect(await processOutbound(a.request.id, fhb.resolve)).toBe("REFUSED");
    const dry = await setup("DRY_RUN");
    const b = await submitFhbOrder(dry.owner, {
      orderId: dry.order.id,
      connectionId: dry.connection.id,
      acknowledgeWarnings: true,
    });
    expect(await processOutbound(b.request.id, fhb.resolve)).toBe("DRY_RUN_RECORDED");
    expect(fhb.fetchImpl).not.toHaveBeenCalled();
  });

  it("pre-flight hard blocks abort everything: no shipment, no symbol, no request", async () => {
    const s = await setup("LIVE");
    await systemDb().vendorProduct.update({ where: { id: s.vp.id }, data: { productId: null } });
    const err = await submitFhbOrder(s.owner, {
      orderId: s.order.id,
      connectionId: s.connection.id,
      acknowledgeWarnings: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FhbPreflightError);
    expect((err as FhbPreflightError).findings.map((f) => f.code)).toContain("fhb.line.unmapped");
    expect(await systemDb().fulfillment.count({ where: { connectionId: s.connection.id } })).toBe(0);
    const conn = await systemDb().fulfillmentConnection.findUniqueOrThrow({ where: { id: s.connection.id } });
    expect(conn.variableSymbolNext).toBe(1n);
  });

  it("soft warnings need an explicit acknowledgement", async () => {
    const s = await setup("LIVE");
    const err = await submitFhbOrder(s.owner, { orderId: s.order.id, connectionId: s.connection.id }).catch(
      (e: unknown) => e,
    );
    expect((err as FhbPreflightError).code).toBe("fhb_preflight_needs_ack");
    expect((err as FhbPreflightError).findings.map((f) => f.code)).toEqual(["fhb.contact.phone_normalised"]);
  });

  it("COD in another currency is blocked unless a local-currency amount is stored", async () => {
    const s = await setup("LIVE");
    await systemDb().order.update({ where: { id: s.order.id }, data: { currency: "CZK" } });
    const err = await submitFhbOrder(s.owner, {
      orderId: s.order.id,
      connectionId: s.connection.id,
      acknowledgeWarnings: true,
    }).catch((e: unknown) => e);
    expect((err as FhbPreflightError).findings.map((f) => f.code)).toContain("fhb.cod.not_convertible");
    await systemDb().order.update({
      where: { id: s.order.id },
      data: { codLocalAmount: "1.80", codLocalCurrency: "EUR", codRate: "0.04" },
    });
    const ok = await submitFhbOrder(s.owner, {
      orderId: s.order.id,
      connectionId: s.connection.id,
      acknowledgeWarnings: true,
    });
    const req = await systemDb().outboundRequest.findUniqueOrThrow({ where: { id: ok.request.id } });
    expect((req.payload as { body: { cod: number; value: number } }).body).toMatchObject({
      cod: 1.8,
      value: 1.8,
    });
  });

  it("permissions and company scope", async () => {
    const s = await setup("LIVE");
    await expect(
      submitFhbOrder({ ...s.owner, role: "VIEWER" }, { orderId: s.order.id, connectionId: s.connection.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      submitFhbOrder(
        { ...s.owner, role: "OPERATOR", companyScope: [s.other.id] },
        { orderId: s.order.id, connectionId: s.connection.id },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("FHB order update / cancel only while pending", () => {
  it("cancel is refused unless the raw status is pending, then deletes and marks the shipment cancelled", async () => {
    const s = await setup("LIVE");
    const { fulfillment, request } = await submitFhbOrder(s.owner, {
      orderId: s.order.id,
      connectionId: s.connection.id,
      acknowledgeWarnings: true,
    });
    const fhb = fakeFhb({
      "POST /order": [() => json(orderView({ id: "TST-1001", status: "imported" }))],
      "DELETE /order": [() => new Response(null, { status: 204 })],
    });
    await processOutbound(request.id, fhb.resolve);
    await expect(cancelFhbOrder(s.owner, fulfillment.id)).rejects.toMatchObject({ code: "fhb_order_locked" });
    await expect(
      updateFhbOrder(s.owner, fulfillment.id, { acknowledgeWarnings: true }),
    ).rejects.toMatchObject({ code: "fhb_order_locked" });

    await applyFhbOrderView(
      s.account.id,
      s.connection.id,
      (await import("@/integrations/fhb-v3/schemas")).FhbOrderView.parse(
        orderView({ id: "TST-1001", status: "pending" }),
      ),
      "test",
    );
    await expect(cancelFhbOrder({ ...s.owner, role: "VIEWER" }, fulfillment.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const del = await cancelFhbOrder(s.owner, fulfillment.id);
    expect(await processOutbound(del.request.id, fhb.resolve)).toBe("SENT");
    expect(fhb.calls.find((c) => c.key === "DELETE /order")?.url.searchParams.get("id")).toBe("TST-1001");
    const f = await systemDb().fulfillment.findUniqueOrThrow({ where: { id: fulfillment.id } });
    expect(f.status).toBe("CANCELLED");
  });

  it("update sends PUT /order without id/validate and treats a 400 NOT_UPDATABLE as refused", async () => {
    const s = await setup("LIVE");
    const { fulfillment, request } = await submitFhbOrder(s.owner, {
      orderId: s.order.id,
      connectionId: s.connection.id,
      acknowledgeWarnings: true,
    });
    const fhb = fakeFhb({
      "POST /order": [() => json(orderView({ id: "TST-1001", status: "pending" }))],
      "PUT /order": [() => json(ex["DELETE /order 400 response"], 400)],
    });
    await processOutbound(request.id, fhb.resolve);
    const upd = await updateFhbOrder(s.owner, fulfillment.id, { acknowledgeWarnings: true });
    const req = await systemDb().outboundRequest.findUniqueOrThrow({ where: { id: upd.request.id } });
    expect(req.idempotencyKey).toBe("fhb.order.update:TST-1001:r1");
    const body = (req.payload as { body: Record<string, unknown> }).body;
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("validate");
    expect(await processOutbound(upd.request.id, fhb.resolve)).toBe("FAILED");
    const after = await systemDb().outboundRequest.findUniqueOrThrow({ where: { id: upd.request.id } });
    expect(after.lastError).toContain("NOT_UPDATABLE_ORDER_ERROR");
  });
});

describe("FHB order update keeps what the order was created with (audit fixes)", () => {
  it("an update without carrier/point/note re-sends the stored parcel service, pick-up point and note", async () => {
    const s = await setup("LIVE");
    const { fulfillment, fhb } = await pendingAtFhb(s, {
      parcelService: "test_pudo_carrier",
      pickupPoint: true,
      deliveryPoint: "12345",
      note: "Fragile — handle with care",
    });
    const upd = await updateFhbOrder(s.owner, fulfillment.id, { acknowledgeWarnings: true });
    expect(await bodyOf(upd.request.id)).toMatchObject({
      parcel_service: "test_pudo_carrier",
      delivery_point: "12345",
      note: "Fragile — handle with care",
    });
    expect(await processOutbound(upd.request.id, fhb.resolve)).toBe("SENT");
    expect(fhb.calls.find((c) => c.key === "PUT /order")?.body).toMatchObject({
      parcel_service: "test_pudo_carrier",
      delivery_point: "12345",
    });
    // An explicit change still wins, and clearing the point needs a new one when the carrier is PUDO.
    const changed = await updateFhbOrder(s.owner, fulfillment.id, {
      acknowledgeWarnings: true,
      note: null,
      deliveryPoint: "67890",
    });
    const b = await bodyOf(changed.request.id);
    expect(b).toMatchObject({ parcel_service: "test_pudo_carrier", delivery_point: "67890" });
    expect(b).not.toHaveProperty("note");
    await expect(
      updateFhbOrder(s.owner, fulfillment.id, { acknowledgeWarnings: true, deliveryPoint: null }),
    ).rejects.toMatchObject({ code: "fhb_preflight_failed" });
  });

  it("an update credits back the order's own reservation (free_quantity 0 after create)", async () => {
    const s = await setup("LIVE");
    await systemDb().stockLevel.update({
      where: { vendorProductId: s.vp.id },
      data: { free: 2, snapshotAt: new Date() },
    });
    const { fulfillment } = await pendingAtFhb(s);
    // FHB has reserved the 2 pieces: a fresh snapshot shows nothing free.
    await systemDb().stockLevel.update({
      where: { vendorProductId: s.vp.id },
      data: { free: 0, snapshotAt: new Date(Date.now() + 1000) },
    });
    const upd = await updateFhbOrder(s.owner, fulfillment.id, { acknowledgeWarnings: true });
    expect(upd.created).toBe(true);
    // More than the reservation covers is still blocked.
    await systemDb().orderLine.updateMany({ where: { orderId: s.order.id }, data: { quantity: 3 } });
    const err = await updateFhbOrder(s.owner, fulfillment.id, { acknowledgeWarnings: true }).catch(
      (e: unknown) => e,
    );
    expect((err as FhbPreflightError).findings.map((f) => f.code)).toContain("fhb.stock.insufficient");
  });

  it("A→B→A sends three updates (no silent divergence); the same change twice is one request", async () => {
    const s = await setup("LIVE");
    const { fulfillment, fhb } = await pendingAtFhb(s, { note: "A" });
    const b = await updateFhbOrder(s.owner, fulfillment.id, { acknowledgeWarnings: true, note: "B" });
    const bAgain = await updateFhbOrder(s.owner, fulfillment.id, { acknowledgeWarnings: true, note: "B" });
    expect(bAgain.request.id).toBe(b.request.id);
    expect(await processOutbound(b.request.id, fhb.resolve)).toBe("SENT");
    const a = await updateFhbOrder(s.owner, fulfillment.id, { acknowledgeWarnings: true, note: "A" });
    expect(a.created).toBe(true);
    expect(a.request.id).not.toBe(b.request.id);
    expect(await processOutbound(a.request.id, fhb.resolve)).toBe("SENT");
    const puts = fhb.calls
      .filter((c) => c.key === "PUT /order")
      .map((c) => (c.body as { note?: string }).note);
    expect(puts).toEqual(["B", "A"]);
  });

  it("concurrent submits on one connection all succeed with distinct variable symbols", async () => {
    const s = await setup("LIVE");
    const orders = [s.order, ...(await Promise.all([2, 3, 4, 5].map((n) => extraOrder(s, `#100${n}`))))];
    const results = await Promise.all(
      orders.map((o) =>
        submitFhbOrder(s.owner, { orderId: o.id, connectionId: s.connection.id, acknowledgeWarnings: true }),
      ),
    );
    const symbols = results.map((r) => r.fulfillment.variableSymbol);
    expect(new Set(symbols).size).toBe(orders.length);
    expect([...symbols].sort()).toEqual(["1", "2", "3", "4", "5"]);
    const conn = await systemDb().fulfillmentConnection.findUniqueOrThrow({ where: { id: s.connection.id } });
    expect(conn.variableSymbolNext).toBe(6n);
  });
});

describe("FHB submit is gated by the order pipeline (audit fixes)", () => {
  const counts = async (s: Awaited<ReturnType<typeof setup>>, orderId: string) => ({
    fulfillments: await systemDb().fulfillment.count({ where: { orderId } }),
    requests: await systemDb().outboundRequest.count({
      where: { connectionId: s.connection.id, operation: "fhb.order.create", fulfillment: { orderId } },
    }),
  });

  it("an order that is not APPROVED / SUBMIT_FAILED is refused with no shipment, no request, no symbol", async () => {
    const s = await setup("LIVE");
    const statuses = [
      "CANCELLED",
      "ON_HOLD",
      "NEEDS_REVIEW",
      "CHECKING",
      "READY",
      "IMPORTED",
      "SHIPPED",
      "FULFILLED_EXTERNALLY",
    ] as const;
    for (const [i, status] of statuses.entries()) {
      const o = await extraOrder(s, `#20${i}`);
      await systemDb().order.update({ where: { id: o.id }, data: { status } });
      await expect(
        submitFhbOrder(s.owner, { orderId: o.id, connectionId: s.connection.id, acknowledgeWarnings: true }),
        status,
      ).rejects.toMatchObject({ code: "transition_not_allowed" });
      expect(await counts(s, o.id), status).toEqual({ fulfillments: 0, requests: 0 });
      expect((await systemDb().order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe(status);
    }
    const conn = await systemDb().fulfillmentConnection.findUniqueOrThrow({ where: { id: s.connection.id } });
    expect(conn.variableSymbolNext).toBe(1n);
  });

  it("a queued order cannot get a second shipment from another warehouse", async () => {
    const s = await setup("LIVE");
    await submitFhbOrder(s.owner, {
      orderId: s.order.id,
      connectionId: s.connection.id,
      acknowledgeWarnings: true,
    });
    const second = await createFhbConnection(s.owner, {
      companyId: s.company.id,
      name: "FHB second",
      appId: "test-app-2",
      secret: "test-secret-2",
      skuPrefix: "R",
    });
    await expect(
      submitFhbOrder(s.owner, { orderId: s.order.id, connectionId: second.id, acknowledgeWarnings: true }),
    ).rejects.toMatchObject({ code: "transition_not_allowed" });
    expect(await systemDb().fulfillment.count({ where: { orderId: s.order.id } })).toBe(1);
  });

  it("cancel and submit at the same moment: exactly one wins, never a shipment for a cancelled order", async () => {
    const s = await setup("LIVE");
    const orders = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => extraOrder(s, `#30${n}`)));
    await Promise.all(
      orders.map((o) =>
        Promise.allSettled([
          transitionOrder(s.account.id, {
            orderId: o.id,
            to: "CANCELLED",
            cause: "cancel",
            actor: { kind: "user", userId: s.owner.userId },
          }),
          submitFhbOrder(s.owner, {
            orderId: o.id,
            connectionId: s.connection.id,
            acknowledgeWarnings: true,
          }),
        ]),
      ),
    );
    for (const o of orders) {
      const { status } = await systemDb().order.findUniqueOrThrow({ where: { id: o.id } });
      const c = await counts(s, o.id);
      if (status === "CANCELLED") expect(c).toEqual({ fulfillments: 0, requests: 0 });
      else {
        expect(status).toBe("QUEUED");
        expect(c).toEqual({ fulfillments: 1, requests: 1 });
      }
    }
  });

  it("a re-check racing a submit never leaves a queued order looking ready (no second shipment)", async () => {
    const s = await setup("LIVE");
    // Approved order: a re-check does not move it (reopen first), so the submit always goes through.
    const [check, sub] = await Promise.allSettled([
      checkOrder(s.account.id, s.order.id, { actor: { kind: "system" } }),
      submitFhbOrder(s.owner, {
        orderId: s.order.id,
        connectionId: s.connection.id,
        acknowledgeWarnings: true,
      }),
    ]);
    expect(check.status).toBe("fulfilled");
    expect(sub.status).toBe("fulfilled");
    expect((await systemDb().order.findUniqueOrThrow({ where: { id: s.order.id } })).status).toBe("QUEUED");

    // A refused order being re-checked (CHECKING) cannot be submitted until the check result is in.
    const o = await extraOrder(s, "#401");
    await systemDb().order.update({ where: { id: o.id }, data: { status: "SUBMIT_FAILED" } });
    const [check2, sub2] = await Promise.allSettled([
      checkOrder(s.account.id, o.id, { actor: { kind: "system" } }),
      submitFhbOrder(s.owner, { orderId: o.id, connectionId: s.connection.id, acknowledgeWarnings: true }),
    ]);
    expect(check2.status).toBe("fulfilled");
    const after = (await systemDb().order.findUniqueOrThrow({ where: { id: o.id } })).status;
    const c = await counts(s, o.id);
    if (sub2.status === "fulfilled") {
      // The submit won the order lock: the check saw QUEUED and left it alone.
      expect(after).toBe("QUEUED");
      expect(c).toEqual({ fulfillments: 1, requests: 1 });
    } else {
      expect(after === "READY" || after === "NEEDS_REVIEW").toBe(true);
      expect(c).toEqual({ fulfillments: 0, requests: 0 });
    }
  });
});

describe("FHB credentials never leak into hints or errors", () => {
  it("the vault hint is derived from the app id, not the JSON blob that ends in the secret", async () => {
    const s = await setup("LIVE");
    const cred = await systemDb().credential.findFirstOrThrow({ where: { accountId: s.account.id } });
    expect(cred.hint).not.toContain("et");
    expect(cred.hint).not.toContain('"}');
    expect(cred.hint).toBe("app ••••-app");
  });

  it("a failure to build the client is stored as a fixed code, never the exception text", () => {
    let err: unknown;
    try {
      JSON.parse('{"appId":"x","secret":"top-secret-value"');
    } catch (e) {
      err = e;
    }
    expect(clientFailureCode(err)).toBe("credentials_unreadable");
    expect(clientFailureCode({ code: "no_credentials" })).toBe("no_credentials");
  });
});

describe("FHB products", () => {
  it("create sends the EAN and signed notify_url; update never sends the EAN unless a person typed one", async () => {
    const s = await setup("LIVE");
    const p2 = await systemDb().product.create({
      data: {
        accountId: s.account.id,
        sku: "SKU-2",
        name: "Second",
        hsCode: "330300",
        countryOfOrigin: "fr",
      },
    });
    await systemDb().productEan.create({
      data: { accountId: s.account.id, productId: p2.id, ean: "0000000000024" },
    });
    const created = await queueFhbProduct(s.owner, { connectionId: s.connection.id, productId: p2.id });
    expect(created.operation).toBe("fhb.product.create");
    const req = await systemDb().outboundRequest.findUniqueOrThrow({ where: { id: created.request.id } });
    const body = (req.payload as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({
      id: "RSKU-2",
      name: "Second",
      ean: "0000000000024",
      customs_information: { hs_code: "330300", country_of_origin: "FR" },
    });
    expect(String(body.notify_url)).toMatch(
      /^https:\/\/crm\.example\.test\/api\/webhooks\/fhb\/.+\/stock\/.{32}$/,
    );

    const fhb = fakeFhb({
      "POST /product": [
        (_u, b) =>
          json({
            ...ex["POST /product 200 response"],
            id: (b as { id: string }).id,
            ean: "0000000000031",
            stock_quantity: 4,
            free_quantity: 3,
          }),
      ],
    });
    expect(await processOutbound(req.id, fhb.resolve)).toBe("SENT");
    const vp = await systemDb().vendorProduct.findFirstOrThrow({
      where: { connectionId: s.connection.id, vendorId: "RSKU-2" },
      include: { stockLevel: true },
    });
    expect(vp.productId).toBe(p2.id);
    expect(vp.vendorEan).toBe("0000000000031"); // FHB's corrected EAN is mirrored, read-only
    expect(vp.stockLevel).toMatchObject({ physical: 4, free: 3, sellable: 3 });

    const upd = await queueFhbProduct(s.owner, { connectionId: s.connection.id, productId: p2.id });
    expect(upd.operation).toBe("fhb.product.update");
    const ureq = await systemDb().outboundRequest.findUniqueOrThrow({ where: { id: upd.request.id } });
    expect((ureq.payload as { body: Record<string, unknown> }).body).not.toHaveProperty("ean");
    // Same change twice = one request.
    const again = await queueFhbProduct(s.owner, { connectionId: s.connection.id, productId: p2.id });
    expect(again.request.id).toBe(upd.request.id);

    const human = await queueFhbProduct(s.owner, {
      connectionId: s.connection.id,
      productId: p2.id,
      explicitEan: "0000000000048",
    });
    const hreq = await systemDb().outboundRequest.findUniqueOrThrow({ where: { id: human.request.id } });
    expect((hreq.payload as { body: Record<string, unknown> }).body).toMatchObject({ ean: "0000000000048" });
  });

  it("multi-products need existing single components at FHB", async () => {
    const s = await setup("LIVE");
    const set = await systemDb().product.create({
      data: { accountId: s.account.id, sku: "SET-1", name: "Gift set" },
    });
    const missing = await systemDb().product.create({
      data: { accountId: s.account.id, sku: "SKU-X", name: "Not at FHB" },
    });
    const bad = await queueFhbProduct(s.owner, {
      connectionId: s.connection.id,
      productId: set.id,
      components: [{ productId: missing.id, quantity: 1 }],
    }).catch((e: unknown) => e);
    expect((bad as FhbPreflightError).findings.map((f) => f.code)).toContain(
      "fhb.product.multi_component_missing",
    );

    const ok = await queueFhbProduct(s.owner, {
      connectionId: s.connection.id,
      productId: set.id,
      components: [{ productId: s.product.id, quantity: 2 }],
    });
    const req = await systemDb().outboundRequest.findUniqueOrThrow({ where: { id: ok.request.id } });
    expect((req.payload as { body: Record<string, unknown> }).body).toMatchObject({
      id: "RSET-1",
      type: "multi",
      items: [{ id: "RSKU-1", quantity: 2 }],
    });
    expect((req.payload as { body: Record<string, unknown> }).body).not.toHaveProperty("ean");
  });

  it("only owners/admins write products", async () => {
    const s = await setup("LIVE");
    await expect(
      queueFhbProduct(
        { ...s.owner, role: "OPERATOR" },
        { connectionId: s.connection.id, productId: s.product.id },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("FHB stock receipts", () => {
  it("creates with a stored deterministic id, reads back after a timeout, deletes only in `created`", async () => {
    const s = await setup("LIVE");
    const { inbound, request } = await createFhbStockReceipt(s.owner, {
      connectionId: s.connection.id,
      name: "Inbound 1",
      requestToken: "form-token-0001",
      lines: [{ productId: s.product.id, quantity: 10 }],
      expectedDate: "2026-11-10",
    });
    expect(inbound.externalRef).toMatch(/^IN-[0-9A-F]{16}$/);
    await expect(deleteFhbStockReceipt(s.owner, inbound.id)).rejects.toMatchObject({
      code: "fhb_receipt_locked",
    });
    const view = {
      ...ex["POST /stock-receipt 200 response"],
      id: inbound.externalRef,
      items: [{ id: "RSKU-1", quantity: 10, received: 0 }],
    };
    const fhb = fakeFhb({
      "POST /stock-receipt": [
        () => {
          throw new Error("socket hang up");
        },
      ],
      "GET /stock-receipt": [() => json(view), () => json({ message: "Stock receipt not found" }, 404)],
      "DELETE /stock-receipt": [() => new Response(null, { status: 204 })],
    });
    expect(await processOutbound(request.id, fhb.resolve)).toBe("SENT");
    expect(fhb.count("POST /stock-receipt")).toBe(1);
    const after = await systemDb().inboundShipment.findUniqueOrThrow({
      where: { id: inbound.id },
      include: { lines: true },
    });
    expect(after.status).toBe("created");
    expect(after.lines[0]?.receivedQty).toBe(0);

    const del = await deleteFhbStockReceipt(s.owner, inbound.id);
    expect(await processOutbound(del.request.id, fhb.resolve)).toBe("SENT");
    expect((await systemDb().inboundShipment.findUniqueOrThrow({ where: { id: inbound.id } })).status).toBe(
      "deleted",
    );
  });

  it("the same request token twice is one receipt and one request; a refused receipt is re-submitted with the same id", async () => {
    const s = await setup("LIVE");
    const input = {
      connectionId: s.connection.id,
      name: "Inbound 2",
      requestToken: "form-token-0003",
      lines: [{ productId: s.product.id, quantity: 5 }],
    };
    const [one, two] = await Promise.all([
      createFhbStockReceipt(s.owner, input),
      createFhbStockReceipt(s.owner, input),
    ]);
    expect(two.inbound.id).toBe(one.inbound.id);
    expect(two.request.id).toBe(one.request.id);
    expect([one.created, two.created].sort()).toEqual([false, true]);
    expect(await accountDb(s.account.id).inboundShipment.count()).toBe(1);
    expect(await systemDb().outboundRequest.count({ where: { connectionId: s.connection.id } })).toBe(1);

    const fhb = fakeFhb({
      "POST /stock-receipt": [
        () => json(ex["POST /stock-receipt 400 response"], 400),
        () =>
          json({
            ...ex["POST /stock-receipt 200 response"],
            id: one.inbound.externalRef,
            items: [{ id: "RSKU-1", quantity: 6, received: 0 }],
          }),
      ],
    });
    expect(await processOutbound(one.request.id, fhb.resolve)).toBe("FAILED");
    expect(
      (await systemDb().inboundShipment.findUniqueOrThrow({ where: { id: one.inbound.id } })).status,
    ).toBe("SUBMIT_FAILED");
    const again = await resubmitFhbStockReceipt(s.owner, one.inbound.id, {
      name: "Inbound 2",
      lines: [{ productId: s.product.id, quantity: 6 }],
    });
    expect(again.request.id).toBe(one.request.id);
    expect(again.request.status).toBe("PENDING");
    expect(await processOutbound(again.request.id, fhb.resolve)).toBe("SENT");
    const posts = fhb.calls
      .filter((c) => c.key === "POST /stock-receipt")
      .map((c) => (c.body as { id: string }).id);
    expect(posts).toEqual([one.inbound.externalRef, one.inbound.externalRef]);
    // Once FHB holds it, re-submitting is refused (no second receipt).
    await expect(
      resubmitFhbStockReceipt(s.owner, one.inbound.id, {
        name: "x",
        lines: [{ productId: s.product.id, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: "fhb_already_submitted" });
  });

  it("refuses unmapped products before anything is stored", async () => {
    const s = await setup("LIVE");
    const lone = await systemDb().product.create({
      data: { accountId: s.account.id, sku: "SKU-9", name: "Lone" },
    });
    const err = await createFhbStockReceipt(s.owner, {
      connectionId: s.connection.id,
      name: "x",
      requestToken: "form-token-0002",
      lines: [{ productId: lone.id, quantity: 1 }],
    }).catch((e: unknown) => e);
    expect((err as FhbPreflightError).findings.map((f) => f.code)).toContain("fhb.receipt.unmapped");
    expect(await accountDb(s.account.id).inboundShipment.count()).toBe(0);
  });
});

describe("status apply", () => {
  it("the order follows its FHB shipment through the pipeline: QUEUED on submit, forward only after", async () => {
    const s = await setup("LIVE");
    const { request } = await submitFhbOrder(s.owner, {
      orderId: s.order.id,
      connectionId: s.connection.id,
      acknowledgeWarnings: true,
    });
    const status = async () =>
      (await systemDb().order.findUniqueOrThrow({ where: { id: s.order.id } })).status;
    expect(await status()).toBe("QUEUED");
    await processOutbound(
      request.id,
      fakeFhb({ "POST /order": [() => json(orderView({ id: "TST-1001", status: "pending" }))] }).resolve,
    );
    const { FhbOrderView } = await import("@/integrations/fhb-v3/schemas");
    const apply = (st: string) =>
      applyFhbOrderView(
        s.account.id,
        s.connection.id,
        FhbOrderView.parse(orderView({ id: "TST-1001", status: st })),
        "test",
      );
    expect(await status()).toBe("ACCEPTED");
    await apply("sent");
    const shipped = await status();
    expect(shipped).toBe("SHIPPED");
    await apply("pending"); // late, older status: the order never moves back
    expect(await status()).toBe(shipped);
    const events = await systemDb().orderEvent.findMany({
      where: { orderId: s.order.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => [e.fromStatus, e.toStatus, e.cause])).toEqual([
      ["APPROVED", "QUEUED", "queue"],
      ["QUEUED", "ACCEPTED", "vendor"],
      ["ACCEPTED", shipped, "vendor"],
    ]);
  });

  it("unknown status → UNKNOWN + one alert, raw kept; rejected → BLOCKED + task", async () => {
    const s = await setup("LIVE");
    const { request, fulfillment } = await submitFhbOrder(s.owner, {
      orderId: s.order.id,
      connectionId: s.connection.id,
      acknowledgeWarnings: true,
    });
    await processOutbound(
      request.id,
      fakeFhb({ "POST /order": [() => json(orderView({ id: "TST-1001", status: "pending" }))] }).resolve,
    );
    const { FhbOrderView } = await import("@/integrations/fhb-v3/schemas");
    for (let i = 0; i < 2; i++)
      await applyFhbOrderView(
        s.account.id,
        s.connection.id,
        FhbOrderView.parse(orderView({ id: "TST-1001", status: "on_the_moon" })),
        "test",
      );
    const f = await systemDb().fulfillment.findUniqueOrThrow({ where: { id: fulfillment.id } });
    expect(f).toMatchObject({ status: "UNKNOWN", rawStatus: "on_the_moon" });
    expect(
      await systemDb().alert.count({ where: { accountId: s.account.id, kind: "fhb_unknown_status" } }),
    ).toBe(1);
    await applyFhbOrderView(
      s.account.id,
      s.connection.id,
      FhbOrderView.parse(orderView({ id: "TST-1001", status: "rejected" })),
      "test",
    );
    expect((await systemDb().fulfillment.findUniqueOrThrow({ where: { id: fulfillment.id } })).status).toBe(
      "BLOCKED",
    );
    expect(
      await systemDb().alert.count({
        where: { accountId: s.account.id, kind: "fhb_order_rejected", isTask: true },
      }),
    ).toBe(1);
    const events = await systemDb().fulfillmentEvent.findMany({ where: { fulfillmentId: fulfillment.id } });
    expect(events.map((e) => e.rawStatus)).toEqual(
      expect.arrayContaining(["pending", "on_the_moon", "rejected"]),
    );
  });
});
