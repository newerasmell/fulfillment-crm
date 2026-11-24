import { describe, expect, it } from "vitest";
import { systemDb } from "@/server/db/client";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import { listOrders, parseStoreParam } from "@/server/orders";
import { myStoreIds, saveMyStores, storesByLine } from "./store-preferences";

// „Моите магазини“ and the grouped multi-store filter (owner request 2026-11-24). Synthetic data only.
describe("my stores and the store filter", () => {
  it("groups stores by line alphabetically, saves a member's stores (only visible ones), filters by several", async () => {
    const g = await euTestGroup("my-stores");
    const db = systemDb();
    const perfumes = await db.productLine.create({ data: { accountId: g.accountId, name: "Парфюми" } });
    const clothes = await db.productLine.create({ data: { accountId: g.accountId, name: "Дрехи" } });
    await db.company.update({ where: { id: g.company.id }, data: { lineId: perfumes.id } });
    const second = await db.company.create({
      data: { accountId: g.accountId, name: "Second", lineId: clothes.id },
    });
    const store = (companyId: string, name: string) =>
      db.store.create({
        data: {
          accountId: g.accountId,
          companyId,
          domain: `${name}.example`,
          code: name.slice(0, 4).toUpperCase(),
          name,
          currency: "EUR",
        },
      });
    const zeta = await store(g.company.id, "Zeta Parfum");
    const alpha = await store(g.company.id, "Alpha Parfum");
    const tee = await store(second.id, "Tee Shop");
    const ctx = { accountId: g.accountId, companyScope: null, activeCompanyId: null };
    const groups = await storesByLine(ctx);
    expect(groups.map((x) => x.line)).toEqual(["Дрехи", "Парфюми"]);
    expect(groups[1]!.stores.map((s) => s.name)).toEqual(
      ["Alpha Parfum", g.store.name, "Zeta Parfum"].sort((a, b) => a.localeCompare(b, "bg")),
    );

    // Saved only within the member's companies; empty = all.
    const member = { ...g.owner, role: "OPERATOR" as const, companyScope: [g.company.id] };
    expect(await saveMyStores(member, [alpha.id, tee.id, "missing"])).toEqual([alpha.id]);
    expect(
      await myStoreIds({ accountId: g.accountId, userId: g.owner.userId, companyScope: [g.company.id] }),
    ).toEqual([alpha.id]);
    expect(await saveMyStores(member, [])).toEqual([]);
    const stranger = await euTestGroup("my-stores-other");
    expect(await saveMyStores(stranger.owner, [alpha.id])).toEqual([]);

    // Several stores at once in the orders list.
    const { order: a } = await euTestOrder(g, { number: "#MS-1" });
    const { order: z } = await euTestOrder(g, { number: "#MS-2" });
    await db.order.update({ where: { id: a.id }, data: { storeId: alpha.id } });
    await db.order.update({ where: { id: z.id }, data: { storeId: zeta.id } });
    const ids = (storeIds?: string[]) =>
      listOrders(ctx, { tab: "all", storeIds }).then((r) => r.rows.map((o) => o.id).sort());
    expect(await ids([alpha.id])).toEqual([a.id]);
    expect(await ids([alpha.id, zeta.id])).toEqual([a.id, z.id].sort());
    expect(parseStoreParam("all")).toBeUndefined();
    expect(parseStoreParam(`${alpha.id},${zeta.id},${alpha.id}`)).toEqual([alpha.id, zeta.id]);
  });
});
