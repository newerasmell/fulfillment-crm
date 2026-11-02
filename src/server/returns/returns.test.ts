import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "@/integrations/fhb-v3/client";
import type { Actor } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { accountDb, systemDb } from "@/server/db/client";
import { createFhbConnection, fhbClientForConnection } from "@/server/fhb/connection";
import type { NotificationProvider } from "@/server/alerts/notify";
import { buildCases, isOverdue, localItems, returnTrackingOf } from "./build";
import {
  countReturnsToProcess,
  listReturns,
  markReturnProcessed,
  readReturnPhoto,
  reopenReturn,
  requestReturnPhotos,
  requestSupportNotify,
} from "./board";
import { notifySupportForAccount, supportProviders } from "./notify";
import { acceptedImageType, fetchReturnPhotos } from "./photos";
import { getReturnsCodSettings, updateReturnsCodSettings } from "./settings";
import { OVERDUE_KIND, syncReturnCases } from "./sweep";

// Synthetic data only. No vendor is called: the sweep reads the local mirrors; photos use a mocked fetch.

const DAY = 86_400_000;
const NOW = new Date("2026-11-02T10:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

describe("buildCases (pure)", () => {
  const connections = [
    { id: "fhb", type: "FHB_V3", companyId: "coF" },
    { id: "eu", type: "EUSHIPMENTS", companyId: "coE" },
  ];
  const f = (over: Partial<Parameters<typeof buildCases>[0]["fulfillments"][number]>) => ({
    id: "f1",
    connectionId: "fhb",
    externalId: "DM-1001",
    status: "SHIPPED",
    rawStatus: "sent",
    trackingNumbers: ["TRK1"],
    returnInfo: null,
    order: { id: "o1", number: "#1001", companyId: "coA" },
    items: [{ title: "Синтетичен крем", sku: "SYN-1", quantity: 1 }],
    returningEventAt: null,
    receivedEventAt: null,
    ...over,
  });

  it("FHB rma/list row of a CRM shipment → one received case linked to the order", () => {
    const cases = buildCases({
      connections,
      fulfillments: [f({})],
      rma: [
        {
          connectionId: "fhb",
          externalId: "DM-1001",
          rawStatus: "returned",
          returnedAt: ago(1),
          returnType: "return",
          trackingNumbers: ["TRK1"],
          raw: { package_returns: [{ tracking: "TRK1", return_tracking: "RET1" }] },
        },
      ],
      local: [],
    });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      caseKey: "fulfillment:f1",
      sources: ["FHB_RMA"],
      state: "RECEIVED",
      receivedAt: ago(1),
      orderId: "o1",
      companyId: "coA",
      reference: "#1001",
      returnType: "return",
      returnTracking: ["RET1"],
    });
  });

  it("an rma row the CRM does not know keeps the vendor id and the connection's company", () => {
    const [c] = buildCases({
      connections,
      fulfillments: [],
      rma: [
        {
          connectionId: "fhb",
          externalId: "ZOE-77",
          rawStatus: "returned",
          returnedAt: null,
          returnType: null,
          trackingNumbers: [],
          raw: { items: [{ id: "RSK-1", quantity: 2 }] },
        },
      ],
      local: [],
    });
    expect(c).toMatchObject({
      caseKey: "fhb-rma:fhb:ZOE-77",
      fulfillmentId: null,
      companyId: "coF",
      state: "RECEIVED",
      receivedAt: null,
      items: [{ title: "RSK-1", sku: "RSK-1", quantity: 2 }],
    });
  });

  it("a local depot return joins the shipment's case by package barcode, with items, condition and photos", () => {
    const cases = buildCases({
      connections,
      fulfillments: [f({ status: "RETURN_RECEIVED", receivedEventAt: ago(2) })],
      rma: [],
      local: [
        {
          connectionId: "fhb",
          uid: "AB00001",
          type: "complex",
          status: "stored",
          barcodes: ["TRK1"],
          items: [
            {
              id: 17,
              barcode: "0000000000017",
              description: "Синтетичен крем",
              condition: "Damaged box",
              quantity: 1,
              action: "stock_in",
            },
          ],
          photos: [{ id: 51, type: "package" }],
          vendorCreatedAt: ago(3),
        },
      ],
    });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      sources: ["FHB_LOCAL", "FHB_RMA"],
      localReturnUid: "AB00001",
      receivedAt: ago(3),
      rawStatus: "stored",
      items: [{ title: "Синтетичен крем", condition: "Damaged box", action: "stock_in", quantity: 1 }],
      photos: [{ id: "51", type: "package" }],
    });
  });

  it("a local return without a matching shipment is its own case; other connections' barcodes never match", () => {
    const cases = buildCases({
      connections: [...connections, { id: "fhb2", type: "FHB_V3", companyId: "coG" }],
      fulfillments: [f({})],
      rma: [],
      local: [
        {
          connectionId: "fhb2",
          uid: "AB2",
          type: "basic",
          status: "stored",
          barcodes: ["TRK1"],
          items: [],
          photos: [],
          vendorCreatedAt: ago(1),
        },
      ],
    });
    expect(cases.map((c) => c.caseKey)).toEqual(["fhb-return:fhb2:AB2"]);
    expect(cases[0]!.companyId).toBe("coG");
  });

  it("euShipments: RETURNING is on its way, RETURN_RECEIVED is back (dates from the status events)", () => {
    const cases = buildCases({
      connections,
      fulfillments: [
        f({
          id: "e1",
          connectionId: "eu",
          status: "RETURNING",
          rawStatus: "Returning",
          returningEventAt: ago(20),
          returnInfo: { returnAwb: "R-1" },
        }),
        f({
          id: "e2",
          connectionId: "eu",
          externalId: "DM-2",
          status: "RETURN_RECEIVED",
          returningEventAt: ago(9),
          receivedEventAt: ago(1),
        }),
        f({ id: "e3", connectionId: "eu", externalId: "DM-3", status: "DELIVERED" }),
      ],
      rma: [],
      local: [],
    });
    expect(cases.map((c) => [c.caseKey, c.state, c.sources[0]])).toEqual([
      ["fulfillment:e1", "RETURNING", "EUSHIPMENTS"],
      ["fulfillment:e2", "RECEIVED", "EUSHIPMENTS"],
    ]);
    expect(cases[0]).toMatchObject({ returningSince: ago(20), returnTracking: ["R-1"] });
    expect(cases[1]).toMatchObject({ receivedAt: ago(1) });
  });

  it("helpers: overdue threshold, return tracking, item parsing", () => {
    const base = { state: "RETURNING", processedAt: null, returningSince: ago(14), firstSeenAt: ago(1) };
    expect(isOverdue(base, 14, NOW)).toBe(true);
    expect(isOverdue({ ...base, returningSince: ago(13) }, 14, NOW)).toBe(false);
    expect(isOverdue({ ...base, returningSince: null }, 14, NOW)).toBe(false);
    expect(isOverdue({ ...base, state: "RECEIVED" }, 14, NOW)).toBe(false);
    expect(isOverdue({ ...base, processedAt: NOW }, 14, NOW)).toBe(false);
    expect(returnTrackingOf({ returnAwb: "A", packageReturns: [{ return_tracking: "B" }, {}] })).toEqual([
      "A",
      "B",
    ]);
    expect(localItems([{ quantity: 0 }, { barcode: "1", quantity: 3 }])).toEqual([
      { title: "1", sku: "1", quantity: 3, condition: null, action: null },
    ]);
  });
});

