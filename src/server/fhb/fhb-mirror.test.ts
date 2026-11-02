import { describe, expect, it } from "vitest";
import type { Actor } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { systemDb } from "@/server/db/client";
import { createFhbConnection } from "./connection";
import {
  fhbOutbox,
  fhbStockBoard,
  getFhbConnection,
  linkFhbVendorProduct,
  listFhbConnections,
  setFhbConnectionMode,
  updateFhbConnectionSettings,
} from "./mirror";

let seq = 0;
async function setup() {
  const sys = systemDb();
  const account = await sys.account.create({ data: { name: `FHB mirror ${++seq}` } });
  const mine = await sys.company.create({ data: { accountId: account.id, name: "Mine" } });
  const other = await sys.company.create({ data: { accountId: account.id, name: "Other" } });
  const owner: Actor = { userId: "u-owner", accountId: account.id, role: "OWNER" };
  const connection = await createFhbConnection(owner, {
    companyId: other.id,
    name: "FHB other",
    appId: "a",
    secret: "s",
    skuPrefix: "R",
  });
  const product = await sys.product.create({ data: { accountId: account.id, sku: "SKU-1", name: "P" } });
  const vp = await sys.vendorProduct.create({
    data: {
      accountId: account.id,
      connectionId: connection.id,
      vendorId: "RX-1",
      vendorEan: "0000000000017",
    },
  });
  await sys.outboundRequest.create({
    data: {
      accountId: account.id,
      connectionId: connection.id,
      operation: "fhb.product.create",
      idempotencyKey: "k1",
      status: "DRY_RUN_RECORDED",
      payload: { id: "RX-1", body: { id: "RX-1", name: "P" }, meta: { productId: product.id } },
    },
  });
  return { account, mine, other, owner, connection, product, vp };
}

describe("FHB mirror services", () => {
  it("a member restricted to another company cannot open, sync-link or change the connection", async () => {
    const s = await setup();
    const restricted = {
      userId: "u-op",
      accountId: s.account.id,
      role: "OPERATOR" as const,
      companyScope: [s.mine.id],
    };
    await expect(getFhbConnection(restricted, s.connection.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(linkFhbVendorProduct(restricted, s.vp.id, "SKU-1")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(
      await listFhbConnections({ accountId: s.account.id, companyScope: [s.mine.id], activeCompanyId: null }),
    ).toHaveLength(0);
    expect(
      await listFhbConnections({ accountId: s.account.id, companyScope: null, activeCompanyId: null }),
    ).toHaveLength(1);
  });

  it("new connections start READ_ONLY; only an OWNER raises, an ADMIN may lower; changes are audited", async () => {
    const s = await setup();
    const admin = { userId: "u-admin", accountId: s.account.id, role: "ADMIN" as const };
    expect((await getFhbConnection(s.owner, s.connection.id)).liveMode).toBe("READ_ONLY");
    await expect(setFhbConnectionMode(admin, s.connection.id, "DRY_RUN")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await setFhbConnectionMode(s.owner, s.connection.id, "DRY_RUN");
    await setFhbConnectionMode(admin, s.connection.id, "READ_ONLY");
    const audits = await systemDb().auditLog.count({
      where: { accountId: s.account.id, action: "connection.mode_change", entityId: s.connection.id },
    });
    expect(audits).toBe(2);
    await updateFhbConnectionSettings(admin, s.connection.id, {
      name: "Renamed",
      skuPrefix: "Q",
      enabled: true,
    });
    const c = await getFhbConnection(admin, s.connection.id);
    expect(c).toMatchObject({ name: "Renamed", skuPrefixRule: { prefix: "Q" } });
    const viewer = { userId: "u-v", accountId: s.account.id, role: "VIEWER" as const };
    await expect(
      updateFhbConnectionSettings(viewer, s.connection.id, { name: "x y", skuPrefix: "", enabled: true }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("links by SKU only and filters the stock board", async () => {
    const s = await setup();
    const board = await fhbStockBoard(s.account.id, [s.connection.id], { filter: "unmatched" });
    expect(board.total).toBe(1);
    expect(board.counts.unmatched).toBe(1);
    // Searching by EAN finds the row (search only), but an EAN is not accepted as the link key.
    expect((await fhbStockBoard(s.account.id, [s.connection.id], { q: "0000000000017" })).total).toBe(1);
    await expect(linkFhbVendorProduct(s.owner, s.vp.id, "0000000000017")).rejects.toMatchObject({
      code: "no_product",
    });
    await linkFhbVendorProduct(s.owner, s.vp.id, "SKU-1");
    expect((await fhbStockBoard(s.account.id, [s.connection.id], { filter: "unmatched" })).total).toBe(0);
  });

  it("DRY_RUN payload preview: the vendor body for OWNER/ADMIN only, never the CRM meta", async () => {
    const s = await setup();
    const forOwner = await fhbOutbox(s.account.id, s.connection.id, "OWNER", {});
    expect(forOwner.rows[0]).toMatchObject({ body: { id: "RX-1", name: "P" }, target: "RX-1" });
    expect(JSON.stringify(forOwner.rows[0]!.body)).not.toContain("productId");
    const forOperator = await fhbOutbox(s.account.id, s.connection.id, "OPERATOR", {});
    expect(forOperator.withPayload).toBe(false);
    expect(forOperator.rows[0]!.body).toBeUndefined();
    expect(forOperator.rows[0]).not.toHaveProperty("payload");
  });
});
