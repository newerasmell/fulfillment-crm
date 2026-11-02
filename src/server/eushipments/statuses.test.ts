import { beforeAll, describe, expect, it } from "vitest";
import type { HistoryItem } from "@/integrations/eushipments/schemas";
import { accountDb } from "@/server/db/client";
import { applyOrderHistory, ensureStatusMapSeeded, setStatusMapping } from "./statuses";
import { euTestGroup, euTestOrder } from "./test-fixtures";

const rec = (id: number, status: string, date: string, comment: string | null = null) => ({
  ID: id,
  STATUS: status,
  DATE: date,
  DATE_CREATED: date,
  COMMENT: comment,
  PARTNER_VOUCHER: null,
});
const item = (records: ReturnType<typeof rec>[], awb: string | null = null): HistoryItem => ({
  refNum: "TST-1001",
  awb,
  error: null,
  errorCode: null,
  statusesHistory: records,
  items: [],
});

describe("euShipments status tracking (DB)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let other: Awaited<ReturnType<typeof euTestGroup>>;
  const newFulfillment = async (n: string) => {
    const { order } = await euTestOrder(g, { number: n });
    return g.db.fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: order.id,
        connectionId: g.connection.id,
        externalId: `TST-${n}`,
        status: "ACCEPTED",
      },
    });
  };
  const alerts = (fulfillmentId: string) =>
    g.db.alert.findMany({ where: { entityType: "Fulfillment", entityId: fulfillmentId } });

  beforeAll(async () => {
    g = await euTestGroup("status");
    other = await euTestGroup("status-other");
  });

  it("seeds the mapping table once per group, scoped by account", async () => {
    expect(await ensureStatusMapSeeded(g.accountId)).toBeGreaterThan(80);
    expect(await ensureStatusMapSeeded(g.accountId)).toBe(0);
    expect(await accountDb(other.accountId).eushipmentsStatusMapping.count()).toBe(0);
  });

  it("applies the latest status, stores each record once, alerts BLOCKED immediately (Cyrillic О)", async () => {
    const f = await newFulfillment("2001");
    const answer = item([
      rec(11, "Information received", "2026-11-02 08:00:00"),
      rec(12, "Оn hold", "2026-11-02 09:00:00", "Задържана"),
    ]);
    const now = new Date("2026-11-02T08:00:00Z");
    const r = await applyOrderHistory(g.accountId, f.id, answer, now);
    expect(r).toMatchObject({ category: "BLOCKED", status: "BLOCKED", newEvents: 2, alerts: ["blocked"] });
    const again = await applyOrderHistory(g.accountId, f.id, answer, now);
    expect(again).toMatchObject({ newEvents: 0, alerts: [] });
    expect(await g.db.fulfillmentEvent.count({ where: { fulfillmentId: f.id } })).toBe(2);
    const a = await alerts(f.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: "eushipments_blocked", severity: "CRITICAL", isTask: true });
    // Other groups see nothing.
    expect(await accountDb(other.accountId).fulfillmentEvent.count()).toBe(0);
  });

  it("an old BLOCKED that has moved on does not alert; transit sets SHIPPED + AWB", async () => {
    const f = await newFulfillment("2002");
    const r = await applyOrderHistory(
      g.accountId,
      f.id,
      item(
        [
          rec(21, "Stockout", "2026-11-01 08:00:00"),
          rec(22, "Packed", "2026-11-01 12:00:00"),
          rec(23, "Loaded hub Sofia (BG)", "2026-11-01 18:00:00"),
        ],
        "00000000009",
      ),
    );
    expect(r).toMatchObject({ category: "IN_TRANSIT", status: "SHIPPED", alerts: [], stopPolling: false });
    const row = await g.db.fulfillment.findUniqueOrThrow({ where: { id: f.id } });
    expect(row.trackingNumbers).toEqual(["00000000009"]);
    expect(row.shippedAt).not.toBeNull();
    expect(row.rawStatus).toBe("Loaded hub Sofia (BG)");
  });

  it("return received notifies support and stops polling; Returned keeps polling", async () => {
    const f = await newFulfillment("2003");
    const r1 = await applyOrderHistory(g.accountId, f.id, item([rec(31, "Returned", "2026-11-01 08:00:00")]));
    expect(r1).toMatchObject({ status: "RETURNING", stopPolling: false, alerts: [] });
    const r2 = await applyOrderHistory(
      g.accountId,
      f.id,
      item([
        rec(31, "Returned", "2026-11-01 08:00:00"),
        rec(32, "Product returned to stock", "2026-11-02 08:00:00"),
      ]),
    );
    expect(r2).toMatchObject({ status: "RETURN_RECEIVED", stopPolling: true, alerts: ["return_received"] });
  });

  it("unknown text → UNKNOWN + alert + an unconfirmed mapping row; an operator mapping fixes it", async () => {
    const f = await newFulfillment("2004");
    const r = await applyOrderHistory(
      g.accountId,
      f.id,
      item([rec(41, "Teleported", "2026-11-01 08:00:00")]),
    );
    expect(r).toMatchObject({ category: "UNKNOWN", status: "UNKNOWN", alerts: ["unknown_status"] });
    const row = await g.db.eushipmentsStatusMapping.findFirstOrThrow({ where: { statusKey: "teleported" } });
    expect(row).toMatchObject({ confirmed: false, source: "observed", category: "UNKNOWN" });
    await setStatusMapping(g.accountId, { statusText: "Teleported", category: "IN_TRANSIT", final: false });
    const f2 = await newFulfillment("2005");
    expect(
      await applyOrderHistory(g.accountId, f2.id, item([rec(42, "TELEPORTED", "2026-11-01 08:00:00")])),
    ).toMatchObject({ category: "IN_TRANSIT", status: "SHIPPED", alerts: [] });
  });

  it("Cancel (not final) keeps the previous status and keeps polling", async () => {
    const f = await newFulfillment("2006");
    const r = await applyOrderHistory(g.accountId, f.id, item([rec(51, "Cancel", "2026-11-01 08:00:00")]));
    expect(r).toMatchObject({ category: "CANCEL_PENDING", status: "ACCEPTED", stopPolling: false });
  });

  it("raises one 'stuck in Information received' task after the working-day threshold", async () => {
    const f = await newFulfillment("2007");
    const answer = item([
      rec(61, "New", "2026-10-30 10:00:00"), // Friday, Sofia time
      rec(62, "Information received", "2026-10-30 11:00:00"),
    ]);
    const early = await applyOrderHistory(g.accountId, f.id, answer, new Date("2026-11-02T06:00:00Z"));
    expect(early.alerts).toEqual([]);
    const late = await applyOrderHistory(g.accountId, f.id, answer, new Date("2026-11-02T09:00:00Z"));
    expect(late.alerts).toEqual(["stuck_accepted"]);
    const again = await applyOrderHistory(g.accountId, f.id, answer, new Date("2026-11-03T09:00:00Z"));
    expect(again.alerts).toEqual([]);
    await g.db.eushipmentsSettings.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        acceptedAlertHours: 200,
        acceptedAlertWorkDays: false,
      },
    });
    const f2 = await newFulfillment("2008");
    expect(
      (await applyOrderHistory(g.accountId, f2.id, answer, new Date("2026-11-03T09:00:00Z"))).alerts,
    ).toEqual([]);
  });
});
