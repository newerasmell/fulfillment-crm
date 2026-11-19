import { beforeAll, describe, expect, it } from "vitest";
import { systemDb, withAccountTransaction } from "@/server/db/client";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import { stockByConnection } from "@/server/routing/route";
import { crmReservations, reservationKey } from "@/server/stock/levels";
import {
  addWarehouseReply,
  CASE_TASK,
  markCustomerEmailed,
  markWarehouseEmailSent,
  orderCaseInfo,
  syncWarehouseCases,
  warehouseCasesView,
} from "./cases";
import { saveEscalationSettings } from "./settings";
import { FROZEN_UNITS, recordSkuIncident, skuWatchList, unlockSku } from "./sku";

// „Блокирани в склад“ (owner request 2026-11-18). Synthetic data only; a fixed Wednesday as "now".
describe("warehouse cases", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  const db = () => systemDb();
  const now = new Date("2026-11-18T15:00:00Z");
  let n = 0;

  beforeAll(async () => {
    g = await euTestGroup("cases");
    await saveEscalationSettings(g.owner, {
      companyId: g.company.id,
      senderEmail: "Company@Example.com",
      warehouseTo: "wh@example.com, ops@example.com",
      warehouseCc: "",
      escalationTo: "boss@example.com",
      flagHours: 12,
      firstEmailHours: 24,
      reminderHours: 48,
      decisionHours: 72,
      workDaysOnly: true,
      discountPercent: 15,
    });
  });

  async function shipment(submittedAt: Date, status: "ACCEPTED" | "PROCESSING" = "ACCEPTED") {
    const { order, product } = await euTestOrder(g, { number: `#WC${++n}` });
    await db().order.update({
      where: { id: order.id },
      data: { status: "ACCEPTED", email: "buyer@example.com" },
    });
    const line = await db().orderLine.findFirstOrThrow({ where: { orderId: order.id } });
    const f = await db().fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: order.id,
        connectionId: g.connection.id,
        externalId: `WC-${n}`,
        status,
        rawStatus: "Awaiting pickup",
        trackingNumbers: [`AWB${n}`],
        submittedAt,
        lines: { create: { orderLineId: line.id, quantity: 1 } },
      },
    });
    return { order, product, f };
  }
  const tasks = () =>
    db().alert.findMany({ where: { accountId: g.accountId, kind: CASE_TASK, status: { not: "RESOLVED" } } });

  it("settings: addresses cleaned and validated, hours must rise", async () => {
    const s = await db().companyEscalationSettings.findFirstOrThrow({ where: { companyId: g.company.id } });
    expect(s.senderEmail).toBe("company@example.com");
    expect(s.warehouseTo).toEqual(["wh@example.com", "ops@example.com"]);
    const bad = {
      companyId: g.company.id,
      flagHours: 12,
      firstEmailHours: 24,
      reminderHours: 48,
      decisionHours: 72,
      workDaysOnly: true,
    };
    await expect(saveEscalationSettings(g.owner, { ...bad, warehouseTo: "not-an-email" })).rejects.toThrow(
      /invalid_email/,
    );
    await expect(saveEscalationSettings(g.owner, { ...bad, reminderHours: 20 })).rejects.toThrow(
      /hours_order/,
    );
  });

  it("a stuck shipment opens a case and a task; marking the email sent clears the task until the next step", async () => {
    const a = await shipment(new Date("2026-11-17T09:00:00Z")); // 30 h on working days → level 1
    const fresh = await shipment(new Date("2026-11-18T08:00:00Z")); // 7 h → not stuck yet
    await syncWarehouseCases(g.accountId, now);
    const [c] = await warehouseCasesView(g.owner, now);
    expect(c?.orders.map((o) => o.number)).toEqual([a.order.number]);
    expect(c?.orders.map((o) => o.number)).not.toContain(fresh.order.number);
    expect(c).toMatchObject({ level: 1, suggested: 1, configured: true });
    expect(c!.orders[0]).toMatchObject({ hours: 30, ref: "WC-1", awb: "AWB1" });
    expect(c!.orders[0]!.deleteUntil?.toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(c!.emails[1].to).toEqual(["wh@example.com", "ops@example.com"]);
    expect(c!.emails[1].body).toContain("WC-1 | AWB AWB1");
    expect(c!.customerInputs[c!.orders[0]!.id]?.to).toBe("buyer@example.com");
    expect((await tasks())[0]?.title).toMatch(
      /Блокирани в склад .*1 поръчки, най-старата 30 ч — изпратете първи мейл/,
    );
    expect(await orderCaseInfo(g.accountId, a.order.id, now)).toMatchObject([{ hours: 30, level: 1 }]);

    await markWarehouseEmailSent(
      g.owner,
      {
        caseId: c!.id,
        level: 1,
        recipients: c!.emails[1].to,
        subject: c!.emails[1].subject,
        body: c!.emails[1].body,
        orderNumbers: [a.order.number],
      },
      now,
    );
    expect(await tasks()).toHaveLength(0);

    // A second, older shipment (since Sunday: Monday 00:00 → 63 working hours) joins the same case: level 2 is due.
    await shipment(new Date("2026-11-15T12:00:00Z"));
    await syncWarehouseCases(g.accountId, now);
    const [c2] = await warehouseCasesView(g.owner, now);
    expect(c2?.id).toBe(c!.id);
    expect(c2).toMatchObject({ level: 2, lastSentLevel: 1, suggested: 2, repliedSinceLast: false });
    expect(c2!.emails[2].subject).toMatch(
      /^SECOND NOTICE: 2 orders stuck for over 63 h, no reply since 18\.11\.2026/,
    );
    expect((await tasks())[0]?.title).toMatch(/изпратете напомняне/);
  });

  it("a reply that the warehouse has the goods unlocks the product; shipped shipments leave; an empty case closes", async () => {
    const [c] = await warehouseCasesView(g.owner, now);
    const open = c!.orders.filter((o) => !o.resolvedAt);
    // A product of the second shipment was held after an earlier no-stock cancel of another shipment.
    const older = await db().fulfillment.findFirstOrThrow({
      where: { externalId: "WC-3" },
      include: { lines: { include: { orderLine: true } } },
    });
    const productId = older.lines[0]!.orderLine.productId!;
    const other = await shipment(new Date("2026-11-18T14:00:00Z"));
    await db().orderLine.updateMany({ where: { orderId: other.order.id }, data: { productId } });
    await db().fulfillment.update({ where: { id: other.f.id }, data: { status: "CANCELLED" } });
    await withAccountTransaction(g.accountId, (tx) =>
      recordSkuIncident(tx, { accountId: g.accountId, fulfillmentId: other.f.id }),
    );
    expect((await skuWatchList(g.owner)).map((w) => w.productId)).toContain(productId);

    const r = await addWarehouseReply(g.owner, {
      caseId: c!.id,
      body: "We have it, it will ship today.",
      confirmedCaseOrderIds: open.filter((o) => o.ref === "WC-3").map((o) => o.id),
    });
    expect(r.unlocked).toBe(1);
    expect(await skuWatchList(g.owner)).toHaveLength(0);
    const [c2] = await warehouseCasesView(g.owner, now);
    expect(c2?.repliedSinceLast).toBe(true);
    expect(c2?.orders.find((o) => o.ref === "WC-3")?.warehouseConfirmedAt).toBeTruthy();

    const first = c2!.orders.find((o) => o.ref === "WC-1")!;
    await markCustomerEmailed(g.owner, {
      caseOrderId: first.id,
      recipients: ["buyer@example.com"],
      subject: "s",
      body: "b",
    });

    await db().fulfillment.updateMany({
      where: { externalId: { in: ["WC-1", "WC-3"] } },
      data: { status: "SHIPPED" },
    });
    await syncWarehouseCases(g.accountId, now);
    const [closed] = await warehouseCasesView(g.owner, now);
    expect(closed?.closedAt).toBeTruthy();
    expect(closed?.orders.map((o) => o.outcome)).toEqual(["shipped", "shipped"]);
    expect(closed?.orders.find((o) => o.ref === "WC-1")?.customerEmailedAt).toBeTruthy();
    expect(await tasks()).toHaveLength(0);
  });

  it("held units are kept out of what is sold and routed; two within 14 days freeze the product; unlock clears", async () => {
    const a = await shipment(new Date("2026-11-18T10:00:00Z"));
    const productId = (await db().orderLine.findFirstOrThrow({ where: { orderId: a.order.id } })).productId!;
    const vp = await db().vendorProduct.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        productId,
        vendorId: `ref-${productId}`,
        raw: {},
      },
    });
    await db().stockLevel.create({
      data: {
        accountId: g.accountId,
        vendorProductId: vp.id,
        physical: 5,
        free: 5,
        sellable: 5,
        snapshotAt: now,
        source: "POLL",
      },
    });
    await db().fulfillment.update({ where: { id: a.f.id }, data: { status: "CANCELLED" } });
    const lines = [{ productId, quantity: 5, title: "x" }];
    const conns = [
      {
        id: g.connection.id,
        name: "eu",
        type: "EUSHIPMENTS" as const,
        companyId: g.company.id,
        enabled: true,
      },
    ];
    const before = await crmReservations(g.accountId, [productId]);

    await withAccountTransaction(g.accountId, (tx) =>
      recordSkuIncident(tx, { accountId: g.accountId, fulfillmentId: a.f.id }),
    );
    // Idempotent per shipment.
    await withAccountTransaction(g.accountId, (tx) =>
      recordSkuIncident(tx, { accountId: g.accountId, fulfillmentId: a.f.id }),
    );
    const key = reservationKey(g.connection.id, productId);
    expect((await crmReservations(g.accountId, [productId])).get(key)).toBe((before.get(key) ?? 0) + 1);
    expect((await stockByConnection(g.accountId, conns, lines)).get(g.connection.id)?.status).not.toBe("ok");

    const b = await shipment(new Date("2026-11-18T11:00:00Z"));
    await db().orderLine.updateMany({ where: { orderId: b.order.id }, data: { productId } });
    await db().fulfillment.update({ where: { id: b.f.id }, data: { status: "CANCELLED" } });
    await withAccountTransaction(g.accountId, (tx) =>
      recordSkuIncident(tx, { accountId: g.accountId, fulfillmentId: b.f.id }),
    );
    expect((await crmReservations(g.accountId, [productId])).get(key)).toBeGreaterThanOrEqual(FROZEN_UNITS);
    expect((await skuWatchList(g.owner)).find((w) => w.productId === productId)).toMatchObject({
      frozen: true,
      units: 2,
    });

    await unlockSku(g.owner, { connectionId: g.connection.id, productId, note: "stock counted" });
    expect((await crmReservations(g.accountId, [productId])).get(key) ?? 0).toBe(before.get(key) ?? 0);
    await expect(
      unlockSku(g.owner, { connectionId: g.connection.id, productId, note: "again" }),
    ).rejects.toThrow(/not_found/);
  });

  it("FHB: a cancel there invents no unit, so nothing is held", async () => {
    const fhb = await db().fulfillmentConnection.create({
      data: {
        accountId: g.accountId,
        companyId: g.company.id,
        type: "FHB_V3",
        name: "FHB",
        liveMode: "LIVE",
      },
    });
    const s = await shipment(new Date("2026-11-18T10:00:00Z"));
    await db().fulfillment.update({
      where: { id: s.f.id },
      data: { connectionId: fhb.id, status: "CANCELLED" },
    });
    expect(
      await withAccountTransaction(g.accountId, (tx) =>
        recordSkuIncident(tx, { accountId: g.accountId, fulfillmentId: s.f.id }),
      ),
    ).toBe(0);
  });

  describe("after the audit", () => {
    const later = new Date("2026-11-18T16:00:00Z");
    const caseOf = async (number: string) =>
      (await warehouseCasesView(g.owner, later)).find(
        (c) => !c.closedAt && c.orders.some((o) => o.number === number),
      );
    // Every earlier shipment leaves (its case closes), so each test starts with no open case.
    const reset = async () => {
      await db().fulfillment.updateMany({
        where: { accountId: g.accountId, status: { in: ["ACCEPTED", "PROCESSING"] } },
        data: { status: "SHIPPED" },
      });
      await syncWarehouseCases(g.accountId, later);
    };
    const row = async (number: string) => (await caseOf(number))?.orders.find((o) => o.number === number);

    it("an order paused (ON_HOLD) stays in its case; back in ACCEPTED it is still there", async () => {
      const a = await shipment(new Date("2026-11-17T09:00:00Z"));
      await syncWarehouseCases(g.accountId, later);
      await db().order.update({ where: { id: a.order.id }, data: { status: "ON_HOLD" } });
      await syncWarehouseCases(g.accountId, later);
      expect((await row(a.order.number))?.resolvedAt).toBeNull();
      await db().order.update({ where: { id: a.order.id }, data: { status: "ACCEPTED" } });
      await syncWarehouseCases(g.accountId, later);
      expect((await row(a.order.number))?.resolvedAt).toBeNull();
      // Settled by the shipment itself: euShipments PROCESSING (Packed …) is no longer "not handed over".
      await db().fulfillment.update({ where: { id: a.f.id }, data: { status: "PROCESSING" } });
      await syncWarehouseCases(g.accountId, later);
      expect(await row(a.order.number)).toBeUndefined();
      expect(
        (await db().warehouseCaseOrder.findFirstOrThrow({ where: { fulfillmentId: a.f.id } })).outcome,
      ).toBe("other");
    });

    it("a stuck shipment that left the case and is stuck again comes back into the open case", async () => {
      const a = await shipment(new Date("2026-11-17T09:00:00Z"));
      const keep = await shipment(new Date("2026-11-17T09:00:00Z"));
      await syncWarehouseCases(g.accountId, later);
      await db().order.update({ where: { id: a.order.id }, data: { status: "CANCELLED" } });
      await syncWarehouseCases(g.accountId, later);
      expect((await row(keep.order.number))?.resolvedAt).toBeNull();
      expect((await row(a.order.number))?.resolvedAt).toBeTruthy();
      await db().order.update({ where: { id: a.order.id }, data: { status: "ACCEPTED" } });
      await syncWarehouseCases(g.accountId, later);
      expect((await row(a.order.number))?.resolvedAt).toBeNull();
    });

    it("a reply cannot confirm a settled shipment; a closed case takes no more warehouse emails", async () => {
      await reset();
      const a = await shipment(new Date("2026-11-17T09:00:00Z"));
      const b = await shipment(new Date("2026-11-17T09:00:00Z"));
      await syncWarehouseCases(g.accountId, later);
      const c = (await caseOf(a.order.number))!;
      await db().fulfillment.update({ where: { id: a.f.id }, data: { status: "SHIPPED" } });
      await syncWarehouseCases(g.accountId, later);
      const settled = (await db().warehouseCaseOrder.findFirstOrThrow({ where: { fulfillmentId: a.f.id } }))
        .id;
      await expect(
        addWarehouseReply(g.owner, { caseId: c.id, body: "ok", confirmedCaseOrderIds: [settled] }),
      ).rejects.toThrow(/not_found/);
      await db().fulfillment.update({ where: { id: b.f.id }, data: { status: "SHIPPED" } });
      await syncWarehouseCases(g.accountId, later);
      const sent = {
        caseId: c.id,
        level: 1 as const,
        recipients: [],
        subject: "s",
        body: "b",
        orderNumbers: [],
      };
      await expect(markWarehouseEmailSent(g.owner, sent)).rejects.toThrow(/case_closed/);
    });

    it("two syncs at once: one case, one task; a task closed by hand is not opened again for the same email", async () => {
      await reset();
      await shipment(new Date("2026-11-17T09:00:00Z"));
      await Promise.all([syncWarehouseCases(g.accountId, later), syncWarehouseCases(g.accountId, later)]);
      expect(await db().warehouseCase.count({ where: { accountId: g.accountId, closedAt: null } })).toBe(1);
      const open = await tasks();
      expect(open).toHaveLength(1);
      await db().alert.update({
        where: { id: open[0]!.id },
        data: { status: "RESOLVED", resolvedAt: later },
      });
      await syncWarehouseCases(g.accountId, later);
      expect(await tasks()).toHaveLength(0);
    });

    it("a member of another company sees neither the case, its customers nor the held items, and cannot unlock", async () => {
      const other = await db().company.create({ data: { accountId: g.accountId, name: "Other company" } });
      const outsider = { ...g.owner, role: "OPERATOR" as const, companyScope: [other.id] };
      const a = await shipment(new Date("2026-11-17T09:00:00Z"));
      await db().fulfillment.update({ where: { id: a.f.id }, data: { status: "CANCELLED" } });
      await withAccountTransaction(g.accountId, (tx) =>
        recordSkuIncident(tx, { accountId: g.accountId, fulfillmentId: a.f.id }),
      );
      const productId = (await db().orderLine.findFirstOrThrow({ where: { orderId: a.order.id } }))
        .productId!;
      expect(await warehouseCasesView(outsider, later)).toHaveLength(0);
      expect(await skuWatchList(outsider)).toHaveLength(0);
      await expect(
        unlockSku(outsider, { connectionId: g.connection.id, productId, note: "not mine" }),
      ).rejects.toThrow(/not_found/);
      // A viewer of the company sees the case but no customer data.
      const viewer = { ...g.owner, role: "VIEWER" as const };
      const b = await shipment(new Date("2026-11-17T09:00:00Z"));
      await syncWarehouseCases(g.accountId, later);
      const c = (await warehouseCasesView(viewer, later)).find((x) =>
        x.orders.some((o) => o.number === b.order.number),
      );
      expect(c?.orders.find((o) => o.number === b.order.number)?.customer).toBeNull();
      expect(Object.keys(c?.customerInputs ?? {})).toHaveLength(0);
      // Nor the customer emails of the case (their address and text).
      const caseOrderId = (
        await db().warehouseCaseOrder.findFirstOrThrow({ where: { fulfillmentId: b.f.id } })
      ).id;
      await markCustomerEmailed(g.owner, {
        caseOrderId,
        recipients: ["buyer@example.com"],
        subject: "Test Buyer, your order is delayed",
        body: "Hello Test Buyer",
      });
      const seen = (await warehouseCasesView(viewer, later))
        .flatMap((x) => x.messages)
        .filter((m) => m.kind === "customer");
      expect(seen.length).toBeGreaterThan(0);
      expect(
        seen.every((m) => m.recipients.length === 0 && m.body === "" && !m.subject.includes("Test Buyer")),
      ).toBe(true);
      const ownerSees = (await warehouseCasesView(g.owner, later)).flatMap((x) => x.messages);
      expect(ownerSees.some((m) => m.recipients.includes("buyer@example.com"))).toBe(true);
      await expect(
        markCustomerEmailed(outsider, { caseOrderId, recipients: [], subject: "s", body: "b" }),
      ).rejects.toThrow(/not_found/);
      await unlockSku(g.owner, { connectionId: g.connection.id, productId, note: "cleanup" });
    });
  });
});
