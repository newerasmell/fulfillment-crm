import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import examples from "@/integrations/fhb-joy/__fixtures__/openapi-examples.json";
import { checkOrder } from "@/server/checks";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import { queueEuOrder } from "@/server/eushipments/write";
import { fulfillOrder } from "@/server/fulfill/fulfill";
import { processOutbound } from "@/server/outbox/outbox";
import { transitionOrder, TransitionError } from "@/server/pipeline";
import { saveCredential } from "@/server/security/credentials";
import type { ScopedActor } from "@/server/stores";
import {
  createManualShipment,
  getManualShipment,
  labelForDownload,
  ManualPreflightError,
  previewManualShipment,
  requestBulkLabels,
  resendLabel,
  voidLabel,
  type ManualShipmentInput,
} from "./index";
import { ManualShipmentInput as ManualShipmentSchema } from "./manual";
import { replacementDraft, replacementLinks } from "./replacement";
import { searchManualProducts, stockPerWarehouse } from "./stock-view";
import { listOrders } from "@/server/orders";
import { withLabelTransports } from "./transport";
import { euCouriers, euOffices } from "./views";
import {
  applyJoyInfo,
  awbLabelsMissing,
  fetchMissingAwbLabel,
  MAX_LABEL_ATTEMPTS,
  runLabelPrintJob,
  trackLabels,
} from "./worker";
import { joyLiveCheck } from "./joy-live-check";

// Synthetic data only. Vendor calls are mocked fetches; nothing leaves the test.

const ex = examples as Record<string, unknown>;
const PDF = Buffer.from("%PDF-1.4 synthetic label").toString("base64");
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

