import { beforeAll, describe, expect, it } from "vitest";
import { systemDb } from "@/server/db/client";
import { euTestGroup } from "@/server/eushipments/test-fixtures";
import { adoptNewWarehouseProducts } from "./catalogue";

// Products created directly in a warehouse become master products of the line (owner report 2026-11-23).
// Synthetic data only.
describe("new warehouse products adopted after a sync", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let lineId: string;
  const db = () => systemDb();
  let n = 0;
  const vp = (vendorId: string, over: { unlinkedAt?: Date } = {}) =>
    db().vendorProduct.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        vendorId,
        raw: { name: `Synthetic product ${++n}` },
        ...over,
      },
    });

  beforeAll(async () => {
    g = await euTestGroup("adopt");
    lineId = (await db().productLine.create({ data: { accountId: g.accountId, name: "Synthetic line" } })).id;
    await db().company.update({ where: { id: g.company.id }, data: { lineId } });
    await db().fulfillmentConnection.update({
      where: { id: g.connection.id },
      data: { skuPrefixRule: { prefix: "R" } },
    });
  });

  it("does nothing while the warehouse's catalogue is not the line's source (no finished „Каталог“ run)", async () => {
    const row = await vp("RNOSRC-1");
    expect(await adoptNewWarehouseProducts(g.accountId, g.connection.id)).toMatchObject({
      adopted: false,
      reason: "no_catalogue",
    });
    expect((await db().vendorProduct.findUniqueOrThrow({ where: { id: row.id } })).productId).toBeNull();
  });

  it("creates the master (SKU without the prefix) and links it; links an existing master; never a removed link", async () => {
    await db().masterCatalogueRun.create({
      data: { accountId: g.accountId, lineId, connectionId: g.connection.id, status: "DONE", phase: "done" },
    });
    const fresh = await vp("RNEW-1");
    const existing = await db().product.create({
      data: { accountId: g.accountId, sku: "OLD-1", name: "Existing", lineId },
    });
    const toExisting = await vp("ROLD-1");
    const removed = await vp("RCUT-1", { unlinkedAt: new Date() });

    const r = await adoptNewWarehouseProducts(g.accountId, g.connection.id);
    expect(r).toMatchObject({ adopted: true });
    const master = await db().product.findFirstOrThrow({ where: { accountId: g.accountId, sku: "NEW-1" } });
    expect(master).toMatchObject({ lineId, name: expect.stringMatching(/^Synthetic product/) });
    expect((await db().vendorProduct.findUniqueOrThrow({ where: { id: fresh.id } })).productId).toBe(
      master.id,
    );
    expect((await db().vendorProduct.findUniqueOrThrow({ where: { id: toExisting.id } })).productId).toBe(
      existing.id,
    );
    expect((await db().vendorProduct.findUniqueOrThrow({ where: { id: removed.id } })).productId).toBeNull();
    expect(await db().product.count({ where: { accountId: g.accountId, sku: "CUT-1" } })).toBe(0);
    // Rows that stay unlinked (a SKU another line uses) never hide a new one behind them.
    const other = await db().productLine.create({ data: { accountId: g.accountId, name: "Other line" } });
    for (let i = 0; i < 60; i++)
      await db().product.create({
        data: { accountId: g.accountId, sku: `TAKEN-${i}`, name: "Taken", lineId: other.id },
      });
    for (let i = 0; i < 60; i++) await vp(`RTAKEN-${i}`);
    const late = await vp("RZZZ-LATE-1");
    await adoptNewWarehouseProducts(g.accountId, g.connection.id);
    expect((await db().vendorProduct.findUniqueOrThrow({ where: { id: late.id } })).productId).not.toBeNull();
    // Again: nothing new.
    const before = await db().product.count({ where: { accountId: g.accountId } });
    await adoptNewWarehouseProducts(g.accountId, g.connection.id);
    expect(await db().product.count({ where: { accountId: g.accountId } })).toBe(before);
  });
});
