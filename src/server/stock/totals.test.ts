import { beforeAll, describe, expect, it } from "vitest";
import { systemDb } from "@/server/db/client";
import { euTestGroup } from "@/server/eushipments/test-fixtures";
import { warehouseTotals } from "./totals";

// „Общо в складовете“ (owner request 2026-11-23). Synthetic data only.
describe("warehouse totals", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  const db = () => systemDb();
  const ctx = (over: Partial<{ companyScope: string[] | null; activeCompanyId: string | null }> = {}) => ({
    accountId: g.accountId,
    role: "OWNER",
    companyScope: null,
    activeCompanyId: null,
    activeLineId: null,
    lineCompanyIds: null,
    ...over,
  });

  beforeAll(async () => {
    g = await euTestGroup("totals");
  });

  async function stock(connectionId: string, physical: number, sellable = physical, archived = false) {
    const product = await db().product.create({
      data: { accountId: g.accountId, sku: `TOT-${Math.random().toString(36).slice(2, 8)}`, name: "Sample" },
    });
    const vp = await db().vendorProduct.create({
      data: {
        accountId: g.accountId,
        connectionId,
        productId: product.id,
        vendorId: `v-${product.id}`,
        raw: {},
        archived,
      },
    });
    await db().stockLevel.create({
      data: {
        accountId: g.accountId,
        vendorProductId: vp.id,
        physical,
        free: sellable,
        sellable,
        snapshotAt: new Date(),
        source: "POLL",
      },
    });
    return product;
  }

  it("sums every product's units per warehouse and per company; free minus held units; scoped by company", async () => {
    const other = await db().company.create({ data: { accountId: g.accountId, name: "Second company" } });
    const fhb = await db().fulfillmentConnection.create({
      data: {
        accountId: g.accountId,
        companyId: other.id,
        type: "FHB_V3",
        name: "Second FHB",
        liveMode: "LIVE",
      },
    });
    const first = await stock(g.connection.id, 700, 600);
    const held = await stock(g.connection.id, 300);
    await stock(g.connection.id, 0);
    await stock(g.connection.id, 50, 50, true); // archived link: not counted
    await stock(fhb.id, 40, 35);
    // A second link of the same product at the same warehouse: the board shows the first one, so does the total.
    const dup = await db().vendorProduct.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        productId: first.id,
        vendorId: `dup-${first.id}`,
        raw: {},
      },
    });
    await db().stockLevel.create({
      data: {
        accountId: g.accountId,
        vendorProductId: dup.id,
        physical: 999,
        free: 999,
        sellable: 999,
        snapshotAt: new Date(),
        source: "POLL",
      },
    });
    // An archived product (not on the board) is left out.
    const gone = await stock(g.connection.id, 77);
    await db().product.update({ where: { id: gone.id }, data: { archived: true } });
    await db().skuIncident.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        productId: held.id,
        fulfillmentId: "synthetic-shipment",
        quantity: 2,
      },
    });

    const all = await warehouseTotals(ctx());
    const mine = all.companies.find((c) => c.id === g.company.id)!;
    expect(mine.units).toBe(1000);
    expect(mine.warehouses[0]).toMatchObject({
      name: g.connection.name,
      units: 1000,
      free: 898,
      products: 2,
    });
    expect(all.companies.find((c) => c.id === other.id)).toMatchObject({ units: 40, free: 35 });
    expect(all.units).toBe(1040);

    // A member of the second company sees only its warehouse.
    const scoped = await warehouseTotals(ctx({ companyScope: [other.id] }));
    expect(scoped.companies.map((c) => c.name)).toEqual(["Second company"]);
    expect(scoped.units).toBe(40);
    // Another group sees none of it.
    const stranger = await euTestGroup("totals-other");
    expect((await warehouseTotals({ ...ctx(), accountId: stranger.accountId })).units).toBe(0);
  });
});
