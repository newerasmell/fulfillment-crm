import { beforeAll, describe, expect, it, vi } from "vitest";
import examples from "@/integrations/fhb-v3/__fixtures__/openapi-examples.json";
import type { FetchLike } from "@/integrations/fhb-v3/client";
import { writeCsv } from "@/lib/xlsx";
import type { Actor } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { systemDb } from "@/server/db/client";
import { fhbOrderNotificationUrls } from "@/server/fhb/callback-token";
import { processFhbCallback, receiveFhbCallback } from "@/server/fhb/callbacks";
import { createFhbConnection } from "@/server/fhb/connection";
import {
  countOpenTickets,
  listTickets,
  markTicketReviewed,
  recordFhbTicketEvent,
  TICKET_ALERT_KIND,
} from "@/server/tickets";
import {
  ageDays,
  exportShipmentsCsv,
  getShipment,
  getShipmentSettings,
  listShipments,
  parseShipmentFilter,
  shipmentFilterOptions,
  statusGroup,
  trackingLinks,
  updateShipmentSettings,
} from "./board";
import { globalSearch } from "./search";

// Synthetic data only. No vendor is called: the board reads local tables; the one callback test uses a mocked
// FHB answering with the vendor's documentation example. Every test works in its own new account.

const DAY = 86_400_000;
const NOW = new Date("2026-11-03T10:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const ex = examples as unknown as Record<string, Record<string, unknown>>;

beforeAll(() => {
  process.env.APP_URL = "https://crm.example.test";
});

describe("pure helpers", () => {
  it("groups statuses into the board's tabs", () => {
    expect(statusGroup("QUEUED")).toBe("preparing");
    expect(statusGroup("ACCEPTED")).toBe("preparing");
    expect(statusGroup("SHIPPED")).toBe("shipped");
    expect(statusGroup("COD_PAID")).toBe("delivered");
    expect(statusGroup("RETURN_RECEIVED")).toBe("returning");
    expect(statusGroup("UNKNOWN")).toBe("problem");
    expect(statusGroup("SUBMIT_FAILED")).toBe("problem");
    expect(statusGroup("CANCELLED")).toBe("cancelled");
  });

  it("pairs tracking numbers with links only when the vendor gave one per number; never a non-http link", () => {
    expect(trackingLinks(["A1"], ["https://track.example/A1"])).toEqual({
      items: [{ number: "A1", url: "https://track.example/A1" }],
      extraUrls: [],
    });
    expect(trackingLinks(["A1"], ["javascript:alert(1)"]).items[0]!.url).toBeNull();
    expect(trackingLinks(["A1", "A2"], ["https://track.example/x"])).toEqual({
      items: [
        { number: "A1", url: null },
        { number: "A2", url: null },
      ],
      extraUrls: ["https://track.example/x"],
    });
  });

  it("age: until delivery, until now, or until cancellation", () => {
    const base = { createdAt: ago(10), submittedAt: ago(9), deliveredAt: null, updatedAt: ago(5) };
    expect(ageDays({ ...base, status: "SHIPPED" }, NOW)).toBe(9);
    expect(ageDays({ ...base, deliveredAt: ago(6), status: "DELIVERED" }, NOW)).toBe(3);
    expect(ageDays({ ...base, status: "CANCELLED" }, NOW)).toBe(4);
  });

  it("drops malformed URL parameters", () => {
    expect(
      parseShipmentFilter({ tab: "delayed", from: "2026-13-45", to: "2026-11-01", page: "-3", q: "  x " }),
    ).toEqual({
      view: "delayed",
      connectionId: undefined,
      carrier: undefined,
      from: undefined,
      to: "2026-11-01",
      q: "x",
      page: 1,
    });
    expect(parseShipmentFilter({ tab: "nope" }).view).toBeUndefined();
  });
});

let seq = 0;
async function seed() {
  const sys = systemDb();
  const account = await sys.account.create({ data: { name: `Shipments ${++seq}` } });
  const accountId = account.id;
  const coA = await sys.company.create({ data: { accountId, name: "Фирма А" } });
  const coB = await sys.company.create({ data: { accountId, name: "Фирма Б" } });
  const owner: Actor & { companyScope: null } = {
    userId: "u-owner",
    accountId,
    role: "OWNER",
    companyScope: null,
  };
  const fhb = await createFhbConnection(owner, {
    companyId: coA.id,
    name: "FHB тест",
    appId: "test-app",
    secret: "test-secret",
  });
  const eu = await sys.fulfillmentConnection.create({
    data: { accountId, companyId: coB.id, name: "euShipments тест", type: "EUSHIPMENTS" },
  });
  await sys.fhbCarrier.create({
    data: { accountId, connectionId: fhb.id, code: "gls", name: "GLS", lastSyncAt: NOW },
  });
  await sys.eushipmentsCourier.create({
    data: { accountId, connectionId: eu.id, courierId: 7, name: "Speedy", syncedAt: NOW },
  });
  let n = 0;
  const ship = async (o: {
    companyId: string;
    connectionId: string;
    status: Parameters<typeof statusGroup>[0];
    carrier?: string;
    tracking?: string[];
    urls?: string[];
    shippedDaysAgo?: number;
    createdDaysAgo?: number;
    customer?: string;
    phone?: string;
    cod?: number;
  }) => {
    n++;
    const order = await sys.order.create({
      data: {
        accountId,
        companyId: o.companyId,
        source: "MANUAL",
        number: `#SH-${1000 + n}`,
        currency: "EUR",
        subtotal: "10.00",
        total: "10.00",
        paymentMethod: o.cod ? "COD" : "PREPAID",
        codAmount: o.cod ? String(o.cod) : null,
        codLocalAmount: o.cod ? String(o.cod * 4) : null,
        codLocalCurrency: o.cod ? "RON" : null,
        customerName: o.customer ?? `Клиент ${n}`,
        phone: o.phone ?? null,
        placedAt: ago(o.createdDaysAgo ?? 1),
      },
    });
    return sys.fulfillment.create({
      data: {
        accountId,
        orderId: order.id,
        connectionId: o.connectionId,
        externalId: `SH-${1000 + n}`,
        status: o.status,
        rawStatus: `raw-${o.status.toLowerCase()}`,
        carrier: o.carrier ?? null,
        trackingNumbers: o.tracking ?? [],
        trackingUrls: o.urls ?? [],
        createdAt: ago(o.createdDaysAgo ?? 1),
        shippedAt: o.shippedDaysAgo == null ? null : ago(o.shippedDaysAgo),
      },
    });
  };
  const s = {
    queued: await ship({ companyId: coA.id, connectionId: fhb.id, status: "QUEUED" }),
    shippedNew: await ship({
      companyId: coA.id,
      connectionId: fhb.id,
      status: "SHIPPED",
      carrier: "gls",
      tracking: ["GLS123"],
      urls: ["https://gls.example/GLS123"],
      shippedDaysAgo: 2,
      createdDaysAgo: 3,
      customer: "Мария Синтетична",
      phone: "+40712345678",
      cod: 25,
    }),
    shippedOld: await ship({
      companyId: coB.id,
      connectionId: eu.id,
      status: "SHIPPED",
      carrier: "7",
      tracking: ["SPD999"],
      shippedDaysAgo: 12,
      createdDaysAgo: 13,
    }),
    delivered: await ship({
      companyId: coB.id,
      connectionId: eu.id,
      status: "DELIVERED",
      createdDaysAgo: 20,
    }),
    returning: await ship({ companyId: coA.id, connectionId: fhb.id, status: "RETURNING" }),
    unknown: await ship({ companyId: coA.id, connectionId: fhb.id, status: "UNKNOWN" }),
    cancelled: await ship({ companyId: coA.id, connectionId: fhb.id, status: "CANCELLED" }),
  };
  const restricted = { ...owner, userId: "u-op", role: "OPERATOR" as const, companyScope: [coB.id] };
  return { accountId, coA, coB, fhb, eu, owner, restricted, s };
}

describe("shipments board", () => {
  it("counts per tab, the delayed chip and paging", async () => {
    const d = await seed();
    const r = await listShipments(d.owner, {}, NOW);
    expect(r.counts).toEqual({
      preparing: 1,
      shipped: 2,
      delivered: 1,
      returning: 1,
      problem: 1,
      cancelled: 1,
      all: 7,
      delayed: 1,
    });
    expect(r.total).toBe(7);
    expect(r.pages).toBe(1);
    const delayed = await listShipments(d.owner, { view: "delayed" }, NOW);
    expect(delayed.rows.map((x) => x.id)).toEqual([d.s.shippedOld.id]);
    expect(delayed.rows[0]).toMatchObject({ delayed: true, carrierName: "Speedy", ageDays: 13 });
    // A longer threshold: nothing is delayed any more.
    await updateShipmentSettings(d.owner, { delayedDays: 20 });
    expect((await getShipmentSettings(d.accountId)).delayedDays).toBe(20);
    expect((await listShipments(d.owner, {}, NOW)).counts.delayed).toBe(0);
    const audit = await systemDb().auditLog.findFirst({
      where: { accountId: d.accountId, action: "shipments.settings" },
    });
    expect(audit?.after).toEqual({ delayedDays: 20 });
    await expect(updateShipmentSettings(d.restricted, { delayedDays: 3 })).rejects.toThrow(ForbiddenError);
    await expect(updateShipmentSettings(d.owner, { delayedDays: 0 })).rejects.toThrow();
  });

  it("row view: carrier names, tracking links, local-currency COD, raw status", async () => {
    const d = await seed();
    const r = await listShipments(d.owner, { view: "shipped" }, NOW);
    const row = r.rows.find((x) => x.id === d.s.shippedNew.id)!;
    expect(row).toMatchObject({
      carrierName: "GLS",
      rawStatus: "raw-shipped",
      cod: { amount: 100, currency: "RON" },
      tracking: { items: [{ number: "GLS123", url: "https://gls.example/GLS123" }] },
      connection: { type: "FHB_V3" },
      company: { name: "Фирма А" },
      delayed: false,
    });
  });

  it("filters: warehouse, carrier, header scope, dates, search by order / tracking / customer / phone", async () => {
    const d = await seed();
    const ids = async (f: Parameters<typeof listShipments>[1]) =>
      (await listShipments(d.owner, f, NOW)).rows.map((x) => x.id).sort();
    expect(await ids({ connectionId: d.eu.id })).toEqual([d.s.shippedOld.id, d.s.delivered.id].sort());
    expect(await ids({ carrier: "gls" })).toEqual([d.s.shippedNew.id]);
    expect(await ids({ connectionTypes: ["EUSHIPMENTS"] })).toHaveLength(2);
    expect(
      await ids({ from: ago(14).toISOString().slice(0, 10), to: ago(10).toISOString().slice(0, 10) }),
    ).toEqual([d.s.shippedOld.id]);
    expect(await ids({ q: "SPD999" })).toEqual([d.s.shippedOld.id]);
    expect(await ids({ q: "gls123" })).toEqual([d.s.shippedNew.id]);
    expect(await ids({ q: "синтетична" })).toEqual([d.s.shippedNew.id]);
    expect(await ids({ q: "712 345" })).toEqual([d.s.shippedNew.id]);
    expect(await ids({ q: "SH-1001" })).toContain(d.s.queued.id);
    const opts = await shipmentFilterOptions(d.owner);
    expect(opts.connections.map((c) => c.name).sort()).toEqual(["FHB тест", "euShipments тест"]);
    expect(opts.carriers).toEqual([
      { code: "gls", label: "GLS" },
      { code: "7", label: "Speedy" },
    ]);
  });

  it("a restricted member sees only shipments of their companies (also in detail, CSV and search)", async () => {
    const d = await seed();
    const r = await listShipments(d.restricted, {}, NOW);
    expect(r.counts.all).toBe(2);
    expect(r.rows.every((x) => x.company?.name === "Фирма Б")).toBe(true);
    await expect(getShipment(d.restricted, d.s.shippedNew.id, NOW)).rejects.toThrow("not_found");
    expect((await getShipment(d.restricted, d.s.shippedOld.id, NOW)).externalId).toBe(
      d.s.shippedOld.externalId,
    );
    const csv = await exportShipmentsCsv(d.restricted, {}, { withCod: true }, NOW);
    expect(csv).toHaveLength(3);
    expect((await globalSearch(d.restricted, "GLS123")).shipments).toHaveLength(0);
    expect((await globalSearch(d.owner, "GLS123")).shipments.map((s) => s.id)).toEqual([d.s.shippedNew.id]);
    expect((await globalSearch(d.owner, "Мария")).orders).toHaveLength(1);
    // Another account never sees these.
    const other = await seed();
    expect((await globalSearch(other.owner, "GLS123")).shipments.map((s) => s.id)).toEqual([
      other.s.shippedNew.id,
    ]);
  });

  it("CSV: every row of the filter, COD only for roles that may see it, formula cells neutralised", async () => {
    const d = await seed();
    await systemDb().order.update({
      where: { id: d.s.queued.orderId },
      data: { customerName: '=HYPERLINK("http://evil.example")' },
    });
    const rows = await exportShipmentsCsv(d.owner, {}, { withCod: true }, NOW);
    expect(rows[0]).toContain("cod");
    expect(rows).toHaveLength(8);
    const text = writeCsv(rows);
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    const viewer = { ...d.owner, role: "VIEWER" as const };
    await expect(exportShipmentsCsv(viewer, {}, { withCod: true }, NOW)).rejects.toThrow(ForbiddenError);
    expect((await exportShipmentsCsv(viewer, {}, { withCod: false }, NOW))[0]).not.toContain("cod");
  });
});

describe("FHB ticket notifications", () => {
  it("are stored idempotently per shipment, raise one alert on ticket_created and resolve it on close", async () => {
    const d = await seed();
    const sys = systemDb();
    const f = d.s.shippedNew;
    const ev = async (topic: string, at: Date) =>
      sys.webhookEvent.create({
        data: {
          accountId: d.accountId,
          source: "FHB",
          dedupeKey: `t-${Math.random()}`,
          topic,
          payload: { fulfillmentId: f.id },
          receivedAt: at,
        },
      });
    const e1 = await ev("order.ticket_created", ago(3));
    const r1 = await recordFhbTicketEvent(d.accountId, {
      fulfillmentId: f.id,
      webhookEventId: e1.id,
      event: "ticket_created",
      receivedAt: ago(3),
    });
    expect(r1.recorded).toBe(true);
    // The same stored callback again (a retried job): nothing changes.
    expect(
      (
        await recordFhbTicketEvent(d.accountId, {
          fulfillmentId: f.id,
          webhookEventId: e1.id,
          event: "ticket_created",
          receivedAt: ago(3),
        })
      ).recorded,
    ).toBe(false);
    const alerts = () =>
      sys.alert.findMany({ where: { accountId: d.accountId, kind: TICKET_ALERT_KIND, entityId: f.id } });
    expect(await alerts()).toHaveLength(1);
    expect((await alerts())[0]).toMatchObject({ status: "OPEN", isTask: true });

    const e2 = await ev("order.ticket_updated", ago(1));
    await recordFhbTicketEvent(d.accountId, {
      fulfillmentId: f.id,
      webhookEventId: e2.id,
      event: "ticket_updated",
      receivedAt: ago(1),
    });
    // A late, older event is counted but does not change the state.
    const e0 = await ev("order.ticket_created", ago(4));
    await recordFhbTicketEvent(d.accountId, {
      fulfillmentId: f.id,
      webhookEventId: e0.id,
      event: "ticket_created",
      receivedAt: ago(4),
    });
    let t = await sys.fhbTicket.findFirstOrThrow({ where: { accountId: d.accountId, fulfillmentId: f.id } });
    expect(t).toMatchObject({ state: "UPDATED", eventCount: 3, firstEventAt: ago(4), lastEventAt: ago(1) });
    expect(await alerts()).toHaveLength(1);
    expect(await countOpenTickets(d.owner)).toBe(1);

    const e3 = await ev("order.ticket_closed", ago(0.5));
    await recordFhbTicketEvent(d.accountId, {
      fulfillmentId: f.id,
      webhookEventId: e3.id,
      event: "ticket_closed",
      receivedAt: ago(0.5),
    });
    t = await sys.fhbTicket.findFirstOrThrow({ where: { id: t.id } });
    expect(t).toMatchObject({ state: "CLOSED", eventCount: 4, closedAt: ago(0.5) });
    expect((await alerts())[0]).toMatchObject({ status: "RESOLVED" });
    expect(await countOpenTickets(d.owner)).toBe(0);
  });

  it("the FHB callback route stores ticket events, then re-reads the order", async () => {
    const d = await seed();
    const f = d.s.shippedNew;
    const url = fhbOrderNotificationUrls(d.fhb.id, f.id).ticket_created;
    const rec = (await receiveFhbCallback(new URL(url).pathname.split("/").slice(4), "")) as {
      eventId: string;
    };
    const calls: string[] = [];
    const fetchImpl = vi.fn<FetchLike>(async (u) => {
      const p = new URL(u);
      if (p.pathname === "/v3/login")
        return new Response(JSON.stringify({ token: "t", expiration: null }), { status: 200 });
      calls.push(p.pathname);
      return new Response(
        JSON.stringify({
          ...ex["GET /order 200 response"],
          id: p.searchParams.get("id"),
          status: "sent",
          tracking_numbers: ["GLS123"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const opts = { fetchImpl, sleep: async () => {} };
    expect(await processFhbCallback(d.accountId, rec.eventId, opts)).toBe("PROCESSED");
    expect(calls).toEqual(["/v3/order"]);
    const t = await systemDb().fhbTicket.findFirstOrThrow({
      where: { accountId: d.accountId, fulfillmentId: f.id },
    });
    expect(t).toMatchObject({ state: "OPEN", eventCount: 1 });
    // The board shows it, with the shipment, the company and an alert waiting.
    const board = await listTickets(d.owner, {}, NOW);
    expect(board.counts).toMatchObject({ open: 1, unreviewed: 1, closed: 0, all: 1 });
    expect(board.rows[0]).toMatchObject({
      state: "OPEN",
      reviewed: false,
      shipment: { externalId: f.externalId },
      company: { name: "Фирма А" },
      connection: { type: "FHB_V3" },
    });
    // Restricted to Фирма Б: not visible.
    expect((await listTickets(d.restricted, {}, NOW)).counts.all).toBe(0);
  });

  it("'прегледан' needs a note, is audited, resolves the alert and respects the company scope", async () => {
    const d = await seed();
    const sys = systemDb();
    const f = d.s.shippedNew;
    const e = await sys.webhookEvent.create({
      data: {
        accountId: d.accountId,
        source: "FHB",
        dedupeKey: `r-${Math.random()}`,
        topic: "order.ticket_created",
        payload: {},
      },
    });
    const { ticketId } = await recordFhbTicketEvent(d.accountId, {
      fulfillmentId: f.id,
      webhookEventId: e.id,
      event: "ticket_created",
      receivedAt: ago(1),
    });
    await expect(markTicketReviewed(d.owner, ticketId, " ")).rejects.toThrow();
    await expect(markTicketReviewed(d.restricted, ticketId, "видях го")).rejects.toThrow("not_found");
    await expect(markTicketReviewed({ ...d.owner, role: "VIEWER" }, ticketId, "видях го")).rejects.toThrow(
      ForbiddenError,
    );
    await markTicketReviewed(d.owner, ticketId, "Отговорено в ZOE");
    const board = await listTickets(d.owner, { tab: "all" }, NOW);
    expect(board.rows[0]).toMatchObject({ reviewed: true, reviewNote: "Отговорено в ZOE" });
    expect(board.counts.unreviewed).toBe(0);
    expect(await countOpenTickets(d.owner)).toBe(0);
    const alert = await sys.alert.findFirstOrThrow({
      where: { accountId: d.accountId, kind: TICKET_ALERT_KIND, entityId: f.id },
    });
    expect(alert.status).toBe("RESOLVED");
    const audit = await sys.auditLog.findFirstOrThrow({
      where: { accountId: d.accountId, action: "ticket.reviewed" },
    });
    expect(audit.after).toMatchObject({ note: "Отговорено в ZOE", shipment: f.externalId });
    // A newer event after the review → unreviewed again.
    const e2 = await sys.webhookEvent.create({
      data: {
        accountId: d.accountId,
        source: "FHB",
        dedupeKey: `r2-${Math.random()}`,
        topic: "order.ticket_updated",
        payload: {},
      },
    });
    await recordFhbTicketEvent(d.accountId, {
      fulfillmentId: f.id,
      webhookEventId: e2.id,
      event: "ticket_updated",
      receivedAt: new Date(Date.now() + 1000),
    });
    expect(await countOpenTickets(d.owner)).toBe(1);
  });
});
