import { z } from "zod";
import type { CrmOrderStatus } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, isUniqueViolation, withAccountTransaction } from "@/server/db/client";
import { Countries, Currency, ShopDomain, StoreCode, getStore, type ScopedActor } from "@/server/stores";

/**
 * Full editing, archiving and deleting of a store (owner request "пълна редакция на всеки магазин и да може да
 * се изтрива"). Nothing here talks to Shopify: after a domain change, an archive or a restore the caller queues
 * the connection test / webhook jobs, and webhook removal is a worker job (src/server/shopify/jobs.ts).
 *
 * Safety rules:
 * - Warehouse order ids are the Shopify order number with the store's optional vendorIdPrefix (owner request
 *   2026-11-03). The store code is internal only, so it may change any time. A changed prefix applies to new
 *   shipments only: every shipment keeps the externalId it was stored with, re-submits reuse it, and the
 *   (connectionId, externalId) unique index makes a duplicate impossible.
 * - A different domain is a different shop: editable only while nothing was imported from or written to it.
 * - Delete only an empty store (no orders, fulfillments, write-backs, inventory pushes, routing rules); anything
 *   with history is archived instead. Orders are never deleted or moved.
 */

/** Orders the warehouse has not received yet: they stay where they are when the store is archived. */
export const NOT_SENT_STATUSES: CrmOrderStatus[] = [
  "IMPORTED",
  "CHECKING",
  "NEEDS_REVIEW",
  "READY",
  "APPROVED",
  "QUEUED",
  "SUBMIT_FAILED",
  "ON_HOLD",
  "AWAITING_TAG",
];

export interface StoreUsage {
  orders: number;
  notSent: number;
  fulfillments: number;
  writeBacks: number;
  inventoryPushes: number;
  routingRules: number;
  matchedVariants: number;
}

type UsageDb = Pick<
  ReturnType<typeof accountDb>,
  "order" | "fulfillment" | "shopifyWriteBack" | "inventoryPush" | "routingRule" | "storeVariantLink"
>;

const ruleUsesStore = (match: unknown, storeId: string) => {
  const ids = (match as { storeIds?: unknown } | null)?.storeIds;
  return Array.isArray(ids) && ids.includes(storeId);
};

async function usageWith(db: UsageDb, storeId: string): Promise<StoreUsage> {
  const [orders, notSent, fulfillments, writeBacks, inventoryPushes, rules, matchedVariants] =
    await Promise.all([
      db.order.count({ where: { storeId } }),
      db.order.count({ where: { storeId, status: { in: NOT_SENT_STATUSES } } }),
      db.fulfillment.count({ where: { order: { storeId } } }),
      db.shopifyWriteBack.count({ where: { storeId } }),
      db.inventoryPush.count({ where: { storeId } }),
      db.routingRule.findMany({ select: { match: true } }),
      db.storeVariantLink.count({ where: { storeId, productId: { not: null } } }),
    ]);
  return {
    orders,
    notSent,
    fulfillments,
    writeBacks,
    inventoryPushes,
    routingRules: rules.filter((r) => ruleUsesStore(r.match, storeId)).length,
    matchedVariants,
  };
}

export function storeUsage(accountId: string, storeId: string) {
  return usageWith(accountDb(accountId), storeId);
}

/** Why the code / domain cannot be changed (an i18n error key), or null when it can. */
export function storeEditLocks(u: StoreUsage) {
  return {
    code: null as string | null,
    domain: u.orders > 0 || u.writeBacks > 0 || u.inventoryPushes > 0 ? "domain_locked" : null,
  } as const;
}

/** Every reason the store cannot be deleted (i18n error keys); empty = it may be deleted. */
export function deleteBlockers(u: StoreUsage): string[] {
  const out: string[] = [];
  if (u.orders) out.push("has_orders");
  if (u.fulfillments) out.push("has_fulfillments");
  if (u.writeBacks) out.push("has_write_backs");
  if (u.inventoryPushes) out.push("has_inventory_pushes");
  if (u.routingRules) out.push("in_routing_rules");
  return out;
}

