import { z } from "zod";
import type { InventoryPushMode, StoreWriteMode } from "@/generated/prisma/client";
import { DomainError, type Actor } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { companyFilter, type CompanyScope } from "@/server/companies";
import { accountDb, isUniqueViolation } from "@/server/db/client";
import { readCredentialSecret, saveCredential } from "@/server/security/credentials";
import { normaliseShopDomain } from "@/integrations/shopify/config";
import { AppCredentials, parseAppCredentials } from "@/integrations/shopify/credentials";

/**
 * Shopify stores. A store belongs to one company of the group. Its Dev Dashboard app credentials
 * (client id + secret) live encrypted in the vault; one app may serve many stores, so a credential can be
 * shared. Nothing here talks to Shopify: connection tests, syncs and webhook registration are worker jobs.
 */

export type ScopedActor = Actor & { companyScope: CompanyScope };

const Code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,5}$/, "code");
const Countries = z
  .array(
    z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/),
  )
  .max(60);

export const NewStoreInput = z.object({
  companyId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  domain: z.string().transform((d, ctx) => {
    try {
      return normaliseShopDomain(d);
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid_shop_domain" });
      return z.NEVER;
    }
  }),
  code: Code,
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/),
  countries: Countries.default([]),
  /** Either an existing Shopify-app credential of the group, or a new client id + secret. */
  credentialId: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

function assertCompanyAllowed(actor: ScopedActor, companyId: string) {
  if (actor.companyScope && !actor.companyScope.includes(companyId)) throw new DomainError("not_found");
}

export async function createStore(actor: ScopedActor, raw: z.input<typeof NewStoreInput>) {
  assertCan(actor.role, "stores.manage");
  const input = NewStoreInput.parse(raw);
  assertCompanyAllowed(actor, input.companyId);
  const db = accountDb(actor.accountId);
  const company = await db.company.findFirst({ where: { id: input.companyId, archivedAt: null } });
  if (!company) throw new DomainError("not_found");

  let credentialId = input.credentialId;
  if (credentialId) {
    // Only a Shopify app credential of this group may be reused (not, say, a warehouse API key).
    try {
      parseAppCredentials(await readCredentialSecret(db, actor.accountId, credentialId));
    } catch {
      throw new DomainError("invalid_credential");
    }
  } else {
    const creds = AppCredentials.parse({ clientId: input.clientId, clientSecret: input.clientSecret });
    const view = await saveCredential(db, actor.accountId, {
      label: `Shopify app ${creds.clientId.slice(0, 8)}…`,
      secret: JSON.stringify(creds),
      userId: actor.userId,
    });
    credentialId = view.id;
  }

  let store;
  try {
    store = await db.store.create({
      data: {
        accountId: actor.accountId,
        companyId: company.id,
        name: input.name,
        domain: input.domain,
        code: input.code,
        currency: input.currency,
        countries: input.countries,
        credentialId,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("store_exists");
    throw err;
  }
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "store.create",
    entityType: "Store",
    entityId: store.id,
    after: { name: store.name, domain: store.domain, code: store.code, companyId: company.id },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return store;
}

export async function listStores(ctx: {
  accountId: string;
  companyScope: CompanyScope;
  activeCompanyId: string | null;
}) {
  return accountDb(ctx.accountId).store.findMany({
    where: companyFilter(ctx),
    include: { company: { select: { name: true } }, credential: { select: { label: true, hint: true } } },
    orderBy: [{ company: { name: "asc" } }, { name: "asc" }],
  });
}

/** One store, or not_found when it is outside the member's companies. */
export async function getStore(actor: ScopedActor, storeId: string) {
  const store = await accountDb(actor.accountId).store.findUnique({ where: { id: storeId } });
  if (!store || (actor.companyScope && !actor.companyScope.includes(store.companyId ?? ""))) {
    throw new DomainError("not_found");
  }
  return store;
}

const WRITE_RANK: Record<StoreWriteMode, number> = { READ_ONLY: 0, DRY_RUN: 1, LIVE: 2 };
const PUSH_RANK: Record<InventoryPushMode, number> = { DISABLED: 0, DRY_RUN: 1, LIVE: 2 };

export const StoreSettingsInput = z.object({
  name: z.string().trim().min(1).max(200),
  countries: Countries,
  codGateways: z.array(z.string().trim().min(1).max(100)).max(20),
  skuPrefix: z
    .string()
    .trim()
    .max(20)
    .transform((v) => v || null),
  notifyCustomer: z.boolean(),
  writeBackMode: z.enum(["READ_ONLY", "DRY_RUN", "LIVE"]),
  inventoryPushMode: z.enum(["DISABLED", "DRY_RUN", "LIVE"]),
  inventoryBuffer: z.number().int().min(0).max(10_000),
});

/** Settings; raising write-back or inventory push towards LIVE is an OWNER decision (INTEGRATION_NOTES §6). */
export async function updateStoreSettings(
  actor: ScopedActor,
  storeId: string,
  raw: z.input<typeof StoreSettingsInput>,
) {
  assertCan(actor.role, "stores.manage");
  const input = StoreSettingsInput.parse(raw);
  const before = await getStore(actor, storeId);
  if (
    WRITE_RANK[input.writeBackMode] > WRITE_RANK[before.writeBackMode] ||
    PUSH_RANK[input.inventoryPushMode] > PUSH_RANK[before.inventoryPushMode]
  ) {
    assertCan(actor.role, "stores.raiseMode");
  }
  const after = await accountDb(actor.accountId).store.update({ where: { id: storeId }, data: input });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "store.settings",
    entityType: "Store",
    entityId: storeId,
    before: {
      name: before.name,
      countries: before.countries,
      codGateways: before.codGateways,
      skuPrefix: before.skuPrefix,
      notifyCustomer: before.notifyCustomer,
      writeBackMode: before.writeBackMode,
      inventoryPushMode: before.inventoryPushMode,
      inventoryBuffer: before.inventoryBuffer,
    },
    after: input,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return after;
}

/** Replaces the store's app credentials (new client secret after a rotation in the Dev Dashboard). */
export async function replaceStoreCredentials(
  actor: ScopedActor,
  storeId: string,
  raw: { clientId?: string; clientSecret?: string },
) {
  assertCan(actor.role, "credentials.write");
  const store = await getStore(actor, storeId);
  const creds = AppCredentials.parse(raw);
  const db = accountDb(actor.accountId);
  const view = await saveCredential(db, actor.accountId, {
    label: `Shopify app ${creds.clientId.slice(0, 8)}…`,
    secret: JSON.stringify(creds),
    userId: actor.userId,
  });
  // The old test result says nothing about the new secret: back to "not tested" until the worker re-tests.
  await db.store.update({ where: { id: store.id }, data: { credentialId: view.id, connectionStatus: {} } });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "store.credentials",
    entityType: "Store",
    entityId: store.id,
    after: { credential: view.hint },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}
