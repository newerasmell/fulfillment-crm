import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/auth/rbac";
import { accountDb, systemDb } from "@/server/db/client";
import { readCredentialSecret } from "@/server/security/credentials";
import type { ScopedActor } from "@/server/stores";
import {
  createEuConnection,
  getEuConnection,
  linkEuVendorProduct,
  listEuConnections,
  replaceEuToken,
  setEuConnectionMode,
  updateEuConnection,
} from "./connections";
import { mirrorDryRuns, mirrorProducts } from "./mirror";
import { euTestGroup } from "./test-fixtures";

const TOKEN = "test-token-not-real-0002";

describe("euShipments connections (DB)", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let owner: ScopedActor;
  let admin: ScopedActor;
  let companyB: string;

  beforeAll(async () => {
    g = await euTestGroup("conn");
    owner = g.owner;
    admin = { ...owner, role: "ADMIN" };
    companyB = (await systemDb().company.create({ data: { accountId: g.accountId, name: "Фирма Б" } })).id;
  });

  const settings = (over: Record<string, unknown> = {}) => ({
    name: "eu B",
    companyId: companyB,
    vendorCompanyId: 501,
    skuPrefix: "SK-",
    acceptedAlertHours: 24,
    acceptedAlertWorkDays: true,
    cashReceiptCod: false,
    canaryDailyCap: 10,
    enabled: true,
    ...over,
  });

  it("creates a READ_ONLY connection with the token in the vault, audited", async () => {
    const c = await createEuConnection(admin, {
      companyId: companyB,
      name: "eu B",
      token: TOKEN,
      vendorCompanyId: 501,
      skuPrefix: "SK-",
    });
    expect(c).toMatchObject({ liveMode: "READ_ONLY", type: "EUSHIPMENTS", vendorIds: { companyId: 501 } });
    expect(c.skuPrefixRule).toEqual({ prefix: "SK-" });
    expect(await readCredentialSecret(g.db, g.accountId, c.credentialId!)).toBe(TOKEN);
    const cred = await g.db.credential.findUniqueOrThrow({ where: { id: c.credentialId! } });
    expect(JSON.stringify(cred)).not.toContain(TOKEN);
    expect(await g.db.eushipmentsSettings.count({ where: { connectionId: c.id } })).toBe(1);
    const audit = await g.db.auditLog.findFirstOrThrow({
      where: { action: "eushipments.connection_create", entityId: c.id },
    });
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
    // the view never carries the secret
    const view = await getEuConnection(owner, c.id);
    expect(JSON.stringify({ ...view, variableSymbolNext: null })).not.toContain(TOKEN);
  });

  it("refuses a second connection for the same euShipments company; reuses a token for another company", async () => {
    await expect(
      createEuConnection(owner, { companyId: companyB, name: "dup", token: TOKEN, vendorCompanyId: 501 }),
    ).rejects.toMatchObject({ code: "connection_exists" });
    const first = (await listEuConnections({ ...owner, activeCompanyId: null })).find(
      (c) => c.name === "eu B",
    )!;
    const second = await createEuConnection(owner, {
      companyId: companyB,
      name: "eu B2",
      credentialId: first.credentialId!,
      vendorCompanyId: 502,
    });
    expect(second.credentialId).toBe(first.credentialId);
    // a credential that is not an euShipments token of this group cannot be reused
    const shopify = await g.db.credential.create({
      data: {
        accountId: g.accountId,
        label: "Shopify app x",
        ciphertext: "x",
        iv: "x",
        authTag: "x",
        hint: "x",
      },
    });
    await expect(
      createEuConnection(owner, { companyId: companyB, name: "x", credentialId: shopify.id }),
    ).rejects.toMatchObject({ code: "invalid_credential" });
  });

  it("operators cannot create or change connections; restricted members see only their companies", async () => {
    const op: ScopedActor = { ...owner, role: "OPERATOR" };
    await expect(
      createEuConnection(op, { companyId: companyB, name: "x", token: TOKEN }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const restricted: ScopedActor = { ...owner, role: "OPERATOR", companyScope: [g.company.id] };
    const list = await listEuConnections({ ...restricted, activeCompanyId: null });
    expect(list.map((c) => c.name)).toEqual(["euShipments test"]);
    const b = (await listEuConnections({ ...owner, activeCompanyId: null })).find((c) => c.name === "eu B")!;
    await expect(getEuConnection(restricted, b.id)).rejects.toMatchObject({ code: "not_found" });
    // another group never sees it
    const other = await euTestGroup("conn-other");
    await expect(getEuConnection(other.owner, b.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("only an OWNER raises the mode, and only on a tested connection; admins can lower it", async () => {
    const b = (await listEuConnections({ ...owner, activeCompanyId: null })).find((c) => c.name === "eu B")!;
    await expect(setEuConnectionMode(admin, b.id, "DRY_RUN")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setEuConnectionMode(owner, b.id, "DRY_RUN")).rejects.toMatchObject({ code: "not_ready" });
    await g.db.eushipmentsSync.create({
      data: { accountId: g.accountId, connectionId: b.id, kind: "connection", lastOkAt: new Date() },
    });
    expect(await setEuConnectionMode(owner, b.id, "DRY_RUN")).toEqual({
      before: "READ_ONLY",
      after: "DRY_RUN",
    });
    expect(await setEuConnectionMode(admin, b.id, "READ_ONLY")).toEqual({
      before: "DRY_RUN",
      after: "READ_ONLY",
    });
    expect(await g.db.auditLog.count({ where: { action: "connection.mode_change", entityId: b.id } })).toBe(
      2,
    );
  });

  it("settings: company mapping, alert threshold; a raised CANARY cap needs an OWNER; company locked after shipments", async () => {
    const b = (await listEuConnections({ ...owner, activeCompanyId: null })).find((c) => c.name === "eu B")!;
    await updateEuConnection(admin, b.id, settings({ acceptedAlertHours: 48, cashReceiptCod: true }));
    const s = await g.db.eushipmentsSettings.findUniqueOrThrow({
      where: { accountId_connectionId: { accountId: g.accountId, connectionId: b.id } },
    });
    expect(s).toMatchObject({ acceptedAlertHours: 48, cashReceiptCod: true });
    await expect(updateEuConnection(admin, b.id, settings({ canaryDailyCap: 20 }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await updateEuConnection(owner, b.id, settings({ canaryDailyCap: 20 }));
    // changing the euShipments company invalidates the connection test
    await updateEuConnection(owner, b.id, settings({ vendorCompanyId: 503, canaryDailyCap: 20 }));
    const test = await g.db.eushipmentsSync.findUniqueOrThrow({
      where: { connectionId_kind: { connectionId: b.id, kind: "connection" } },
    });
    expect(test).toMatchObject({ lastOkAt: null, lastError: "company_changed" });
    await expect(
      updateEuConnection(owner, b.id, settings({ vendorCompanyId: 502, canaryDailyCap: 20 })),
    ).rejects.toMatchObject({ code: "connection_exists" });
    const { order } = await (await import("./test-fixtures")).euTestOrder(g, { number: "#C1" });
    await g.db.fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: order.id,
        connectionId: b.id,
        externalId: "TST-C1",
        status: "ACCEPTED",
      },
    });
    await expect(
      updateEuConnection(owner, b.id, settings({ vendorCompanyId: 504, canaryDailyCap: 20 })),
    ).rejects.toMatchObject({ code: "company_locked" });
  });

  it("token rotation stores a new credential and requires a new test", async () => {
    const b = (await listEuConnections({ ...owner, activeCompanyId: null })).find((c) => c.name === "eu B")!;
    await replaceEuToken(admin, b.id, "test-token-not-real-0003");
    const after = await g.db.fulfillmentConnection.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.credentialId).not.toBe(b.credentialId);
    expect(await readCredentialSecret(g.db, g.accountId, after.credentialId!)).toBe(
      "test-token-not-real-0003",
    );
    await expect(replaceEuToken(admin, b.id, "short")).rejects.toThrow();
  });

  it("operator links an unmatched euShipments product to a master SKU (never by EAN)", async () => {
    const master = await g.db.product.create({ data: { accountId: g.accountId, sku: "LINK-ME", name: "M" } });
    const vp = await g.db.vendorProduct.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        vendorId: "X-REF-1",
        raw: { name: "N" },
      },
    });
    expect(
      (await mirrorProducts(g.accountId, g.connection.id, { filter: "unmatched" })).counts.unmatched,
    ).toBe(1);
    await expect(
      linkEuVendorProduct({ ...owner, role: "VIEWER" }, { vendorProductId: vp.id, sku: "LINK-ME" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(linkEuVendorProduct(owner, { vendorProductId: vp.id, sku: "NOPE" })).rejects.toMatchObject({
      code: "unknown_sku",
    });
    await linkEuVendorProduct({ ...owner, role: "WAREHOUSE" }, { vendorProductId: vp.id, sku: "link-me" });
    expect((await g.db.vendorProduct.findUniqueOrThrow({ where: { id: vp.id } })).productId).toBe(master.id);
    const m = await mirrorProducts(g.accountId, g.connection.id, { q: "LINK" });
    expect(m.rows.map((r) => r.vendorName)).toEqual(["N"]);
  });

  it("DRY_RUN preview shows the exact body and whether euShipments validated it in testMode", async () => {
    const db = accountDb(g.accountId);
    const mk = (
      operation: string,
      key: string,
      status: "DRY_RUN_RECORDED" | "FAILED",
      lastResponse: unknown,
    ) =>
      db.outboundRequest.create({
        data: {
          accountId: g.accountId,
          connectionId: g.connection.id,
          operation,
          idempotencyKey: key,
          payload: { body: { awb: { referenceNumber: key } }, ctx: {} },
          status,
          evaluatedMode: "DRY_RUN",
          lastResponse: lastResponse as never,
          lastError: status === "FAILED" ? "recipient.phoneNumber invalid" : null,
        },
      });
    await mk("eushipments.createOrder", "order:TST-D1", "DRY_RUN_RECORDED", { orderId: null, error: false });
    await mk("eushipments.createOrder", "order:TST-D2", "FAILED", { error: "x" });
    await mk("eushipments.createProduct", "product:P1", "DRY_RUN_RECORDED", null);
    const r = await mirrorDryRuns(g.accountId, g.connection.id);
    const byKey = Object.fromEntries(r.rows.map((x) => [x.idempotencyKey, x]));
    expect(byKey["order:TST-D1"]).toMatchObject({ testMode: true, verdict: "validated" });
    expect(byKey["order:TST-D2"]).toMatchObject({ testMode: true, verdict: "rejected" });
    expect(byKey["product:P1"]).toMatchObject({ testMode: false, verdict: "recorded" });
    expect(byKey["order:TST-D1"]!.body).toEqual({ awb: { referenceNumber: "order:TST-D1" } });
  });
});