// ───────────── database ─────────────

let seq = 0;
async function setup() {
  const n = ++seq;
  const sys = systemDb();
  const account = await sys.account.create({ data: { name: `Returns ${n}` } });
  const coA = await sys.company.create({ data: { accountId: account.id, name: "Фирма А" } });
  const coB = await sys.company.create({ data: { accountId: account.id, name: "Фирма Б" } });
  const user = await sys.user.create({
    data: { email: `ret-${n}-${Date.now()}@example.com`, name: "Оператор", passwordHash: "x" },
  });
  const owner: Actor & { companyScope: null } = {
    userId: user.id,
    accountId: account.id,
    role: "OWNER",
    companyScope: null,
  };
  const fhb = await createFhbConnection(owner, {
    companyId: coA.id,
    name: "FHB А",
    appId: "test-app",
    secret: "test-secret",
    skuPrefix: "R",
  });
  const eu = await sys.fulfillmentConnection.create({
    data: { accountId: account.id, companyId: coB.id, name: "euShipments Б", type: "EUSHIPMENTS" },
  });
  let orderSeq = 0;
  const shipment = async (
    connectionId: string,
    companyId: string,
    status: "SHIPPED" | "RETURNING" | "RETURN_RECEIVED" | "DELIVERED",
    over: { trackingNumbers?: string[]; returnInfo?: object } = {},
  ) => {
    const k = ++orderSeq;
    const order = await sys.order.create({
      data: {
        accountId: account.id,
        companyId,
        source: "MANUAL",
        number: `#R-${n}-${k}`,
        currency: "EUR",
        subtotal: 10,
        total: 10,
        paymentMethod: "COD",
        placedAt: ago(30),
        status,
      },
    });
    await sys.orderLine.create({
      data: {
        accountId: account.id,
        orderId: order.id,
        title: "Синтетичен крем",
        sku: "SYN-1",
        quantity: 1,
        unitPrice: 10,
      },
    });
    const f = await sys.fulfillment.create({
      data: {
        accountId: account.id,
        orderId: order.id,
        connectionId,
        externalId: `M-${n}-${k}`,
        status,
        trackingNumbers: over.trackingNumbers ?? [`TRK-${n}-${k}`],
        ...(over.returnInfo ? { returnInfo: over.returnInfo } : {}),
      },
    });
    return { order, f };
  };
  return { account, coA, coB, owner, fhb, eu, shipment, user };
}

