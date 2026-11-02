import { z } from "zod";
import type { LiveMode } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { companyFilter, type CompanyScope } from "@/server/companies";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { setConnectionMode } from "@/server/outbox/outbox";
import { saveCredential } from "@/server/security/credentials";
import type { ScopedActor } from "@/server/stores";
import { EuVendorIds } from "./connection";

/**
 * euShipments connections: create, settings, token rotation, mode. One connection = one API token (in the
 * vault, write-only) acting for ONE euShipments company (vendorIds.companyId = senderId), owned by one company
 * of the group. A token that sees several euShipments companies is reused by one connection per company.
 * New connections always start READ_ONLY; only an OWNER raises the mode (setConnectionMode), always audited.
 * Nothing here calls the vendor: the connection test and the mirrors are worker jobs.
 */

const Token = z.string().trim().min(10, "token").max(500).regex(/^\S+$/, "token");
const VendorCompanyId = z.coerce.number().int().positive().max(2_147_483_647);
const SkuPrefix = z
  .string()
  .trim()
  .max(20)
  .transform((v) => v || null);

export const NewEuConnectionInput = z.object({
  companyId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  /** Either a new token, or the credential of another euShipments connection of the group (same token). */
  token: Token.optional(),
  credentialId: z.string().optional(),
  vendorCompanyId: VendorCompanyId.optional(),
  skuPrefix: SkuPrefix.optional(),
});

function assertCompany(actor: ScopedActor, companyId: string | null) {
  if (actor.companyScope && (!companyId || !actor.companyScope.includes(companyId)))
    throw new DomainError("not_found");
}

