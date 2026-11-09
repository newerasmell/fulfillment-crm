import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/auth/rbac";
import { euTestGroup } from "@/server/eushipments/test-fixtures";
import { productsMissingAt, queueProductsToWarehouse, warehouseCreateTargets } from "./to-warehouse";

// Synthetic data only; nothing is sent (the outbox sender is not run here).

describe("Създаване в склада (database)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let ready: string;
  let noEan: string;
  let linked: string;
  const ctx = () => ({ accountId: g.accountId, companyScope: null, activeCompanyId: null });

  beforeAll(async () => {
    g = await euTestGroup("to-warehouse");
    await g.db.fulfillmentConnection.update({
      where: { id: g.connection.id },
      data: { liveMode: "DRY_RUN" },
    });
    const mk = async (sku: string, ean: string | null, dims = true) => {
      const p = await g.db.product.create({
        data: {
          accountId: g.accountId,
          sku,
          name: `Product ${sku}`,
          ...(dims ? { weightGrams: 300, lengthMm: 100, widthMm: 80, heightMm: 40 } : {}),
        },
      });
      if (ean) await g.db.productEan.create({ data: { accountId: g.accountId, productId: p.id, ean } });
      return p.id;
    };
    ready = await mk("TW-READY", "0000000000024");
    noEan = await mk("TW-NOEAN", null, false);
    linked = await mk("TW-LINKED", "0000000000031");
    await g.db.vendorProduct.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        vendorId: "TW-LINKED",
        productId: linked,
      },
    });
  });

  it("lists only masters the warehouse does not have, with what each still lacks", async () => {
    expect((await warehouseCreateTargets(ctx())).map((c) => c.id)).toContain(g.connection.id);
    const data = await productsMissingAt(ctx(), g.connection.id, { q: "TW-" });
    const bySku = new Map(data.rows.map((r) => [r.sku, r]));
    expect(bySku.has("TW-LINKED")).toBe(false);
    expect(bySku.get("TW-READY")?.missing).toEqual([]);
    expect(bySku.get("TW-NOEAN")?.missing).toEqual(["barcode", "weight", "size"]);
    const onlyReady = await productsMissingAt(ctx(), g.connection.id, { q: "TW-", onlyReady: true });
    expect(onlyReady.rows.map((r) => r.sku)).toEqual(["TW-READY"]);
  });

  it("queues the ready one through the outbox, refuses the incomplete one, never twice", async () => {
    await expect(
      queueProductsToWarehouse(
        { ...g.owner, role: "OPERATOR" },
        { connectionId: g.connection.id, productIds: [ready] },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const r = await queueProductsToWarehouse(g.owner, {
      connectionId: g.connection.id,
      productIds: [ready, noEan],
    });
    expect(r.queued).toBe(1);
    expect(r.failed).toEqual([{ productId: noEan, code: "no_barcode" }]);
    const reqs = await g.db.outboundRequest.findMany({ where: { connectionId: g.connection.id } });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.operation).toBe("eushipments.createProduct");
    // Shown as queued on the page; a second click adds nothing.
    const row = (await productsMissingAt(ctx(), g.connection.id, { q: "TW-READY" })).rows[0]!;
    expect(row.request?.status).toBe("PENDING");
    const again = await queueProductsToWarehouse(g.owner, {
      connectionId: g.connection.id,
      productIds: [ready],
    });
    expect(again).toMatchObject({ queued: 0, already: 1 });
    expect(await g.db.outboundRequest.count({ where: { connectionId: g.connection.id } })).toBe(1);
  });

  it("another company's member or another group sees no such warehouse", async () => {
    await expect(
      queueProductsToWarehouse(
        { ...g.owner, role: "ADMIN", companyScope: ["other"] },
        { connectionId: g.connection.id, productIds: [ready] },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    const other = await euTestGroup("to-warehouse-other");
    await expect(
      productsMissingAt(
        { accountId: other.accountId, companyScope: null, activeCompanyId: null },
        g.connection.id,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