const event = (accountId: string, fulfillmentId: string, status: "RETURNING" | "RETURN_RECEIVED", at: Date) =>
  systemDb().fulfillmentEvent.create({
    data: { accountId, fulfillmentId, occurredAt: at, source: "eushipments.history", status },
  });

describe("returns sweep + board", () => {
  it("builds cases from the mirrors once (idempotent), never regresses, raises and resolves the overdue alert", async () => {
    const s = await setup();
    const sys = systemDb();
    const a = s.account.id;
    const fhbShip = await s.shipment(s.fhb.id, s.coA.id, "SHIPPED");
    await sys.fhbOrderMirror.create({
      data: {
        accountId: a,
        connectionId: s.fhb.id,
        externalId: fhbShip.f.externalId,
        rawStatus: "returned",
        status: "RETURN_RECEIVED",
        trackingNumbers: fhbShip.f.trackingNumbers,
        returnedAt: ago(1),
        returnType: "return",
        inRma: true,
        raw: {},
        lastSyncAt: NOW,
      },
    });
    const euShip = await s.shipment(s.eu.id, s.coB.id, "RETURNING");
    await event(a, euShip.f.id, "RETURNING", ago(20));

    const r1 = await syncReturnCases(a, NOW);
    expect(r1).toMatchObject({ cases: 2, created: 2, updated: 0, overdueRaised: 1 });
    const r2 = await syncReturnCases(a, NOW);
    expect(r2).toMatchObject({ created: 0, updated: 0, overdueRaised: 0 });

    const db = accountDb(a);
    const overdue = await db.alert.findFirstOrThrow({ where: { kind: OVERDUE_KIND } });
    expect(overdue).toMatchObject({ entityType: "Fulfillment", entityId: euShip.f.id, isTask: true });

    // Back at the warehouse: case received, overdue alert resolves itself.
    await sys.fulfillment.update({ where: { id: euShip.f.id }, data: { status: "RETURN_RECEIVED" } });
    await event(a, euShip.f.id, "RETURN_RECEIVED", ago(0));
    const r3 = await syncReturnCases(a, NOW);
    expect(r3).toMatchObject({ updated: 1, received: 1, overdueResolved: 1 });
    expect((await db.alert.findUniqueOrThrow({ where: { id: overdue.id } })).status).toBe("RESOLVED");

    // A later status that looks like "returning" again never moves the case back.
    await sys.fulfillment.update({ where: { id: euShip.f.id }, data: { status: "RETURNING" } });
    await syncReturnCases(a, NOW);
    const euCase = await db.returnCase.findFirstOrThrow({ where: { fulfillmentId: euShip.f.id } });
    expect(euCase.state).toBe("RECEIVED");
    expect(euCase.returningSince).toEqual(ago(20));
  });

  it("the board filters by tab, source, warehouse and the member's companies; process + reopen are audited", async () => {
    const s = await setup();
    const a = s.account.id;
    const db = accountDb(a);
    const fhbShip = await s.shipment(s.fhb.id, s.coA.id, "RETURN_RECEIVED", {
      returnInfo: { returnedAt: "2026-11-01T09:00:00+0100", returnType: "return" },
    });
    const euShip = await s.shipment(s.eu.id, s.coB.id, "RETURNING");
    await event(a, euShip.f.id, "RETURNING", ago(2));
    // euShipments' own "notify support" task for the FHB-less shipment is closed by processing.
    await syncReturnCases(a, NOW);

    const all = await listReturns(s.owner, { tab: "all" }, NOW);
    expect(all.rows).toHaveLength(2);
    expect(all.counts).toMatchObject({ todo: 1, returning: 1, overdue: 0, processed: 0, all: 2 });
    // Начало's count follows the header warehouse scope, like the board it links to.
    expect(await countReturnsToProcess(s.owner)).toBe(1);
    expect(await countReturnsToProcess(s.owner, { connectionTypes: ["FHB_V3", "FHB_JOY"] })).toBe(1);
    expect(await countReturnsToProcess(s.owner, { connectionTypes: ["EUSHIPMENTS"] })).toBe(0);
    expect((await listReturns(s.owner, { tab: "all", source: "EUSHIPMENTS" }, NOW)).rows).toHaveLength(1);
    expect(
      (await listReturns(s.owner, { tab: "all", connectionTypes: ["FHB_V3", "FHB_JOY"] }, NOW)).rows,
    ).toHaveLength(1);
    expect(
      (await listReturns({ ...s.owner, lineCompanyIds: [s.coB.id] }, { tab: "all" }, NOW)).rows,
    ).toHaveLength(1);
    expect(
      (await listReturns({ ...s.owner, activeCompanyId: s.coA.id }, { tab: "all" }, NOW)).rows,
    ).toHaveLength(1);
    const q = await listReturns(s.owner, { tab: "all", q: fhbShip.order.number }, NOW);
    expect(q.rows.map((r) => r.fulfillmentId)).toEqual([fhbShip.f.id]);

    // A restricted operator of Фирма Б neither sees nor processes Фирма А's return.
    const opB = { ...s.owner, role: "OPERATOR" as const, companyScope: [s.coB.id] };
    const seen = await listReturns(opB, { tab: "all" }, NOW);
    expect(seen.rows.map((r) => r.fulfillmentId)).toEqual([euShip.f.id]);
    const fhbCase = all.rows.find((r) => r.fulfillmentId === fhbShip.f.id)!;
    await expect(markReturnProcessed(opB, fhbCase.id, "върнато в склад")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      markReturnProcessed({ ...s.owner, role: "VIEWER" }, fhbCase.id, "върнато в склад"),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const task = await systemDb().alert.create({
      data: {
        accountId: a,
        kind: "eushipments_return_received",
        isTask: true,
        title: "t",
        entityType: "Fulfillment",
        entityId: fhbShip.f.id,
      },
    });
    await expect(markReturnProcessed(s.owner, fhbCase.id, "x")).rejects.toThrow(); // note required
    await markReturnProcessed(s.owner, fhbCase.id, "Сумата е възстановена в Shopify");
    await expect(markReturnProcessed(s.owner, fhbCase.id, "отново")).rejects.toMatchObject({
      code: "already_processed",
    });
    expect((await db.alert.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("RESOLVED");
    const processed = await listReturns(s.owner, { tab: "processed" }, NOW);
    expect(processed.rows[0]).toMatchObject({
      processedNote: "Сумата е възстановена в Shopify",
      processedBy: "Оператор",
    });
    // The sweep keeps the operator's mark.
    await syncReturnCases(a, NOW);
    expect((await listReturns(s.owner, { tab: "processed" }, NOW)).rows).toHaveLength(1);
    await reopenReturn(s.owner, fhbCase.id);
    expect((await listReturns(s.owner, { tab: "todo" }, NOW)).rows).toHaveLength(1);
    const audit = await db.auditLog.findMany({
      where: { entityId: fhbCase.id },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((x) => x.action)).toEqual(["return.processed", "return.reopened"]);
  });

  it("another group's cases are invisible (account isolation)", async () => {
    const s1 = await setup();
    const s2 = await setup();
    const ship = await s1.shipment(s1.eu.id, s1.coB.id, "RETURN_RECEIVED");
    await syncReturnCases(s1.account.id, NOW);
    const c = await accountDb(s1.account.id).returnCase.findFirstOrThrow({
      where: { fulfillmentId: ship.f.id },
    });
    expect((await listReturns(s2.owner, { tab: "all" }, NOW)).rows).toHaveLength(0);
    await expect(markReturnProcessed(s2.owner, c.id, "чужда група")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await accountDb(s2.account.id).returnCase.count()).toBe(0);
  });

  it("settings: defaults, owner/admin only, validated and audited", async () => {
    const s = await setup();
    expect(await getReturnsCodSettings(s.account.id)).toEqual({
      returnOverdueDays: 14,
      codMissingDays: 14,
      notifySupport: true,
    });
    await expect(
      updateReturnsCodSettings(
        { ...s.owner, role: "OPERATOR" },
        { returnOverdueDays: 5, codMissingDays: 5, notifySupport: false },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      updateReturnsCodSettings(s.owner, { returnOverdueDays: 0, codMissingDays: 5, notifySupport: true }),
    ).rejects.toThrow();
    await updateReturnsCodSettings(s.owner, {
      returnOverdueDays: 5,
      codMissingDays: 7,
      notifySupport: false,
    });
    expect(await getReturnsCodSettings(s.account.id)).toEqual({
      returnOverdueDays: 5,
      codMissingDays: 7,
      notifySupport: false,
    });
  });
});

describe("support notification", () => {
  const provider = (channel: string, send = vi.fn(async () => {}), disabledReason: string | null = null) =>
    ({ channel, disabledReason, send }) satisfies NotificationProvider;

  it("sends once per case and channel for fresh returns, skips old/undated ones, retries FAILED only on request", async () => {
    const s = await setup();
    const a = s.account.id;
    const fresh = await s.shipment(s.eu.id, s.coB.id, "RETURN_RECEIVED");
    await event(a, fresh.f.id, "RETURN_RECEIVED", ago(1));
    const old = await s.shipment(s.eu.id, s.coB.id, "RETURN_RECEIVED");
    await event(a, old.f.id, "RETURN_RECEIVED", ago(10));
    await syncReturnCases(a, NOW);

    const email = provider("email");
    const tg = provider(
      "telegram",
      vi.fn(async () => {
        throw new Error("telegram HTTP 500");
      }),
    );
    const off = provider("sms", vi.fn(), "not configured");
    const env = { APP_URL: "https://crm.example.com" };
    const r1 = await notifySupportForAccount(a, [email, tg, off], { now: NOW, env });
    expect(r1).toEqual({ sent: 1, failed: 1, disabled: 1 });
    expect(email.send).toHaveBeenCalledTimes(1);
    const msg = (email.send.mock.calls[0] as unknown as [{ title: string; link: string }])[0];
    expect(msg.title).toContain(fresh.order.number);
    expect(msg.title).not.toContain("Оператор");
    expect(msg.link).toMatch(/^https:\/\/crm\.example\.com\/returns\?case=/);
    expect(off.send).not.toHaveBeenCalled();

    // Second run: nothing new (no automatic retry of the failed channel, old case not automatic).
    expect(await notifySupportForAccount(a, [email, tg], { now: NOW, env })).toMatchObject({
      sent: 0,
      failed: 0,
    });

    // Manual request on the fresh case: only the FAILED channel is tried again.
    const db = accountDb(a);
    const freshCase = await db.returnCase.findFirstOrThrow({ where: { fulfillmentId: fresh.f.id } });
    tg.send.mockImplementation(async () => {});
    await requestSupportNotify(s.owner, freshCase.id);
    expect(await notifySupportForAccount(a, [email, tg], { now: NOW, env })).toMatchObject({ sent: 1 });
    expect(email.send).toHaveBeenCalledTimes(1);

    // Manual request on the old case sends it on both channels.
    const oldCase = await db.returnCase.findFirstOrThrow({ where: { fulfillmentId: old.f.id } });
    await requestSupportNotify(s.owner, oldCase.id);
    expect(await notifySupportForAccount(a, [email, tg], { now: NOW, env })).toMatchObject({ sent: 2 });
    const rows = await db.returnNotification.findMany({ where: { returnCaseId: oldCase.id } });
    expect(rows.map((r) => r.status).sort()).toEqual(["SENT", "SENT"]);
    expect(
      (await db.returnCase.findUniqueOrThrow({ where: { id: oldCase.id } })).supportNotifyRequestedAt,
    ).toBeNull();
  });

  it("a claim left SENDING by a crashed run becomes FAILED and can be retried on request", async () => {
    const s = await setup();
    const a = s.account.id;
    const ship = await s.shipment(s.eu.id, s.coB.id, "RETURN_RECEIVED");
    await event(a, ship.f.id, "RETURN_RECEIVED", ago(1));
    await syncReturnCases(a, NOW);
    const db = accountDb(a);
    const c = await db.returnCase.findFirstOrThrow({ where: { fulfillmentId: ship.f.id } });
    // Crashed between the claim and the SENT/FAILED update, long ago.
    await db.returnNotification.create({
      data: {
        accountId: a,
        returnCaseId: c.id,
        channel: "email",
        createdAt: new Date(Date.now() - 3600_000),
      },
    });
    // A fresh claim of another run in progress is left alone.
    await db.returnNotification.create({ data: { accountId: a, returnCaseId: c.id, channel: "telegram" } });
    const email = provider("email");
    const tg = provider("telegram");
    const env = { APP_URL: "https://crm.example.com" };
    expect(await notifySupportForAccount(a, [email, tg], { now: NOW, env })).toMatchObject({ sent: 0 });
    const rows = async () =>
      Object.fromEntries(
        (await db.returnNotification.findMany({ where: { returnCaseId: c.id } })).map((r) => [
          r.channel,
          r.status,
        ]),
      );
    expect(await rows()).toEqual({ email: "FAILED", telegram: "SENDING" });
    await requestSupportNotify(s.owner, c.id);
    expect(await notifySupportForAccount(a, [email, tg], { now: NOW, env })).toMatchObject({ sent: 1 });
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(tg.send).not.toHaveBeenCalled();
    expect(await rows()).toEqual({ email: "SENT", telegram: "SENDING" });
  });

  it("off when the setting is off or no channel is configured; never for returns still on their way", async () => {
    const s = await setup();
    const a = s.account.id;
    const ship = await s.shipment(s.eu.id, s.coB.id, "RETURN_RECEIVED");
    await event(a, ship.f.id, "RETURN_RECEIVED", ago(0));
    const way = await s.shipment(s.eu.id, s.coB.id, "RETURNING");
    await syncReturnCases(a, NOW);
    const wayCase = await accountDb(a).returnCase.findFirstOrThrow({ where: { fulfillmentId: way.f.id } });
    await expect(requestSupportNotify(s.owner, wayCase.id)).rejects.toMatchObject({ code: "not_received" });
    const none = supportProviders({});
    expect(none.every((p) => p.disabledReason)).toBe(true);
    expect(await notifySupportForAccount(a, none, { now: NOW, env: {} })).toEqual({
      sent: 0,
      failed: 0,
      disabled: 2,
    });
    await updateReturnsCodSettings(s.owner, {
      returnOverdueDays: 14,
      codMissingDays: 14,
      notifySupport: false,
    });
    const email = provider("email");
    expect(await notifySupportForAccount(a, [email], { now: NOW, env: {} })).toMatchObject({ sent: 0 });
    expect(email.send).not.toHaveBeenCalled();
  });

  it("support address and chat override the alert channels", () => {
    const [email, tg] = supportProviders({
      ALERT_EMAIL_WEBHOOK_URL: "https://relay.example.com",
      ALERT_EMAIL_TO: "alerts@example.com",
      RETURNS_SUPPORT_EMAIL_TO: "support@example.com",
      TELEGRAM_BOT_TOKEN: "t",
      RETURNS_SUPPORT_TELEGRAM_CHAT_ID: "42",
    });
    expect(email!.disabledReason).toBeNull();
    expect(tg!.disabledReason).toBeNull();
  });
});

describe("FHB local return photos", () => {
  it("are fetched on request (GET only, images only, capped) and served within the member's scope", async () => {
    const s = await setup();
    const a = s.account.id;
    const ship = await s.shipment(s.fhb.id, s.coA.id, "SHIPPED", { trackingNumbers: ["PKG-1"] });
    await systemDb().fhbReturnMirror.create({
      data: {
        accountId: a,
        connectionId: s.fhb.id,
        uid: "AB00001",
        type: "basic",
        status: "stored",
        barcodes: ["PKG-1"],
        photos: [
          { id: 51, type: "package" },
          { id: 52, type: "document" },
        ],
        vendorCreatedAt: ago(1),
        raw: {},
        lastSyncAt: NOW,
      },
    });
    await syncReturnCases(a, NOW);
    const c = await accountDb(a).returnCase.findFirstOrThrow({ where: { fulfillmentId: ship.f.id } });
    expect(c.sources).toEqual(["FHB_LOCAL"]);
    const enqueue = vi.fn(async () => {});
    expect(await requestReturnPhotos(s.owner, c.id, enqueue)).toBe(2);
    expect(enqueue).toHaveBeenCalledWith({ accountId: a, caseId: c.id });

    const methods: string[] = [];
    const fetchImpl = vi.fn<FetchLike>(async (u, init = {}) => {
      const url = new URL(u);
      methods.push(init.method ?? "GET");
      if (url.pathname.endsWith("/login"))
        return new Response(JSON.stringify({ token: "t", expiration: "2099-01-01T00:00:00+0000" }), {
          status: 200,
        });
      if (url.pathname.endsWith("/return/AB00001/photo/51"))
        return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      return new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    });
    const r = await fetchReturnPhotos(a, c.id, { fetchImpl, sleep: async () => {}, random: () => 0 });
    expect(r).toEqual({ fetched: 1, failed: 1 });
    expect(methods.filter((m) => m !== "GET" && m !== "POST")).toEqual([]);
    const files = await accountDb(a).returnPhoto.findMany({
      where: { returnCaseId: c.id },
      orderBy: { photoId: "asc" },
    });
    expect(files.map((f) => f.status)).toEqual(["READY", "FAILED"]);
    const photo = await readReturnPhoto(s.owner, files[0]!.id);
    expect(photo.contentType).toBe("image/jpeg");
    expect([...photo.bytes]).toEqual([0xff, 0xd8, 0xff]);
    await expect(readReturnPhoto(s.owner, files[1]!.id)).rejects.toMatchObject({ code: "not_found" });
    const opB = { ...s.owner, role: "OPERATOR" as const, companyScope: [s.coB.id] };
    await expect(readReturnPhoto(opB, files[0]!.id)).rejects.toMatchObject({ code: "not_found" });
    // Asking again re-queues only the failed one.
    expect(await requestReturnPhotos(s.owner, c.id, enqueue)).toBe(1);
    // The client refuses a file above the cap (declared or actual size) and answers null on 404.
    const client = await fhbClientForConnection(a, s.fhb.id, {
      fetchImpl,
      sleep: async () => {},
      random: () => 0,
    });
    await expect(client.returnPhoto("AB00001", "51", 2)).rejects.toThrow(/larger than 2 bytes/);
    // A chunked body without Content-Length that never ends is cut off at the cap, not buffered.
    let pulled = 0;
    let cancelled = false;
    const endless = await fhbClientForConnection(a, s.fhb.id, {
      fetchImpl: async (u) =>
        new URL(u).pathname.endsWith("/login")
          ? new Response(JSON.stringify({ token: "t", expiration: "2099-01-01T00:00:00+0000" }), {
              status: 200,
            })
          : new Response(
              new ReadableStream<Uint8Array>({
                pull(c) {
                  pulled++;
                  c.enqueue(new Uint8Array(1024));
                },
                cancel() {
                  cancelled = true;
                },
              }),
              { status: 200, headers: { "content-type": "image/jpeg" } },
            ),
      sleep: async () => {},
      random: () => 0,
    });
    await expect(endless.returnPhoto("AB00001", "52", 4096)).rejects.toThrow(/larger than 4096 bytes/);
    expect(pulled).toBeLessThan(10);
    expect(cancelled).toBe(true);
    const notFound = await fhbClientForConnection(a, s.fhb.id, {
      fetchImpl: async (u) =>
        new URL(u).pathname.endsWith("/login")
          ? new Response(JSON.stringify({ token: "t", expiration: "2099-01-01T00:00:00+0000" }), {
              status: 200,
            })
          : new Response(JSON.stringify({ message: "Not found" }), { status: 404 }),
      sleep: async () => {},
      random: () => 0,
    });
    expect(await notFound.returnPhoto("AB00001", "99")).toBeNull();
    expect(acceptedImageType("image/PNG; charset=binary")).toBe("image/png");
    expect(acceptedImageType("image/svg+xml")).toBeNull();
  });
});