type Route = (method: string, path: string, body: unknown) => Response | Promise<Response>;
function fetchMock(route: Route) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (u: string, init: RequestInit = {}) => {
    const url = new URL(u);
    const path = url.pathname.replace("/api/joy", "").replace("/api/v1", "");
    if (path === "/login") return json({ token: "t", expiration: "2099-01-01 00:00:00 +0100" });
    calls.push(`${init.method ?? "GET"} ${path}`);
    return route(init.method ?? "GET", path, init.body ? JSON.parse(String(init.body)) : undefined);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const DUP = "manual.duplicate_recipient";

describe("manual shipment input: HUF cash on delivery", () => {
  it("is rounded to the whole forint (owner decision 2026-11-11); other currencies unchanged", () => {
    const parse = (cod: number, currency: string) =>
      ManualShipmentSchema.parse({
        kind: "JOY_LABEL",
        companyId: "c",
        connectionId: "x",
        recipient: {
          name: "Test Buyer",
          phone: "+36000000000",
          address1: "Example 1",
          city: "Testville",
          zip: "1000",
          countryCode: "HU",
        },
        cod,
        currency,
      }).cod;
    expect(parse(32825.1, "HUF")).toBe(32825);
    expect(parse(32825.5, "huf")).toBe(32826);
    expect(parse(12.34, "EUR")).toBe(12.34);
  });
});

describe("manual shipments and labels (P7)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let joy: { id: string };
  let owner: ScopedActor;

  const joyInput = (over: Partial<ManualShipmentInput> = {}): ManualShipmentInput => ({
    kind: "JOY_LABEL",
    companyId: g.company.id,
    connectionId: joy.id,
    recipient: {
      name: "Test Recipient",
      email: "recipient@example.com",
      phone: "+420601000000",
      address1: "Testovacia 12",
      city: "Testov",
      zip: "75501",
      countryCode: "CZ",
    },
    cod: 250,
    currency: "CZK",
    parcels: 1,
    weights: [1.2],
    parcelService: "pplcz",
    // Most tests reuse one synthetic recipient on purpose: the duplicate warning is acknowledged here and
    // tested on its own below.
    acknowledgedCodes: [DUP],
    clientRequestId: randomUUID(),
    ...over,
  });
  const awbInput = (over: Partial<ManualShipmentInput> = {}): ManualShipmentInput => ({
    kind: "AWB",
    companyId: g.company.id,
    connectionId: g.connection.id,
    recipient: {
      name: "Test User",
      email: "test@example.com",
      phone: "0888123456",
      address1: "Test street 10",
      city: "Testograd",
      zip: "1000",
      countryCode: "BG",
    },
    cod: 20,
    currency: "EUR",
    parcels: 1,
    totalWeight: 1,
    courierId: 20,
    contents: "sample",
    acknowledgedCodes: [DUP],
    clientRequestId: randomUUID(),
    ...over,
  });
  const setMode = (id: string, liveMode: "READ_ONLY" | "DRY_RUN" | "CANARY" | "LIVE") =>
    g.db.fulfillmentConnection.update({ where: { id }, data: { liveMode } });

  beforeAll(async () => {
    g = await euTestGroup("labels");
    owner = g.owner;
    await g.db.countrySetting.createMany({
      data: [
        { accountId: g.accountId, country: "CZ", currency: "CZK" },
        { accountId: g.accountId, country: "BG", currency: "EUR" },
      ],
    });
    const cred = await saveCredential(g.db, g.accountId, {
      label: "joy",
      secret: JSON.stringify({ appId: "test-app", secret: "test-secret" }),
    });
    joy = await g.db.fulfillmentConnection.create({
      data: {
        accountId: g.accountId,
        companyId: g.company.id,
        type: "FHB_JOY",
        name: "Joy test",
        credentialId: cred.id,
        liveMode: "LIVE",
        vendorIds: { parcelServices: ["pplcz", "packeta"], pickupServices: ["packeta"] },
      },
    });
  });

  it("a Joy label walks the pipeline in one transaction: one order, one shipment, one outbox row", async () => {
    const r = await createManualShipment(owner, joyInput());
    expect(r.number).toMatch(/^M\d+$/);
    const order = await g.db.order.findUniqueOrThrow({ where: { id: r.orderId } });
    expect(order).toMatchObject({ source: "MANUAL", status: "QUEUED", paymentMethod: "COD" });
    const events = await g.db.orderEvent.findMany({
      where: { orderId: r.orderId },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.toStatus)).toEqual(["IMPORTED", "CHECKING", "READY", "APPROVED", "QUEUED"]);
    const f = await g.db.fulfillment.findUniqueOrThrow({ where: { id: r.fulfillmentId! } });
    expect(f).toMatchObject({ externalId: `M-${r.number}`, status: "QUEUED", carrier: "pplcz" });
    expect(f.variableSymbol).toMatch(/^\d+$/);
    const reqs = await g.db.outboundRequest.findMany({ where: { fulfillmentId: f.id } });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({
      operation: "joy.shipment.create",
      idempotencyKey: `joy.shipment.create:M-${r.number}`,
    });
    expect((reqs[0]!.payload as { body: { country: string } }).body.country).toBe("cz");
  });

  it("the same submission twice (double click) is ONE shipment", async () => {
    const clientRequestId = randomUUID();
    const [a, b] = await Promise.all([
      createManualShipment(owner, joyInput({ clientRequestId })),
      createManualShipment(owner, joyInput({ clientRequestId })),
    ]);
    expect(a.manualShipmentId).toBe(b.manualShipmentId);
    expect(await g.db.manualShipment.count({ where: { clientRequestId } })).toBe(1);
    const again = await createManualShipment(owner, joyInput({ clientRequestId }));
    expect(again.fulfillmentId).toBe(a.fulfillmentId);
  });

  it("hard findings write nothing; unseen warnings need an acknowledgement", async () => {
    const before = await g.db.order.count();
    const bad = await createManualShipment(
      owner,
      joyInput({ recipient: { ...joyInput().recipient, email: null } }),
    ).catch((e) => e);
    expect(bad).toBeInstanceOf(ManualPreflightError);
    expect((bad as ManualPreflightError).code).toBe("manual_preflight_failed");
    expect((bad as ManualPreflightError).findings.map((f) => f.code)).toContain("joy.email.missing");
    const noNumber = await createManualShipment(
      owner,
      joyInput({ recipient: { ...joyInput().recipient, address1: "Hlavna ulica" } }),
    ).catch((e) => e);
    expect((noNumber as ManualPreflightError).code).toBe("manual_preflight_needs_ack");
    expect(await g.db.order.count()).toBe(before);
    const ok = await createManualShipment(
      owner,
      joyInput({
        recipient: { ...joyInput().recipient, address1: "Hlavna ulica" },
        acknowledgedCodes: ["joy.street.no_number", DUP],
      }),
    );
    const evs = await g.db.orderEvent.findMany({
      where: { orderId: ok.orderId },
      orderBy: { createdAt: "asc" },
    });
    expect(evs.map((e) => e.toStatus)).toContain("NEEDS_REVIEW");
  });

  it("READ_ONLY refuses before anything is written; a viewer cannot create", async () => {
    await setMode(joy.id, "READ_ONLY");
    await expect(createManualShipment(owner, joyInput())).rejects.toMatchObject({
      code: "connection_read_only",
    });
    await setMode(joy.id, "LIVE");
    await expect(createManualShipment({ ...owner, role: "VIEWER" }, joyInput())).rejects.toThrow(
      /orders.fulfill/,
    );
  });

  it("LIVE: the sender creates the label once, stores the PDF, and the order follows", async () => {
    const r = await createManualShipment(owner, joyInput());
    const m = fetchMock((method, path) =>
      path === "/shipment"
        ? json({ status: "error", message: "Shipment not found." }, 404)
        : json({ ...(ex["POST /shipments 200"] as object), label: PDF }),
    );
    const resolve = withLabelTransports(() => undefined, { joy: { fetchImpl: m.fetchImpl } });
    const req = await g.db.outboundRequest.findFirstOrThrow({ where: { fulfillmentId: r.fulfillmentId! } });
    expect(await processOutbound(req.id, resolve)).toBe("SENT");
    expect(m.calls).toEqual(["GET /shipment", "POST /shipments"]);
    const f = await g.db.fulfillment.findUniqueOrThrow({ where: { id: r.fulfillmentId! } });
    expect(f.status).toBe("ACCEPTED");
    expect(f.trackingNumbers).toEqual(["40050000000"]);
    expect(f.labelFileKey).toBeTruthy();
    const label = await labelForDownload(owner, f.labelFileKey!);
    expect(Buffer.from(label.content).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await g.db.order.findUniqueOrThrow({ where: { id: r.orderId } })).status).toBe("ACCEPTED");
    // The stored response never carries the PDF.
    const sent = await g.db.outboundRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(JSON.stringify(sent.lastResponse)).not.toContain(PDF);
    // Sending again does nothing.
    expect(await processOutbound(req.id, resolve)).toBe("skipped");
    expect(m.calls.filter((c) => c === "POST /shipments")).toHaveLength(1);
  });

  it("a timeout on create is read back: found → SENT, never a second label", async () => {
    const r = await createManualShipment(owner, joyInput());
    let created: Record<string, unknown> | null = null;
    const m = fetchMock((method, path, body) => {
      if (path === "/shipment")
        return created ? json({ ...(ex["GET /shipment 200"] as object), ...created }) : json({}, 404);
      if (method === "POST") {
        const b = body as Record<string, unknown>;
        created = { name: b.name, zip: b.zip, variableSymbol: b.variableSymbol, cod: b.cod };
        throw new Error("The operation was aborted due to timeout");
      }
      return json({ ...(ex["GET /shipments 200"] as object), label: PDF });
    });
    const req = await g.db.outboundRequest.findFirstOrThrow({ where: { fulfillmentId: r.fulfillmentId! } });
    expect(
      await processOutbound(
        req.id,
        withLabelTransports(() => undefined, { joy: { fetchImpl: m.fetchImpl } }),
      ),
    ).toBe("SENT");
    expect(m.calls.filter((c) => c === "POST /shipments")).toHaveLength(1);
    expect((await g.db.fulfillment.findUniqueOrThrow({ where: { id: r.fulfillmentId! } })).status).toBe(
      "ACCEPTED",
    );
  });

  it("our Joy id held by another shipment: FAILED + one CRITICAL task, never ACCEPTED", async () => {
    const r = await createManualShipment(owner, joyInput());
    const m = fetchMock((method, path) =>
      path === "/shipment"
        ? json({ ...(ex["GET /shipment 200"] as object), name: "Someone Else", variableSymbol: "1" })
        : json({ ...(ex["POST /shipments 200"] as object), label: PDF }),
    );
    const req = await g.db.outboundRequest.findFirstOrThrow({ where: { fulfillmentId: r.fulfillmentId! } });
    expect(
      await processOutbound(
        req.id,
        withLabelTransports(() => undefined, { joy: { fetchImpl: m.fetchImpl } }),
      ),
    ).toBe("FAILED");
    expect(m.calls).toEqual(["GET /shipment"]);
    const f = await g.db.fulfillment.findUniqueOrThrow({ where: { id: r.fulfillmentId! } });
    expect(f.status).toBe("SUBMIT_FAILED");
    expect(f.labelFileKey).toBeNull();
    const alerts = await g.db.alert.findMany({ where: { kind: "labels_joy_id_conflict", entityId: f.id } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("CRITICAL");
  });

  it("DRY_RUN records the Joy label (no test mode exists), CANARY waits for a click", async () => {
    await setMode(joy.id, "DRY_RUN");
    const r = await createManualShipment(owner, joyInput());
    const m = fetchMock(() => json({}, 500));
    const resolve = withLabelTransports(() => undefined, { joy: { fetchImpl: m.fetchImpl } });
    const req = await g.db.outboundRequest.findFirstOrThrow({ where: { fulfillmentId: r.fulfillmentId! } });
    expect(await processOutbound(req.id, resolve)).toBe("DRY_RUN_RECORDED");
    expect(m.calls).toEqual([]);
    // Raised to CANARY: "send again" re-arms the same request, which then waits for a confirmation.
    await setMode(joy.id, "CANARY");
    const again = await resendLabel(owner, r.manualShipmentId);
    expect(again.request.id).toBe(req.id);
    expect(await processOutbound(req.id, resolve)).toBe("AWAITING_CONFIRMATION");
    expect(m.calls).toEqual([]);
    expect(await g.db.outboundRequest.count({ where: { fulfillmentId: r.fulfillmentId! } })).toBe(1);
    await setMode(joy.id, "LIVE");
  });

  it("a vendor refusal fails the shipment and the order; resend re-arms the same key", async () => {
    const r = await createManualShipment(owner, joyInput());
    const m = fetchMock((method, path) =>
      path === "/shipment"
        ? json({}, 404)
        : json({ status: "error", message: "Missing field: name", id: "name" }, 400),
    );
    const resolve = withLabelTransports(() => undefined, { joy: { fetchImpl: m.fetchImpl } });
    const req = await g.db.outboundRequest.findFirstOrThrow({ where: { fulfillmentId: r.fulfillmentId! } });
    expect(await processOutbound(req.id, resolve)).toBe("FAILED");
    expect((await g.db.order.findUniqueOrThrow({ where: { id: r.orderId } })).status).toBe("SUBMIT_FAILED");
    expect(
      await g.db.alert.count({ where: { kind: "labels_joy_rejected", entityId: r.fulfillmentId! } }),
    ).toBe(1);
    await resendLabel(owner, r.manualShipmentId);
    expect((await g.db.order.findUniqueOrThrow({ where: { id: r.orderId } })).status).toBe("QUEUED");
    expect(await g.db.outboundRequest.count({ where: { fulfillmentId: r.fulfillmentId! } })).toBe(1);
  });

  it("label-only orders never enter the generic check / approve / queue path", async () => {
    const r = await createManualShipment(owner, joyInput());
    await g.db.order.update({ where: { id: r.orderId }, data: { status: "SUBMIT_FAILED" } });
    const c = await checkOrder(g.accountId, r.orderId, { actor: { kind: "user", userId: owner.userId } });
    expect(c.moved).toBe(false);
    expect(c.status).toBe("SUBMIT_FAILED");
    await expect(
      transitionOrder(g.accountId, {
        orderId: r.orderId,
        to: "QUEUED",
        cause: "queue",
        actor: { kind: "user", userId: owner.userId },
      }),
    ).rejects.toBeInstanceOf(TransitionError);
  });

  it("Fulfill never routes a QUEUED label-only order (DRY_RUN recorded AWB) to a warehouse", async () => {
    await setMode(g.connection.id, "DRY_RUN");
    const r = await createManualShipment(owner, awbInput());
    const m = fetchMock(() => json({ awb: 1, barcode: "B", packagesBarcodes: [], id: 9 }));
    const req = await g.db.outboundRequest.findFirstOrThrow({ where: { fulfillmentId: r.fulfillmentId! } });
    expect(
      await processOutbound(
        req.id,
        withLabelTransports(() => undefined, { eu: { fetchImpl: m.fetchImpl } }),
      ),
    ).toBe("DRY_RUN_RECORDED");
    await setMode(g.connection.id, "LIVE");
    expect((await g.db.order.findUniqueOrThrow({ where: { id: r.orderId } })).status).toBe("QUEUED");
    const fBefore = await g.db.fulfillment.count({ where: { orderId: r.orderId } });
    const oBefore = await g.db.outboundRequest.count({ where: { fulfillment: { orderId: r.orderId } } });
    const res = await fulfillOrder(owner, r.orderId);
    expect(res).toMatchObject({ status: "BLOCKED", code: "label_only_order" });
    await expect(
      queueEuOrder(owner, { orderId: r.orderId, connectionId: g.connection.id }),
    ).rejects.toMatchObject({ code: "label_only_order" });
    expect(await g.db.fulfillment.count({ where: { orderId: r.orderId } })).toBe(fBefore);
    expect(await g.db.outboundRequest.count({ where: { fulfillment: { orderId: r.orderId } } })).toBe(
      oBefore,
    );
  });

  it("the same recipient twice (reload / second operator) needs an acknowledgement; no id is refused", async () => {
    const recipient = {
      ...joyInput().recipient,
      phone: "+420601999111",
      email: "dup@example.com",
      address1: "Duplicitni 7",
    };
    const first = await createManualShipment(owner, joyInput({ recipient, acknowledgedCodes: [] }));
    const before = await g.db.order.count();
    const second = await createManualShipment(owner, joyInput({ recipient, acknowledgedCodes: [] })).catch(
      (e) => e,
    );
    expect(second).toBeInstanceOf(ManualPreflightError);
    expect((second as ManualPreflightError).code).toBe("manual_preflight_needs_ack");
    const dup = (second as ManualPreflightError).findings.find((f) => f.code === DUP);
    expect(dup?.severity).toBe("soft");
    expect(dup?.message_en).toContain(first.number);
    expect(await g.db.order.count()).toBe(before);
    const p = await previewManualShipment(owner, joyInput({ recipient }));
    expect(p.findings.map((f) => f.code)).toContain(DUP);
    // Same address + zip + amount with another phone is caught too.
    const other = await createManualShipment(
      owner,
      joyInput({ recipient: { ...recipient, phone: "+420601999222", email: null }, acknowledgedCodes: [] }),
    ).catch((e) => e);
    expect((other as ManualPreflightError).findings?.map((f) => f.code)).toContain(DUP);
    await expect(
      createManualShipment(owner, joyInput({ recipient, clientRequestId: null })),
    ).rejects.toMatchObject({ code: "client_request_id_required" });
    // Acknowledged: created.
    expect((await createManualShipment(owner, joyInput({ recipient }))).number).not.toBe(first.number);
  });

  it("a label uses a connection of the order's company; WAREHOUSE elsewhere is a soft finding", async () => {
    const other = await g.db.company.create({
      data: { accountId: g.accountId, name: `Other ${Date.now()}` },
    });
    await expect(createManualShipment(owner, awbInput({ companyId: other.id }))).rejects.toMatchObject({
      code: "connection_other_company",
    });
    await expect(previewManualShipment(owner, joyInput({ companyId: other.id }))).rejects.toMatchObject({
      code: "connection_other_company",
    });
    const product = await g.db.product.create({
      data: { accountId: g.accountId, sku: `SKU-X-${Date.now()}`, name: "Sample" },
    });
    const input = awbInput({
      kind: "WAREHOUSE",
      companyId: other.id,
      acknowledgedCodes: [],
      lines: [{ productId: product.id, quantity: 1, unitPrice: 20 }],
    });
    const p = await previewManualShipment(owner, input);
    expect(p.findings.find((f) => f.code === "manual.connection_other_company")?.severity).toBe("soft");
    const before = await g.db.order.count();
    await expect(createManualShipment(owner, input)).rejects.toMatchObject({
      code: "manual_preflight_needs_ack",
    });
    expect(await g.db.order.count()).toBe(before);
    const ok = await createManualShipment(owner, {
      ...input,
      acknowledgedCodes: ["manual.connection_other_company"],
    });
    expect(ok.kind).toBe("WAREHOUSE");
  });

  it("void: Joy DELETE /shipments through the outbox, the shipment and order become CANCELLED", async () => {
    const r = await createManualShipment(owner, joyInput());
    const create = fetchMock((m, p) =>
      p === "/shipment" ? json({}, 404) : json({ ...(ex["POST /shipments 200"] as object), label: PDF }),
    );
    const req = await g.db.outboundRequest.findFirstOrThrow({ where: { fulfillmentId: r.fulfillmentId! } });
    await processOutbound(
      req.id,
      withLabelTransports(() => undefined, { joy: { fetchImpl: create.fetchImpl } }),
    );
    const v = await voidLabel(owner, r.manualShipmentId);
    await expect(voidLabel(owner, r.manualShipmentId)).rejects.toMatchObject({ code: "already_requested" });
    const del = fetchMock(() => new Response(null, { status: 204 }));
    expect(
      await processOutbound(
        v.request.id,
        withLabelTransports(() => undefined, { joy: { fetchImpl: del.fetchImpl } }),
      ),
    ).toBe("SENT");
    expect(del.calls).toEqual(["DELETE /shipments"]);
    expect((await g.db.fulfillment.findUniqueOrThrow({ where: { id: r.fulfillmentId! } })).status).toBe(
      "CANCELLED",
    );
    expect((await g.db.order.findUniqueOrThrow({ where: { id: r.orderId } })).status).toBe("CANCELLED");
  });

  it("Joy tracking: events once each, raw + mapped status, unknown values alert", async () => {
    const r = await createManualShipment(owner, joyInput());
    await g.db.fulfillment.update({ where: { id: r.fulfillmentId! }, data: { status: "ACCEPTED" } });
    await g.db.order.update({ where: { id: r.orderId }, data: { status: "ACCEPTED" } });
    const info = {
      id: "x",
      status: "sent",
      _embedded: {
        trackingNumber: ["T-1"],
        trackingLink: ["https://track.example/T-1"],
        trackingEvents: [{ date: "2026-11-02 10:00:00", message: "Package in transit" }],
      },
    };
    await applyJoyInfo(g.accountId, r.manualShipmentId, r.fulfillmentId!, info as never);
    await applyJoyInfo(g.accountId, r.manualShipmentId, r.fulfillmentId!, info as never);
    const f = await g.db.fulfillment.findUniqueOrThrow({ where: { id: r.fulfillmentId! } });
    expect(f).toMatchObject({
      status: "SHIPPED",
      rawStatus: "sent",
      trackingNumbers: ["T-1"],
      trackingUrls: ["https://track.example/T-1"],
    });
    expect(await g.db.fulfillmentEvent.count({ where: { fulfillmentId: f.id, source: "joy" } })).toBe(1);
    expect((await g.db.order.findUniqueOrThrow({ where: { id: r.orderId } })).status).toBe("SHIPPED");
    // A stale "pending" after "sent" never moves the shipment back; the raw value is stored.
    await applyJoyInfo(g.accountId, r.manualShipmentId, f.id, { id: "x", status: "pending" } as never);
    expect(await g.db.fulfillment.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
      status: "SHIPPED",
      rawStatus: "pending",
    });
    await applyJoyInfo(g.accountId, r.manualShipmentId, f.id, { id: "x", status: "brand_new" } as never);
    expect((await g.db.fulfillment.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("SHIPPED");
    expect(await g.db.alert.count({ where: { kind: "labels_joy_unknown_status", entityId: f.id } })).toBe(1);
  });

  it("AWB: the fulfilment poller is kept away, DRY_RUN validates with testMode, LIVE stores the AWB", async () => {
    await setMode(g.connection.id, "DRY_RUN");
    const r = await createManualShipment(owner, awbInput());
    expect(
      await g.db.eushipmentsTracking.findUnique({ where: { fulfillmentId: r.fulfillmentId! } }),
    ).toMatchObject({ stopPolling: true });
    const bodies: unknown[] = [];
    const m = fetchMock((method, path, body) => {
      bodies.push(body);
      return path === "/createAWB"
        ? json({ awb: 7000008793166, barcode: "B", packagesBarcodes: [], id: 9 })
        : json({ type: "PDF", awb_print: PDF });
    });
    const resolve = withLabelTransports(() => undefined, { eu: { fetchImpl: m.fetchImpl } });
    const req = await g.db.outboundRequest.findFirstOrThrow({ where: { fulfillmentId: r.fulfillmentId! } });
    expect(await processOutbound(req.id, resolve)).toBe("DRY_RUN_RECORDED");
    expect((bodies[0] as { testMode: boolean }).testMode).toBe(true);
    expect((await g.db.fulfillment.findUniqueOrThrow({ where: { id: r.fulfillmentId! } })).status).toBe(
      "QUEUED",
    );

    await setMode(g.connection.id, "LIVE");
    await resendLabel(owner, r.manualShipmentId);
    expect(await processOutbound(req.id, resolve)).toBe("SENT");
    expect((bodies[1] as { testMode: boolean }).testMode).toBe(false);
    const f = await g.db.fulfillment.findUniqueOrThrow({ where: { id: r.fulfillmentId! } });
    expect(f).toMatchObject({
      status: "ACCEPTED",
      vendorOrderId: "7000008793166",
      trackingNumbers: ["7000008793166"],
    });
  });

  it("AWB: an unknown outcome is UNCERTAIN + an operator task, never retried", async () => {
    const r = await createManualShipment(owner, awbInput());
    const m = fetchMock(() => json({}, 504));
    const req = await g.db.outboundRequest.findFirstOrThrow({ where: { fulfillmentId: r.fulfillmentId! } });
    expect(
      await processOutbound(
        req.id,
        withLabelTransports(() => undefined, { eu: { fetchImpl: m.fetchImpl } }),
      ),
    ).toBe("UNCERTAIN");
    expect(m.calls).toEqual(["POST /createAWB"]);
    expect(await g.db.alert.count({ where: { kind: "outbox_uncertain", entityId: req.id } })).toBe(1);
    await expect(resendLabel(owner, r.manualShipmentId)).rejects.toMatchObject({ code: "already_submitted" });
  });

  it("AWB tracking reuses the euShipments status map by AWB number", async () => {
    const r = await createManualShipment(owner, awbInput());
    await g.db.fulfillment.update({
      where: { id: r.fulfillmentId! },
      data: { status: "ACCEPTED", vendorOrderId: "4069" },
    });
    await g.db.order.update({ where: { id: r.orderId }, data: { status: "ACCEPTED" } });
    const m = fetchMock(() =>
      json([
        {
          refNum: `M-${r.number}`,
          awb: "4069",
          statusesHistory: [{ ID: 1, STATUS: "Delivered", DATE: "2026-11-02 10:00:00" }],
          error: null,
          errorCode: null,
        },
      ]),
    );
    const t = await trackLabels(g.accountId, g.connection.id, { eu: { fetchImpl: m.fetchImpl } });
    expect(t.tracked).toBeGreaterThanOrEqual(1);
    expect(m.calls).toContain("POST /fulfilment/waybills-history");
    expect((await g.db.fulfillment.findUniqueOrThrow({ where: { id: r.fulfillmentId! } })).status).toBe(
      "DELIVERED",
    );
    expect(
      (await g.db.manualShipment.findUniqueOrThrow({ where: { id: r.manualShipmentId } })).stopTracking,
    ).toBe(true);
  });

  it("a missing AWB label is retried up to the cap, then ONE task and no more vendor calls", async () => {
    const r = await createManualShipment(owner, awbInput());
    await g.db.fulfillment.update({
      where: { id: r.fulfillmentId! },
      data: { status: "ACCEPTED", vendorOrderId: "7000000000001" },
    });
    const m = fetchMock(() => json({ message: "Additional package detected" }, 422));
    for (let i = 0; i < MAX_LABEL_ATTEMPTS + 2; i++) {
      const due = (await awbLabelsMissing(10_000)).some((x) => x.fulfillmentId === r.fulfillmentId);
      if (!due) break;
      expect(
        (await fetchMissingAwbLabel(g.accountId, r.fulfillmentId!, { eu: { fetchImpl: m.fetchImpl } }))
          .stored,
      ).toBe(false);
    }
    expect(m.calls.length).toBe(MAX_LABEL_ATTEMPTS);
    const ms = await g.db.manualShipment.findUniqueOrThrow({ where: { id: r.manualShipmentId } });
    expect(ms.labelAttempts).toBe(MAX_LABEL_ATTEMPTS);
    expect(ms.labelError).toBeTruthy();
    expect(
      await g.db.alert.count({ where: { kind: "labels_awb_print_failed", entityId: r.fulfillmentId! } }),
    ).toBe(1);
    expect((await awbLabelsMissing(10_000)).some((x) => x.fulfillmentId === r.fulfillmentId)).toBe(false);
  });

  it("courier / office mirror and label download respect permission and company scope", async () => {
    const outsider = { ...owner, role: "OPERATOR" as const, companyScope: ["another-company"] };
    await expect(euCouriers(outsider, g.connection.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(euOffices(outsider, g.connection.id, 20, "")).rejects.toMatchObject({ code: "not_found" });
    await expect(euOffices({ ...owner, role: "VIEWER" }, g.connection.id, 20, "")).rejects.toThrow(
      /orders.fulfill/,
    );
    expect(await euOffices(owner, g.connection.id, 20, "")).toEqual(expect.any(Array));
    const label = await g.db.shipmentLabel.findFirst({ where: { accountId: g.accountId } });
    if (label) {
      await expect(labelForDownload({ ...owner, role: "VIEWER" }, label.id)).rejects.toThrow(
        /orders.fulfill/,
      );
      expect((await labelForDownload({ ...owner, role: "WAREHOUSE" }, label.id)).id).toBe(label.id);
    }
  });

  it("bulk label PDF: one Joy GET /labels call, stored once, scoped download", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await createManualShipment(owner, joyInput());
      await g.db.fulfillment.update({ where: { id: r.fulfillmentId! }, data: { status: "ACCEPTED" } });
      ids.push(r.fulfillmentId!);
    }
    const { jobs } = await requestBulkLabels(owner, ids);
    expect(jobs).toHaveLength(1);
    const m = fetchMock(() => json({ labels: PDF }));
    const done = await runLabelPrintJob(g.accountId, jobs[0]!.id, { joy: { fetchImpl: m.fetchImpl } });
    expect(done.status).toBe("DONE");
    expect(m.calls).toEqual(["GET /labels"]);
    const label = await labelForDownload(owner, (done as { labelId: string }).labelId);
    expect(label.kind).toBe("bulk");
    expect(label.fulfillmentIds).toEqual(ids);
    expect((await runLabelPrintJob(g.accountId, jobs[0]!.id)).status).toBe("skipped");
    const outsider = { ...owner, role: "OPERATOR" as const, companyScope: ["another-company"] };
    await expect(labelForDownload(outsider, (done as { labelId: string }).labelId)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("WAREHOUSE: same validators and routing as any order; nothing is queued until Fulfill", async () => {
    const product = await g.db.product.create({
      data: { accountId: g.accountId, sku: `SKU-M-${Date.now()}`, name: "Sample" },
    });
    const input: ManualShipmentInput = {
      ...awbInput({ kind: "WAREHOUSE", lines: [{ productId: product.id, quantity: 1, unitPrice: 20 }] }),
    };
    const p = await previewManualShipment(owner, input);
    expect(p.routing).not.toBeNull();
    expect(p.explanation.bg.length).toBeGreaterThan(0);
    const r = await createManualShipment(owner, input);
    const order = await g.db.order.findUniqueOrThrow({
      where: { id: r.orderId },
      include: { check: true, fulfillments: true },
    });
    expect(["READY", "NEEDS_REVIEW"]).toContain(order.status);
    expect(order.check?.connectionId).toBe(g.connection.id);
    expect(order.fulfillments).toHaveLength(0);
    expect(await g.db.outboundRequest.count({ where: { fulfillment: { orderId: r.orderId } } })).toBe(0);
  });

  it("Изпрати замяна: the form starts from the order (free, no COD); the two orders are linked both ways", async () => {
    const { order: src, product } = await euTestOrder(g, { number: `#RPL${Date.now() % 100000}` });
    const draft = await replacementDraft(owner, src.id);
    expect(draft).toMatchObject({ sourceNumber: src.number, companyId: src.companyId });
    expect(draft.recipient.name).toBe("Test Buyer");
    expect(draft.lines).toEqual([expect.objectContaining({ productId: product.id })]);
    const base = awbInput({
      kind: "WAREHOUSE",
      lines: draft.lines.map((l) => ({ ...l, unitPrice: 0 })),
      cod: null,
    });
    const repl = (reason: "damaged" | "other" = "damaged") => ({ sourceOrderId: src.id, reason });
    // "Друго" needs its text.
    expect(ManualShipmentSchema.safeParse({ ...base, replacement: repl("other") }).success).toBe(false);

    // Not shipped yet, and later: already replaced — warnings shown in „Провери“, to be acknowledged.
    const p = await previewManualShipment(owner, { ...base, replacement: repl() });
    expect(p.findings.find((f) => f.code === "manual.replacement_source_not_shipped")?.severity).toBe("soft");
    await expect(
      createManualShipment(owner, { ...base, clientRequestId: randomUUID(), replacement: repl() }),
    ).rejects.toMatchObject({ code: "manual_preflight_needs_ack" });
    await g.db.order.update({ where: { id: src.id }, data: { status: "DELIVERED" } });
    const r = await createManualShipment(owner, {
      ...base,
      clientRequestId: randomUUID(),
      replacement: repl(),
    });
    const created = await g.db.order.findUniqueOrThrow({
      where: { id: r.orderId },
      include: { lines: true },
    });
    expect(created).toMatchObject({ source: "MANUAL", paymentMethod: "PREPAID", codAmount: null });
    expect(created.tags).toEqual(["manual", "replacement"]);
    expect(Number(created.lines[0]!.unitPrice)).toBe(0);
    const again = await previewManualShipment(owner, { ...base, replacement: repl() });
    expect(again.findings.find((f) => f.code === "manual.replacement_exists")?.message_bg).toContain(
      r.number,
    );
    const audit = await g.db.auditLog.findFirstOrThrow({
      where: { action: "manual_shipment.create", entityId: r.orderId },
    });
    expect(audit.after).toMatchObject({ replacement: { sourceOrderId: src.id, reason: "damaged" } });

    const fromSource = await replacementLinks(owner, src.id);
    expect(fromSource.replacements).toEqual([
      expect.objectContaining({ id: r.orderId, number: r.number, reason: "damaged" }),
    ]);
    expect((await replacementLinks(owner, r.orderId)).replacementOf).toMatchObject({
      id: src.id,
      number: src.number,
      reason: "damaged",
    });

    // Company scope: an operator of another company reaches exactly the source check, and sees no links.
    const other = await g.db.company.create({
      data: { accountId: g.accountId, name: `Other ${Date.now()}` },
    });
    const otherWh = await g.db.fulfillmentConnection.create({
      data: {
        accountId: g.accountId,
        companyId: other.id,
        type: "FHB_V3",
        name: "Other WH",
        liveMode: "LIVE",
      },
    });
    const outsider = { ...owner, role: "OPERATOR" as const, companyScope: [other.id] };
    await expect(
      previewManualShipment(outsider, {
        ...base,
        companyId: other.id,
        connectionId: otherWh.id,
        replacement: repl(),
      }),
    ).rejects.toMatchObject({ code: "replacement_source_not_found" });
    await expect(
      previewManualShipment(owner, { ...base, companyId: other.id, replacement: repl() }),
    ).rejects.toMatchObject({ code: "replacement_other_company" });
    await expect(
      previewManualShipment(owner, {
        ...base,
        replacement: { sourceOrderId: "no-such-order", reason: "lost" },
      }),
    ).rejects.toMatchObject({ code: "replacement_source_not_found" });
    expect(await replacementLinks(outsider, src.id)).toEqual({
      replacements: [],
      replacementOf: null,
      shopifyRef: null,
    });
    // Another group cannot start from this order.
    const stranger = await euTestGroup("labels-replacement-other");
    await expect(replacementDraft(stranger.owner, src.id)).rejects.toMatchObject({ code: "not_found" });
  });
  it("a manual order keeps the Shopify number typed for it: tagged, found by search, linked to that order", async () => {
    const { order: shop } = await euTestOrder(g, { number: `#SR${Date.now() % 100000}` });
    const typed = ` ${shop.number.toLowerCase()} `;
    const product = await g.db.product.create({
      data: { accountId: g.accountId, sku: `SKU-SR-${Date.now()}`, name: "Sample" },
    });
    const r = await createManualShipment(owner, {
      ...awbInput({ kind: "WAREHOUSE", lines: [{ productId: product.id, quantity: 1, unitPrice: 0 }] }),
      shopifyOrderNumber: typed,
      clientRequestId: randomUUID(),
    });
    const ref = shop.number.replace("#", "").toUpperCase();
    expect((await g.db.order.findUniqueOrThrow({ where: { id: r.orderId } })).tags).toContain(
      `shopify:${ref}`,
    );
    expect((await replacementLinks(owner, r.orderId)).shopifyRef).toEqual({
      number: ref,
      order: { id: shop.id, number: shop.number },
    });
    const found = await listOrders(
      { accountId: g.accountId, companyScope: null, activeCompanyId: null },
      { tab: "all", q: shop.number },
    );
    expect(found.rows.map((o) => o.id)).toEqual(expect.arrayContaining([shop.id, r.orderId]));
    expect(ManualShipmentSchema.safeParse({ ...awbInput(), shopifyOrderNumber: "bad number!" }).success).toBe(
      false,
    );
  });

  it("quick stock check: the units of a product in every warehouse and in total, free = minus held orders", async () => {
    const product = await g.db.product.create({
      data: { accountId: g.accountId, sku: `SKU-QS-${Date.now()}`, name: "Sample" },
    });
    const fhbWh = await g.db.fulfillmentConnection.create({
      data: {
        accountId: g.accountId,
        companyId: g.company.id,
        type: "FHB_V3",
        name: "QS FHB",
        liveMode: "LIVE",
      },
    });
    for (const [connectionId, physical] of [
      [g.connection.id, 4],
      [fhbWh.id, 6],
    ] as const) {
      const vp = await g.db.vendorProduct.create({
        data: {
          accountId: g.accountId,
          connectionId,
          productId: product.id,
          vendorId: `qs-${connectionId}`,
          raw: {},
        },
      });
      await g.db.stockLevel.create({
        data: {
          accountId: g.accountId,
          vendorProductId: vp.id,
          physical,
          free: physical,
          sellable: physical,
          snapshotAt: new Date(),
          source: "POLL",
        },
      });
    }
    const [s] = await stockPerWarehouse(owner, [product.id]);
    expect(s?.totalPhysical).toBe(10);
    expect(s?.warehouses.map((w) => (w.carried ? [w.name, w.physical] : null))).toEqual(
      expect.arrayContaining([
        ["QS FHB", 6],
        [g.connection.name, 4],
      ]),
    );
    expect(s?.totalSellable).toBe(10);
    // A unit FHB could not give (SkuIncident) is not free there — the same number „Провери“ checks.
    await g.db.skuIncident.create({
      data: {
        accountId: g.accountId,
        connectionId: fhbWh.id,
        productId: product.id,
        fulfillmentId: `qs-${Date.now()}`,
        quantity: 1,
      },
    });
    const [held] = await stockPerWarehouse(owner, [product.id]);
    expect(held?.warehouses.find((w) => w.connectionId === fhbWh.id)).toMatchObject({
      physical: 6,
      sellable: 5,
    });
    expect(held?.totalSellable).toBe(9);
    // A member of another company sees none of these warehouses; another group sees nothing of the product.
    const otherCo = await g.db.company.create({
      data: { accountId: g.accountId, name: `QS other ${Date.now()}` },
    });
    const [scoped] = await stockPerWarehouse({ ...owner, role: "OPERATOR", companyScope: [otherCo.id] }, [
      product.id,
    ]);
    expect(scoped?.warehouses).toEqual([]);
    const stranger = await euTestGroup("labels-stock-other");
    const [foreign] = await stockPerWarehouse(stranger.owner, [product.id]);
    expect(foreign?.totalPhysical).toBe(0);
    await expect(stockPerWarehouse({ ...owner, role: "VIEWER" }, [product.id])).rejects.toThrow();
  });

  it("product search: by SKU, name or warehouse code, every word; archived left out; this group only", async () => {
    const stamp = Date.now();
    const p = await g.db.product.create({
      data: { accountId: g.accountId, sku: `SRCH-${stamp}`, name: `Synthetic Rose${stamp} Parfum 50 ml` },
    });
    await g.db.vendorProduct.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        productId: p.id,
        vendorId: `WH${stamp}`,
        raw: {},
      },
    });
    const gone = await g.db.product.create({
      data: {
        accountId: g.accountId,
        sku: `SRCH-OLD-${stamp}`,
        name: "Synthetic Rose Parfum old",
        archived: true,
      },
    });
    const ids = async (q: string, who = owner) => (await searchManualProducts(who, q)).map((x) => x.id);
    expect(await ids(`rose${stamp} 50`)).toContain(p.id);
    expect(await ids(`srch-${stamp}`)).toContain(p.id);
    expect(await ids(`WH${stamp}`)).toContain(p.id);
    expect(await ids(`rose${stamp} parfum`)).not.toContain(gone.id);
    expect(await ids(`rose${stamp} lavender`)).not.toContain(p.id);
    const stranger = await euTestGroup("labels-search-other");
    expect(await ids(`SRCH-${stamp}`, stranger.owner)).toEqual([]);
    await expect(searchManualProducts({ ...owner, role: "VIEWER" }, "rose")).rejects.toThrow();
  });

  it("detail and isolation: another group cannot read a manual shipment", async () => {
    const r = await createManualShipment(owner, joyInput());
    const d = await getManualShipment(owner, r.manualShipmentId);
    expect(d.ms.order.number).toBe(r.number);
    const other = await euTestGroup("labels-other");
    await expect(getManualShipment(other.owner, r.manualShipmentId)).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("Joy live check: GET calls only, schema-validates, flags unknown statuses", async () => {
    const m = fetchMock((method, path) => {
      if (method !== "GET") throw new Error(`write in a live check: ${method} ${path}`);
      if (path === "/delivery-point") return json(ex["GET /delivery-point 200"]);
      return json({ ...(ex["GET /shipment 200"] as object), status: "brand_new", extra: 1 });
    });
    const r = await joyLiveCheck.run(
      { accountId: g.accountId, kind: "connection", id: joy.id, name: "Joy test", type: "FHB_JOY" },
      { fetchImpl: m.fetchImpl as never },
    );
    expect(r.probes).toEqual(["POST /login", "GET /delivery-point", "GET /shipment"]);
    expect(r.issues.filter((i) => i.breaking)).toEqual([]);
    expect(r.issues.map((i) => i.code)).toContain("unknown_enum");
  });
});
