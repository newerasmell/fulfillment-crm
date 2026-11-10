import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapOwner } from "@/server/auth/users";
import { accountDb, systemDb } from "@/server/db/client";
import { createCompany } from "@/server/companies";
import {
  dashboardSummary,
  getOrder,
  listOrders,
  orderListQuery,
  orderNeighbours,
  orderTabCounts,
  parseOrderListContext,
} from "./orders";

describe("orders read model", () => {
  let accountId: string;
  let a: string;
  let b: string;
  let otherAccountOrder: string;
  const mk = (
    accountId: string,
    companyId: string,
    n: string,
    status: "IMPORTED" | "READY" | "BLOCKED",
    over = {},
  ) =>
    accountDb(accountId).order.create({
      data: {
        accountId,
        companyId,
        source: "MANUAL",
        number: n,
        status,
        currency: "EUR",
        subtotal: "10",
        total: "10",
        paymentMethod: "COD",
        codAmount: "10",
        placedAt: new Date(),
        countryCode: "BG",
        customerName: `Buyer ${n}`,
        ...over,
      },
    });

  beforeAll(async () => {
    const r = await bootstrapOwner({
      email: `ord-${Date.now()}@example.com`,
      name: "O",
      accountName: "Orders group",
      password: "correct horse battery staple",
    });
    accountId = r.account.id;
    const owner = { userId: r.user.id, accountId, role: "OWNER" as const };
    a = (await systemDb().company.findFirstOrThrow({ where: { accountId } })).id;
    b = (await createCompany(owner, { name: "Second" })).id;
    await mk(accountId, a, "A-1", "IMPORTED");
    await mk(accountId, a, "A-2", "READY", { countryCode: "RO" });
    await mk(accountId, b, "B-1", "BLOCKED");
    const other = await bootstrapOwner({
      email: `ord2-${Date.now()}@example.com`,
      name: "O",
      accountName: "Other group",
      password: "correct horse battery staple",
    });
    const oc = (await systemDb().company.findFirstOrThrow({ where: { accountId: other.account.id } })).id;
    otherAccountOrder = (await mk(other.account.id, oc, "X-1", "IMPORTED")).id;
  });

  it("tabs, counts and filters stay inside the group and the member's companies", async () => {
    const all = { accountId, companyScope: null, activeCompanyId: null };
    expect(await orderTabCounts(all, {})).toMatchObject({ review: 1, ready: 1, blocked: 1, all: 3 });
    expect((await listOrders(all, { tab: "all" })).rows.map((o) => o.number).sort()).toEqual([
      "A-1",
      "A-2",
      "B-1",
    ]);
    expect((await listOrders(all, { tab: "all", country: "ro" })).rows.map((o) => o.number)).toEqual(["A-2"]);
    expect((await listOrders(all, { tab: "all", q: "buyer b-1" })).rows.map((o) => o.number)).toEqual([
      "B-1",
    ]);
    const restricted = { accountId, companyScope: [a], activeCompanyId: null };
    expect(await orderTabCounts(restricted, {})).toMatchObject({ blocked: 0, all: 2 });
    expect((await listOrders({ ...all, activeCompanyId: b }, { tab: "all" })).total).toBe(1);
  });

  it("detail refuses orders of another company or group", async () => {
    const [bOrder] = (await listOrders({ accountId, companyScope: null, activeCompanyId: b }, { tab: "all" }))
      .rows;
    const actor = { userId: "u", accountId, role: "OPERATOR" as const, companyScope: [a] };
    await expect(getOrder(actor, bOrder!.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(getOrder({ ...actor, companyScope: null }, otherAccountOrder)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await getOrder({ ...actor, companyScope: null }, bOrder!.id)).number).toBe("B-1");
  });

  it("dashboard counts today's orders per scope", async () => {
    const s = await dashboardSummary({ accountId, companyScope: [a], activeCompanyId: null });
    expect(s.today.orders).toBe(2);
    expect(s.today.countries).toBe(2);
    expect(s.attention).toMatchObject({ review: 1, blocked: 0 });
    expect(s.today.cod).toEqual([{ currency: "EUR", amount: 20 }]);
  });

  it("J / K neighbours: newer and older by when placed, in the member's scope, same-time orders by id", async () => {
    const t0 = Date.UTC(2026, 0, 1);
    const o1 = await mk(accountId, a, "N-1", "IMPORTED", { placedAt: new Date(t0) });
    const o2 = await mk(accountId, a, "N-2", "READY", { placedAt: new Date(t0 + 60_000) });
    const o3 = await mk(accountId, b, "N-3", "READY", { placedAt: new Date(t0 + 120_000) });
    const all = { accountId, companyScope: null, activeCompanyId: null };
    // Only these three in a tiny window: older than o1 / newer than o3 are the other test orders (placed now).
    expect(await orderNeighbours(all, o2.id)).toEqual({ newer: o3.id, older: o1.id });
    // Company A only: o3 (company B) is skipped.
    const onlyA = { ...all, activeCompanyId: a };
    expect((await orderNeighbours(onlyA, o2.id)).newer).not.toBe(o3.id);
    // Out of scope: nothing.
    expect(await orderNeighbours({ ...all, activeCompanyId: b }, o2.id)).toEqual({
      newer: null,
      older: null,
    });
  });

  it("J / K follow the list the order was opened from: its tab, filters and order; no cancelled ones otherwise", async () => {
    const t0 = Date.UTC(2025, 5, 1);
    const g1 = await mk(accountId, a, "L-1", "IMPORTED", { placedAt: new Date(t0), countryCode: "GR" });
    const ro = await mk(accountId, a, "L-2", "IMPORTED", {
      placedAt: new Date(t0 + 60_000),
      countryCode: "RO",
    });
    const g3 = await mk(accountId, a, "L-3", "IMPORTED", {
      placedAt: new Date(t0 + 120_000),
      countryCode: "GR",
    });
    const cancelled = await mk(accountId, a, "L-4", "IMPORTED", {
      placedAt: new Date(t0 + 180_000),
      countryCode: "GR",
    });
    await accountDb(accountId).order.update({ where: { id: cancelled.id }, data: { status: "CANCELLED" } });
    const all = { accountId, companyScope: null, activeCompanyId: null };
    const gr = parseOrderListContext({ tab: "review", country: "gr" })!;
    expect(orderListQuery(gr)).toBe("tab=review&country=gr");
    // The Greek review list: L-2 (Romania) is skipped both ways.
    expect((await orderNeighbours(all, g1.id, gr)).newer).toBe(g3.id);
    expect((await orderNeighbours(all, g3.id, gr)).older).toBe(g1.id);
    // Opened from elsewhere: a cancelled order is never a step.
    expect((await orderNeighbours(all, g3.id)).newer).not.toBe(cancelled.id);
    expect((await orderNeighbours(all, ro.id)).older).toBe(g1.id);
    expect(parseOrderListContext({ tab: "nope" })).toBeNull();
  });
});
