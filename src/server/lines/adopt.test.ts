import { beforeAll, describe, expect, it } from "vitest";
import { systemDb } from "@/server/db/client";
import { euTestGroup } from "@/server/eushipments/test-fixtures";
import { pickUnlinkedWarehouseProducts } from "@/server/stock/inbound";
import {
  ADOPT_STATE,
  adoptNewWarehouseProducts,
  adoptWarehouseProduct,
  cuidFloor,
  cuidTime,
} from "./catalogue";

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

// Owner 2026-11-23: one warehouse is the line's source, the others are matched to it — a product created later in
// another warehouse of the line becomes a master too, its old unmatched products stay as they are.
describe("new products of a warehouse that is not the line's source", () => {
  const db = () => systemDb();
  const DAY = 86_400_000;

  async function setup(label: string, runDaysAgo: number, type: "EUSHIPMENTS" | "FHB_V3" = "EUSHIPMENTS") {
    const g = await euTestGroup(label);
    const lineId = (
      await db().productLine.create({ data: { accountId: g.accountId, name: "Synthetic line" } })
    ).id;
    await db().company.update({ where: { id: g.company.id }, data: { lineId } });
    const second = await db().company.create({
      data: { accountId: g.accountId, name: "Second company", lineId },
    });
    const other = await db().fulfillmentConnection.create({
      data: {
        accountId: g.accountId,
        companyId: second.id,
        type,
        name: "Second",
        liveMode: "LIVE",
      },
    });
    const now = Date.now();
    const at = (ms: number, vendorId: string, over: { archived?: boolean } = {}) =>
      db().vendorProduct.create({
        data: {
          id: `${cuidFloor(new Date(ms))}synthetic${Math.random().toString(36).slice(2, 10)}`,
          accountId: g.accountId,
          connectionId: other.id,
          vendorId,
          raw: { name: `Synthetic ${vendorId}` },
          ...over,
        },
      });
    const fresh = (vendorId: string) =>
      db().vendorProduct.create({
        data: {
          accountId: g.accountId,
          connectionId: other.id,
          vendorId,
          raw: { name: `Synthetic ${vendorId}` },
        },
      });
    const run = () =>
      db().masterCatalogueRun.create({
        data: {
          accountId: g.accountId,
          lineId,
          connectionId: g.connection.id,
          status: "DONE",
          phase: "done",
          createdAt: new Date(now - runDaysAgo * DAY - 600_000),
          finishedAt: new Date(now - runDaysAgo * DAY),
        },
      });
    const linkOf = async (id: string) =>
      (await db().vendorProduct.findUniqueOrThrow({ where: { id } })).productId;
    return { g, lineId, other, now, at, fresh, run, linkOf };
  }

  it("adopts only rows created after the line's run AND after the first completed sync that ran it", async () => {
    const { g, lineId, other, now, at, fresh, run, linkOf } = await setup("adopt-other", 2);
    const firstRead = await at(now - 10 * DAY, "OLD-FIRST");
    // The warehouse's first read was slow / interrupted: more old rows hours later (still "old").
    const laterBatch = await at(now - 10 * DAY + 5 * 3_600_000, "OLD-LATER-BATCH");
    const archivedOld = await at(now - 9 * DAY, "OLD-ARCHIVED", { archived: true });
    // Without a catalogue run of the line: nothing (and no watermark is stored yet).
    expect(await adoptNewWarehouseProducts(g.accountId, other.id)).toMatchObject({ reason: "no_catalogue" });
    expect(
      await db().eushipmentsSync.count({
        where: { connectionId: other.id, kind: { startsWith: ADOPT_STATE } },
      }),
    ).toBe(0);

    await run();
    const afterRunBeforeSync = await at(now - DAY, "OLD-AFTER-RUN");
    // First completed sync with the run in place: stores the watermark, adopts nothing that existed before it.
    expect(await adoptNewWarehouseProducts(g.accountId, other.id)).toMatchObject({
      adopted: true,
      created: 0,
    });
    for (const old of [firstRead, laterBatch, archivedOld, afterRunBeforeSync])
      expect(await linkOf(old.id)).toBeNull();

    // Created in the cabinet afterwards: adopted by the next sync; an existing master with that SKU is linked, kept.
    const created = await fresh("NEW-ONE");
    const toExisting = await fresh("NEW-KEPT");
    const existing = await db().product.create({
      data: { accountId: g.accountId, sku: "NEW-KEPT", name: "Kept", lineId },
    });
    const r = await adoptNewWarehouseProducts(g.accountId, other.id);
    // "linked" counts every row given a master (the new one too).
    expect(r).toMatchObject({ adopted: true, created: 1, linked: 2 });
    expect(await linkOf(created.id)).not.toBeNull();
    expect(await linkOf(toExisting.id)).toBe(existing.id);
    expect((await db().product.findUniqueOrThrow({ where: { id: existing.id } })).name).toBe("Kept");
    for (const old of [firstRead, laterBatch, archivedOld, afterRunBeforeSync])
      expect(await linkOf(old.id)).toBeNull();
    expect(await db().product.count({ where: { accountId: g.accountId, sku: { startsWith: "OLD-" } } })).toBe(
      0,
    );
    // The watermark is stored once.
    expect(
      await db().eushipmentsSync.count({
        where: { connectionId: other.id, kind: { startsWith: ADOPT_STATE } },
      }),
    ).toBe(1);
  });

  it("a warehouse added to the line long after its catalogue run adopts nothing of its existing catalogue", async () => {
    const { g, other, now, at, fresh, run, linkOf } = await setup("adopt-joined", 30);
    await run();
    const old = [await at(now - 2 * DAY, "JOIN-OLD-1"), await at(now - 3_600_000, "JOIN-OLD-2")];
    await adoptNewWarehouseProducts(g.accountId, other.id);
    for (const o of old) expect(await linkOf(o.id)).toBeNull();
    const later = await fresh("JOIN-NEW-1");
    await adoptNewWarehouseProducts(g.accountId, other.id);
    expect(await linkOf(later.id)).not.toBeNull();
  });

  it("FHB: the watermark is kept in its sync state, once, also when two syncs run at once", async () => {
    const { g, other, now, at, fresh, run, linkOf, lineId } = await setup("adopt-fhb", 2, "FHB_V3");
    await run();
    const old = await at(now - DAY, "FHB-OLD-1");
    await Promise.all([
      adoptNewWarehouseProducts(g.accountId, other.id),
      adoptNewWarehouseProducts(g.accountId, other.id),
    ]);
    expect(await linkOf(old.id)).toBeNull();
    expect(
      await db().fhbSyncState.count({
        where: { connectionId: other.id, resource: `${ADOPT_STATE}:${lineId}` },
      }),
    ).toBe(1);
    const later = await fresh("FHB-NEW-1");
    await adoptNewWarehouseProducts(g.accountId, other.id);
    expect(await linkOf(later.id)).not.toBeNull();
  });

  it("reads the creation time from an id", () => {
    const d = new Date("2026-11-23T12:00:00Z");
    expect(cuidTime(`${cuidFloor(d)}0001abcd`)?.toISOString()).toBe(d.toISOString());
    expect(cuidTime("not-a-cuid")).toBeNull();
    expect(`${cuidFloor(d)}0` > cuidFloor(new Date(d.getTime() - 1))).toBe(true);
  });
});