/** The modes of a new connection: nothing is written to the shop until an OWNER raises them. */
const SAFE_MODES = { writeBackMode: "READ_ONLY", inventoryPushMode: "DISABLED" } as const;

export const StoreDetailsInput = z.object({
  name: z.string().trim().min(1).max(200),
  companyId: z.string().min(1).max(64),
  currency: Currency,
  countries: Countries,
  domain: ShopDomain,
  code: StoreCode,
  /** "" / absent = the Shopify order number as it is. */
  vendorIdPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([A-Z0-9]{1,10})?$/, "prefix")
    .optional()
    .transform((v) => (v ? v : null)),
});

const detailsOf = (s: {
  name: string;
  companyId: string | null;
  currency: string;
  countries: string[];
  domain: string;
  code: string;
  vendorIdPrefix?: string | null;
}) => ({
  name: s.name,
  companyId: s.companyId,
  currency: s.currency,
  countries: s.countries,
  domain: s.domain,
  code: s.code,
  vendorIdPrefix: s.vendorIdPrefix ?? null,
});

/**
 * "Данни на магазина": name, company, currency, countries, Shopify domain, code, warehouse prefix (OWNER/ADMIN,
 * audited).
 * Moving the store to another company affects only orders imported from now on: existing orders keep their
 * companyId. With matched variants the new company must be in the same product line (matching never crosses lines).
 */