/** One connection per euShipments company inside a group (orders and stock would otherwise be read twice). */
async function assertVendorCompanyFree(accountId: string, vendorCompanyId: number, exceptId?: string) {
  const taken = await accountDb(accountId).fulfillmentConnection.findFirst({
    where: {
      type: "EUSHIPMENTS",
      vendorIds: { path: ["companyId"], equals: vendorCompanyId },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (taken) throw new DomainError("connection_exists");
}

/** Credentials that already belong to an euShipments connection of the group (reusable for another company). */
export async function euCredentials(accountId: string) {
  const rows = await accountDb(accountId).fulfillmentConnection.findMany({
    where: { type: "EUSHIPMENTS", credentialId: { not: null } },
    select: { credential: { select: { id: true, label: true, hint: true } } },
  });
  const seen = new Map<string, { id: string; label: string; hint: string }>();
  for (const r of rows) if (r.credential) seen.set(r.credential.id, r.credential);
  return [...seen.values()];
}

export async function createEuConnection(actor: ScopedActor, raw: z.input<typeof NewEuConnectionInput>) {
  assertCan(actor.role, "connections.manage");
  const input = NewEuConnectionInput.parse(raw);
  assertCompany(actor, input.companyId);
  const db = accountDb(actor.accountId);
  const company = await db.company.findFirst({ where: { id: input.companyId, archivedAt: null } });
  if (!company) throw new DomainError("not_found");
  if (input.vendorCompanyId) await assertVendorCompanyFree(actor.accountId, input.vendorCompanyId);

  let credentialId = input.credentialId || undefined;
  if (credentialId) {
    if (!(await euCredentials(actor.accountId)).some((c) => c.id === credentialId))
      throw new DomainError("invalid_credential");
  } else {
    if (!input.token) throw new DomainError("token_required");
    const view = await saveCredential(db, actor.accountId, {
      label: `euShipments token`,
      secret: input.token,
      userId: actor.userId,
    });
    credentialId = view.id;
  }
  const connection = await withAccountTransaction(actor.accountId, async (tx) => {
    const c = await tx.fulfillmentConnection.create({
      data: {
        accountId: actor.accountId,
        companyId: company.id,
        type: "EUSHIPMENTS",
        name: input.name,
        // Always: a new connection never starts above READ_ONLY (CLAUDE.md).
        liveMode: "READ_ONLY",
        credentialId,
        vendorIds: input.vendorCompanyId ? { companyId: input.vendorCompanyId } : {},
        skuPrefixRule: input.skuPrefix ? { prefix: input.skuPrefix } : {},
      },
    });
    await tx.eushipmentsSettings.create({ data: { accountId: actor.accountId, connectionId: c.id } });
    return c;
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "eushipments.connection_create",
    entityType: "FulfillmentConnection",
    entityId: connection.id,
    after: {
      name: connection.name,
      companyId: company.id,
      vendorCompanyId: input.vendorCompanyId ?? null,
      skuPrefix: input.skuPrefix ?? null,
      reusedCredential: !!input.credentialId,
      liveMode: "READ_ONLY",
    },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return connection;
}

export async function listEuConnections(ctx: {
  accountId: string;
  companyScope: CompanyScope;
  activeCompanyId: string | null;
}) {
  return accountDb(ctx.accountId).fulfillmentConnection.findMany({
    where: { type: "EUSHIPMENTS", ...companyFilter(ctx) },
    include: {
      company: { select: { name: true } },
      credential: { select: { label: true, hint: true } },
      eushipmentsSyncs: true,
      eushipmentsVendorCompanies: { select: { vendorCompanyId: true, name: true } },
    },
    orderBy: { name: "asc" },
  });
}

/** One euShipments connection, or not_found when it is outside the member's companies. */
export async function getEuConnection(actor: Pick<ScopedActor, "accountId" | "companyScope">, id: string) {
  const c = await accountDb(actor.accountId).fulfillmentConnection.findUnique({
    where: { id },
    include: {
      company: { select: { id: true, name: true } },
      credential: { select: { label: true, hint: true } },
      eushipmentsSettings: true,
      eushipmentsSyncs: true,
      eushipmentsVendorCompanies: { orderBy: { name: "asc" } },
    },
  });
  if (!c || c.type !== "EUSHIPMENTS") throw new DomainError("not_found");
  if (actor.companyScope && (!c.companyId || !actor.companyScope.includes(c.companyId)))
    throw new DomainError("not_found");
  const ids = EuVendorIds.safeParse(c.vendorIds);
  return { ...c, vendorCompanyId: ids.success ? ids.data.companyId : null };
}

export const EuSettingsInput = z.object({
  name: z.string().trim().min(1).max(200),
  companyId: z.string().min(1),
  vendorCompanyId: VendorCompanyId.nullable(),
  skuPrefix: SkuPrefix,
  acceptedAlertHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 14),
  acceptedAlertWorkDays: z.boolean(),
  cashReceiptCod: z.boolean(),
  canaryDailyCap: z.coerce.number().int().min(1).max(500),
  enabled: z.boolean(),
});

/**
 * Settings. The euShipments company cannot change once shipments were sent through the connection (their
 * references and products live under the old company).
 */
export async function updateEuConnection(
  actor: ScopedActor,
  id: string,
  raw: z.input<typeof EuSettingsInput>,
) {
  assertCan(actor.role, "connections.manage");
  const input = EuSettingsInput.parse(raw);
  const before = await getEuConnection(actor, id);
  assertCompany(actor, input.companyId);
  const db = accountDb(actor.accountId);
  if (!(await db.company.findFirst({ where: { id: input.companyId, archivedAt: null } })))
    throw new DomainError("not_found");
  if (input.vendorCompanyId !== before.vendorCompanyId) {
    if (input.vendorCompanyId) await assertVendorCompanyFree(actor.accountId, input.vendorCompanyId, id);
    if (before.vendorCompanyId && (await db.fulfillment.count({ where: { connectionId: id } })) > 0)
      throw new DomainError("company_locked");
  }
  // More sends a day in CANARY is a step towards LIVE: an OWNER decision like the mode itself.
  if (input.canaryDailyCap > before.canaryDailyCap) assertCan(actor.role, "connections.raiseMode");
  const settings = {
    acceptedAlertHours: input.acceptedAlertHours,
    acceptedAlertWorkDays: input.acceptedAlertWorkDays,
    cashReceiptCod: input.cashReceiptCod,
  };
  await withAccountTransaction(actor.accountId, async (tx) => {
    await tx.fulfillmentConnection.update({
      where: { id },
      data: {
        name: input.name,
        companyId: input.companyId,
        vendorIds: input.vendorCompanyId ? { companyId: input.vendorCompanyId } : {},
        skuPrefixRule: input.skuPrefix ? { prefix: input.skuPrefix } : {},
        canaryDailyCap: input.canaryDailyCap,
        enabled: input.enabled,
      },
    });
    await tx.eushipmentsSettings.upsert({
      where: { accountId_connectionId: { accountId: actor.accountId, connectionId: id } },
      create: { accountId: actor.accountId, connectionId: id, ...settings },
      update: settings,
    });
    // A different company (or token) must pass the connection test again before the pollers read it.
    if (input.vendorCompanyId !== before.vendorCompanyId)
      await tx.eushipmentsSync.updateMany({
        where: { connectionId: id, kind: "connection" },
        data: { lastOkAt: null, lastError: "company_changed" },
      });
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "eushipments.connection_settings",
    entityType: "FulfillmentConnection",
    entityId: id,
    before: {
      name: before.name,
      companyId: before.companyId,
      vendorCompanyId: before.vendorCompanyId,
      skuPrefixRule: before.skuPrefixRule,
      canaryDailyCap: before.canaryDailyCap,
      enabled: before.enabled,
      acceptedAlertHours: before.eushipmentsSettings?.acceptedAlertHours ?? null,
      acceptedAlertWorkDays: before.eushipmentsSettings?.acceptedAlertWorkDays ?? null,
      cashReceiptCod: before.eushipmentsSettings?.cashReceiptCod ?? null,
    },
    after: input,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

/** New token (rotation in the euShipments cabinet). The old credential row stays for audit / other users. */
export async function replaceEuToken(actor: ScopedActor, id: string, rawToken: string) {
  assertCan(actor.role, "connections.manage");
  const token = Token.parse(rawToken);
  await getEuConnection(actor, id);
  const db = accountDb(actor.accountId);
  const view = await saveCredential(db, actor.accountId, {
    label: "euShipments token",
    secret: token,
    userId: actor.userId,
  });
  await withAccountTransaction(actor.accountId, async (tx) => {
    await tx.fulfillmentConnection.update({ where: { id }, data: { credentialId: view.id } });
    await tx.eushipmentsSync.updateMany({
      where: { connectionId: id, kind: "connection" },
      data: { lastOkAt: null, lastError: "token_changed" },
    });
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "eushipments.token_replace",
    entityType: "FulfillmentConnection",
    entityId: id,
    after: { credentialId: view.id, hint: view.hint },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

/**
 * Mode change. Raising needs an OWNER (setConnectionMode checks and audits) and a ready connection: token,
 * euShipments company and a passed connection test. Lowering is always possible for admins.
 */
export async function setEuConnectionMode(actor: ScopedActor, id: string, mode: LiveMode) {
  const c = await getEuConnection(actor, id);
  const RANK: Record<LiveMode, number> = { READ_ONLY: 0, DRY_RUN: 1, CANARY: 2, LIVE: 3 };
  if (RANK[mode] > RANK[c.liveMode]) {
    assertCan(actor.role, "connections.raiseMode");
    const test = c.eushipmentsSyncs.find((s) => s.kind === "connection");
    if (!c.credentialId || !c.vendorCompanyId || !test?.lastOkAt || test.lastError)
      throw new DomainError("not_ready");
  }
  return setConnectionMode(actor, id, mode);
}

// ───────────────────────── product links (unmatched work queue) ─────────────────────────

export const LinkVendorProductInput = z.object({
  vendorProductId: z.string().min(1),
  /** Master SKU to link to (exact, case-insensitive), or empty to unlink. */
  sku: z.string().trim().max(100),
});

/** Operator link euShipments product → master Product (never by EAN). Audited. */
export async function linkEuVendorProduct(actor: ScopedActor, raw: z.input<typeof LinkVendorProductInput>) {
  assertCan(actor.role, "products.match");
  const input = LinkVendorProductInput.parse(raw);
  const db = accountDb(actor.accountId);
  const vp = await db.vendorProduct.findUnique({ where: { id: input.vendorProductId } });
  if (!vp) throw new DomainError("not_found");
  await getEuConnection(actor, vp.connectionId);
  let productId: string | null = null;
  if (input.sku) {
    const products = await db.product.findMany({
      where: { sku: { equals: input.sku, mode: "insensitive" }, archived: false },
      select: { id: true },
      take: 2,
    });
    if (products.length !== 1) throw new DomainError(products.length ? "ambiguous_sku" : "unknown_sku");
    productId = products[0]!.id;
  }
  await db.vendorProduct.update({ where: { id: vp.id }, data: { productId } });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "eushipments.product_link",
    entityType: "VendorProduct",
    entityId: vp.id,
    before: { productId: vp.productId },
    after: { productId, sku: input.sku || null },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}