// „Добави като основен продукт“ in a new inbound (owner request 2026-11-23). Synthetic data only.
describe("one warehouse product added as a master by a person", () => {
  const db = () => systemDb();

  it("finds the warehouse's products without a master, creates or links the master, refuses another line's SKU", async () => {
    const g = await euTestGroup("adopt-one");
    const lineId = (
      await db().productLine.create({ data: { accountId: g.accountId, name: "Synthetic line" } })
    ).id;
    await db().company.update({ where: { id: g.company.id }, data: { lineId } });
    const ctx = {
      accountId: g.accountId,
      role: "OWNER",
      companyScope: null,
      activeCompanyId: null,
      activeLineId: null,
      lineCompanyIds: null,
    };
    const vp = (vendorId: string, name: string, over: { archived?: boolean; unlinkedAt?: Date } = {}) =>
      db().vendorProduct.create({
        data: { accountId: g.accountId, connectionId: g.connection.id, vendorId, raw: { name }, ...over },
      });
    const fresh = await vp("SYN-NEW-1", "Synthetic Lavender");
    const linkedBefore = await db().product.create({
      data: { accountId: g.accountId, sku: "SYN-KEPT-1", name: "Kept name", lineId },
    });
    const toExisting = await vp("SYN-KEPT-1", "Other name");
    const otherLine = await db().productLine.create({ data: { accountId: g.accountId, name: "Other" } });
    await db().product.create({
      data: { accountId: g.accountId, sku: "SYN-TAKEN-1", name: "Taken", lineId: otherLine.id },
    });
    const taken = await vp("SYN-TAKEN-1", "Taken here");
    const args = (vendorProductId: string) => ({ connectionId: g.connection.id, vendorProductId });

    // Search by code and by name (any case); linked products are not offered.
    expect(
      (await pickUnlinkedWarehouseProducts(ctx, g.connection.id, "syn-new")).map((r) => r.vendorId),
    ).toEqual(["SYN-NEW-1"]);
    for (const q of ["Lavender", "lavender", "LAVENDER"])
      expect((await pickUnlinkedWarehouseProducts(ctx, g.connection.id, q))[0]).toMatchObject({
        vendorProductId: fresh.id,
        name: "Synthetic Lavender",
      });

    // Two clicks at once: one master, the same for both, one audit entry.
    const [a, b] = await Promise.all([
      adoptWarehouseProduct(g.owner, args(fresh.id)),
      adoptWarehouseProduct(g.owner, args(fresh.id)),
    ]);
    expect(a).toMatchObject({ sku: "SYN-NEW-1", name: "Synthetic Lavender", vendorId: "SYN-NEW-1" });
    expect(b.id).toBe(a.id);
    expect(await db().product.count({ where: { accountId: g.accountId, sku: "SYN-NEW-1" } })).toBe(1);
    expect((await db().product.findUniqueOrThrow({ where: { id: a.id } })).lineId).toBe(lineId);
    expect(await pickUnlinkedWarehouseProducts(ctx, g.connection.id, "syn-new")).toEqual([]);
    const audits = await db().auditLog.findMany({
      where: { accountId: g.accountId, action: "lines.adoptWarehouseProduct", entityId: fresh.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ productId: a.id, sku: "SYN-NEW-1", createdMaster: true });
    // Again later: the same master, no new audit entry.
    expect((await adoptWarehouseProduct(g.owner, args(fresh.id))).id).toBe(a.id);
    expect(
      await db().auditLog.count({
        where: { accountId: g.accountId, action: "lines.adoptWarehouseProduct", entityId: fresh.id },
      }),
    ).toBe(1);

    const linked = await adoptWarehouseProduct(g.owner, args(toExisting.id));
    expect(linked.id).toBe(linkedBefore.id);
    expect((await db().product.findUniqueOrThrow({ where: { id: linkedBefore.id } })).name).toBe("Kept name");

    // Refused: another line's SKU, a link a person removed, an archived row, a company without a line.
    await expect(adoptWarehouseProduct(g.owner, args(taken.id))).rejects.toMatchObject({
      code: "sku_conflict",
    });
    const cut = await vp("SYN-CUT-1", "Cut", { unlinkedAt: new Date() });
    await expect(adoptWarehouseProduct(g.owner, args(cut.id))).rejects.toMatchObject({
      code: "unlinked_by_person",
    });
    const gone = await vp("SYN-GONE-1", "Gone", { archived: true });
    await expect(adoptWarehouseProduct(g.owner, args(gone.id))).rejects.toMatchObject({ code: "not_found" });
    expect(
      await db().product.count({
        where: { accountId: g.accountId, sku: { in: ["SYN-CUT-1", "SYN-GONE-1"] } },
      }),
    ).toBe(0);

    // Scoping: another group, and a member of this group whose companies do not include the warehouse.
    const stranger = await euTestGroup("adopt-one-other");
    await expect(adoptWarehouseProduct(stranger.owner, args(taken.id))).rejects.toMatchObject({
      code: "not_found",
    });
    const elsewhere = await db().company.create({ data: { accountId: g.accountId, name: "Elsewhere" } });
    await expect(
      adoptWarehouseProduct({ ...g.owner, role: "WAREHOUSE", companyScope: [elsewhere.id] }, args(taken.id)),
    ).rejects.toMatchObject({ code: "not_found" });
    // Roles: an operator (no inbound.manage) and a viewer may not.
    for (const role of ["OPERATOR", "VIEWER"] as const)
      await expect(adoptWarehouseProduct({ ...g.owner, role }, args(taken.id))).rejects.toThrow(
        /forbidden|not allowed/i,
      );

    await db().company.update({ where: { id: g.company.id }, data: { lineId: null } });
    await expect(adoptWarehouseProduct(g.owner, args(taken.id))).rejects.toMatchObject({ code: "no_line" });
  });
});