export async function updateStoreDetails(
  actor: ScopedActor,
  storeId: string,
  raw: z.input<typeof StoreDetailsInput>,
) {
  assertCan(actor.role, "stores.manage");
  const input = StoreDetailsInput.parse(raw);
  const before = await getStore(actor, storeId);
  if (before.archivedAt) throw new DomainError("store_archived");
  if (actor.companyScope && !actor.companyScope.includes(input.companyId)) throw new DomainError("not_found");
  const db = accountDb(actor.accountId);
  const usage = await storeUsage(actor.accountId, storeId);
  const locks = storeEditLocks(usage);
  const codeChanged = input.code !== before.code;
  const domainChanged = input.domain !== before.domain;
  const companyChanged = input.companyId !== before.companyId;
  if (codeChanged && locks.code) throw new DomainError(locks.code);
  if (domainChanged && locks.domain) throw new DomainError(locks.domain);

  if (companyChanged) {
    const company = await db.company.findFirst({
      where: { id: input.companyId, archivedAt: null },
      select: { lineId: true },
    });
    if (!company) throw new DomainError("not_found");
    if (usage.matchedVariants > 0) {
      const old = before.companyId
        ? await db.company.findUnique({ where: { id: before.companyId }, select: { lineId: true } })
        : null;
      if ((old?.lineId ?? null) !== (company.lineId ?? null)) throw new DomainError("line_mismatch");
    }
  }
  if (codeChanged && (await db.store.findFirst({ where: { code: input.code, id: { not: storeId } } })))
    throw new DomainError("code_taken");
  if (domainChanged && (await db.store.findFirst({ where: { domain: input.domain, id: { not: storeId } } })))
    throw new DomainError("domain_taken");

  try {
    await withAccountTransaction(actor.accountId, async (tx, { lockKey }) => {
      await lockKey(`store:${storeId}`);
      if (codeChanged || domainChanged) {
        // Re-checked inside the transaction. The order import holds the same key (shared) while it inserts, so an
        // import running right now finishes first and is counted here, or starts after this change.
        const again = storeEditLocks(await usageWith(tx as unknown as UsageDb, storeId));
        if (codeChanged && again.code) throw new DomainError(again.code);
        if (domainChanged && again.domain) throw new DomainError(again.domain);
      }
      await tx.store.update({
        where: { id: storeId },
        data: {
          ...input,
          // A different shop: the old test result, webhooks and mirrors say nothing about it, and it starts
          // in the safe modes like a new connection (only an OWNER raises them again, audited).
          ...(domainChanged
            ? {
                connectionStatus: {},
                webhookStatus: {},
                shopName: null,
                syncCursors: {},
                ...SAFE_MODES,
              }
            : {}),
        },
      });
      if (domainChanged) {
        // Events of the old shop still waiting in the queue must not be imported into the new one.
        await tx.webhookEvent.updateMany({
          where: {
            source: "SHOPIFY",
            status: { in: ["RECEIVED", "FAILED"] },
            headers: { path: ["storeId"], equals: storeId },
          },
          data: { status: "IGNORED", processedAt: new Date(), error: "store_domain_changed" },
        });
        await tx.shopifyInventoryLevel.deleteMany({ where: { storeId } });
        await tx.storeVariantLink.deleteMany({ where: { storeId } });
        await tx.storeLocation.deleteMany({ where: { storeId } });
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("store_exists");
    throw err;
  }
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "store.details",
    entityType: "Store",
    entityId: storeId,
    before: {
      ...detailsOf(before),
      ...(domainChanged
        ? { writeBackMode: before.writeBackMode, inventoryPushMode: before.inventoryPushMode }
        : {}),
    },
    after: { ...input, ...(domainChanged ? SAFE_MODES : {}) },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  // The old shop may still hold our webhook subscriptions: the caller queues their removal (old domain).
  const oldShopWebhooks = domainChanged && needsWebhookRemoval(before) ? before.domain : null;
  return { domainChanged, companyChanged, codeChanged, oldShopWebhooks };
}

/** Archive (OWNER): jobs stop, webhooks are ignored and removed by a job, orders stay as history. Idempotent. */
export async function archiveStore(actor: ScopedActor, storeId: string) {
  assertCan(actor.role, "stores.archive");
  const store = await getStore(actor, storeId);
  const usage = await storeUsage(actor.accountId, storeId);
  if (store.archivedAt) return { archived: false, notSent: usage.notSent };
  const at = new Date();
  await accountDb(actor.accountId).store.update({
    where: { id: storeId },
    data: { archivedAt: at, archivedById: actor.userId },
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "store.archive",
    entityType: "Store",
    entityId: storeId,
    before: { archivedAt: null },
    after: { archivedAt: at.toISOString(), notSentOrders: usage.notSent },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { archived: true, notSent: usage.notSent };
}

/** "Възстанови" (OWNER): back to normal; the caller re-runs the connection test (which re-registers webhooks). */
export async function restoreStore(actor: ScopedActor, storeId: string) {
  assertCan(actor.role, "stores.archive");
  const store = await getStore(actor, storeId);
  if (!store.archivedAt) return { restored: false };
  await accountDb(actor.accountId).store.update({
    where: { id: storeId },
    // "Not tested" until the worker re-tests: the shop may have changed while the store was archived.
    // A pending delete request is dropped too; the test → registration fills webhookStatus again.
    data: { archivedAt: null, archivedById: null, connectionStatus: {}, webhookStatus: {} },
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "store.restore",
    entityType: "Store",
    entityId: storeId,
    before: { archivedAt: store.archivedAt.toISOString() },
    after: { archivedAt: null },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { restored: true };
}

export interface WebhookStatusView {
  ok?: boolean;
  at?: string;
  topics?: string[];
  errors?: string[];
  /** Subscriptions to our URL were removed (archive / delete). */
  removed?: boolean;
  /** Delete was asked for; the store is deleted as soon as the webhook removal succeeds. */
  deleteRequested?: boolean;
}

/** True when Shopify may still hold subscriptions of ours for this store (so they must be removed first). */
export function needsWebhookRemoval(store: { connectionStatus: unknown; webhookStatus: unknown }) {
  const ws = store.webhookStatus as WebhookStatusView;
  return (
    (store.connectionStatus as { ok?: boolean }).ok === true && !ws.removed && (ws.topics?.length ?? 0) > 0
  );
}

export const DeleteStoreInput = z.object({
  confirmCode: z.string().trim().toUpperCase(),
  /** Delete although the webhook removal failed (Shopify drops subscriptions that keep failing on its own). */
  force: z.boolean().default(false),
});

/**
 * "Изтрий магазина" (OWNER), only for a store without history; confirmed by typing the store code.
 * When Shopify may still hold our webhook subscriptions, the store is archived with deleteRequested and the
 * caller queues the removal job, which deletes the store once the removal succeeded (`pending: true`).
 */
export async function deleteStore(
  actor: ScopedActor,
  storeId: string,
  raw: z.input<typeof DeleteStoreInput>,
): Promise<{ pending: boolean }> {
  assertCan(actor.role, "stores.archive");
  const input = DeleteStoreInput.parse(raw);
  const store = await getStore(actor, storeId);
  if (input.confirmCode !== store.code) throw new DomainError("confirm_mismatch");
  const blockers = deleteBlockers(await storeUsage(actor.accountId, storeId));
  if (blockers.length) throw new DomainError(blockers[0]!);
  const ws = store.webhookStatus as WebhookStatusView;
  const removalFailed = ws.deleteRequested === true && ws.ok === false;
  if (needsWebhookRemoval(store) && !(input.force && removalFailed)) {
    const at = store.archivedAt ?? new Date();
    await accountDb(actor.accountId).store.update({
      where: { id: storeId },
      data: {
        archivedAt: at,
        archivedById: store.archivedById ?? actor.userId,
        webhookStatus: { ...ws, deleteRequested: true },
      },
    });
    await recordAudit({
      accountId: actor.accountId,
      userId: actor.userId,
      action: "store.delete_requested",
      entityType: "Store",
      entityId: storeId,
      before: { archivedAt: store.archivedAt?.toISOString() ?? null },
      after: { archivedAt: at.toISOString(), deleteRequested: true },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return { pending: true };
  }
  await purgeStore(actor.accountId, storeId, {
    userId: actor.userId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { pending: false };
}

/**
 * Removes the store and only its own rows (inventory levels, variant links, locations — never orders), plus its
 * vault credential when no other store or warehouse connection uses it. The delete guard is re-checked inside
 * the transaction. Called by deleteStore and by the webhook removal job. Returns false when the store is gone.
 */
export async function purgeStore(
  accountId: string,
  storeId: string,
  by: { userId?: string | null; ip?: string | null; userAgent?: string | null },
) {
  const result = await withAccountTransaction(accountId, async (tx, { lockKey }) => {
    await lockKey(`store:${storeId}`);
    const store = await tx.store.findUnique({ where: { id: storeId } });
    if (!store) return null;
    const blockers = deleteBlockers(await usageWith(tx as unknown as UsageDb, storeId));
    if (blockers.length) throw new DomainError(blockers[0]!);
    const removed = {
      inventoryLevels: (await tx.shopifyInventoryLevel.deleteMany({ where: { storeId } })).count,
      variantLinks: (await tx.storeVariantLink.deleteMany({ where: { storeId } })).count,
      locations: (await tx.storeLocation.deleteMany({ where: { storeId } })).count,
    };
    await tx.store.delete({ where: { id: storeId } });
    let credentialDeleted = false;
    if (store.credentialId) {
      const [stores, connections] = await Promise.all([
        tx.store.count({ where: { credentialId: store.credentialId } }),
        tx.fulfillmentConnection.count({ where: { credentialId: store.credentialId } }),
      ]);
      if (stores === 0 && connections === 0) {
        await tx.credential.delete({ where: { id: store.credentialId } });
        credentialDeleted = true;
      }
    }
    return { store, removed, credentialDeleted };
  });
  if (!result) return false;
  await recordAudit({
    accountId,
    userId: by.userId ?? null,
    action: "store.delete",
    entityType: "Store",
    entityId: storeId,
    before: { ...detailsOf(result.store), archivedAt: result.store.archivedAt?.toISOString() ?? null },
    after: { deleted: true, ...result.removed, credentialDeleted: result.credentialDeleted },
    ip: by.ip,
    userAgent: by.userAgent,
  });
  return true;
}
