import type { AlertSeverity, ConnectionType, LiveMode, StoreWriteMode } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/server/audit";
import { accountDb, systemDb, withAccountTransaction } from "@/server/db/client";

/**
 * What the watcher does when something breaks: raise an alert (deduplicated while one is still open) and drop
 * the affected connection/store to DRY_RUN. It only ever LOWERS a mode — READ_ONLY and DRY_RUN stay as they
 * are, and only an OWNER can raise a mode again (INTEGRATION_NOTES §6). Every drop is audit-logged.
 */

export const ALERT_KINDS = {
  specChange: "api.spec_change",
  specFetchFailed: "api.spec_fetch_failed",
  shopifyVersion: "api.shopify_version",
  liveCheck: "api.live_check",
  liveCheckFailed: "api.live_check_failed",
} as const;

export interface AlertInput {
  kind: string;
  severity: AlertSeverity;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
}

const BODY_MAX = 20_000;

/** Creates the alert unless one of the same kind for the same entity is still open. Returns true if created. */
export async function raiseAlert(accountId: string, a: AlertInput): Promise<boolean> {
  const db = accountDb(accountId);
  const open = await db.alert.findFirst({
    where: {
      kind: a.kind,
      entityType: a.entityType ?? null,
      entityId: a.entityId ?? null,
      status: { not: "RESOLVED" },
    },
    select: { id: true },
  });
  if (open) return false;
  await db.alert.create({
    data: {
      accountId,
      kind: a.kind,
      severity: a.severity,
      title: a.title.slice(0, 300),
      body: a.body?.slice(0, BODY_MAX) ?? null,
      entityType: a.entityType ?? null,
      entityId: a.entityId ?? null,
    },
  });
  return true;
}

/** Vendor specs are global: every account (group) gets the alert for its admins. */
export async function raiseAlertEverywhere(a: AlertInput): Promise<number> {
  const accounts = await systemDb().account.findMany({ select: { id: true } });
  let created = 0;
  for (const { id } of accounts) if (await raiseAlert(id, a)) created++;
  return created;
}

const LOWER_CONNECTION: readonly LiveMode[] = ["CANARY", "LIVE"];

export interface DemoteResult {
  demoted: boolean;
  before?: string;
}

/** Drops one fulfilment connection to DRY_RUN if it is in CANARY or LIVE. */
export async function demoteConnection(
  accountId: string,
  connectionId: string,
  reason: string,
): Promise<DemoteResult> {
  const result = await withAccountTransaction(accountId, async (tx, h) => {
    await h.lockForUpdate("FulfillmentConnection", connectionId);
    const c = await tx.fulfillmentConnection.findUnique({
      where: { id: connectionId },
      select: { liveMode: true },
    });
    if (!c || !LOWER_CONNECTION.includes(c.liveMode)) return { demoted: false } as DemoteResult;
    await tx.fulfillmentConnection.update({ where: { id: connectionId }, data: { liveMode: "DRY_RUN" } });
    if (c.liveMode === "CANARY") {
      // Same as setConnectionMode: requests waiting for a CANARY click go back to the queue and are evaluated
      // under DRY_RUN; confirmations do not carry over.
      await tx.outboundRequest.updateMany({
        where: { connectionId, status: "AWAITING_CONFIRMATION" },
        data: {
          status: "PENDING",
          nextAttemptAt: null,
          confirmedAt: null,
          confirmedById: null,
          lastError: null,
        },
      });
    }
    return { demoted: true, before: c.liveMode };
  });
  if (result.demoted) {
    await recordAudit({
      accountId,
      action: "connection.mode_change",
      entityType: "FulfillmentConnection",
      entityId: connectionId,
      before: { liveMode: result.before },
      after: { liveMode: "DRY_RUN", reason },
    });
    logger.warn({ accountId, connectionId, before: result.before }, "connection dropped to DRY_RUN");
  }
  return result;
}

/** Drops a store's Shopify write-back and inventory push from LIVE to DRY_RUN (conditional update: never raises). */
export async function demoteStore(accountId: string, storeId: string, reason: string): Promise<DemoteResult> {
  const prev = await withAccountTransaction(accountId, async (tx) => {
    const s = await tx.store.findUnique({
      where: { id: storeId },
      select: { writeBackMode: true, inventoryPushMode: true },
    });
    if (!s) return null;
    const wb = await tx.store.updateMany({
      where: { id: storeId, writeBackMode: "LIVE" },
      data: { writeBackMode: "DRY_RUN" satisfies StoreWriteMode },
    });
    const inv = await tx.store.updateMany({
      where: { id: storeId, inventoryPushMode: "LIVE" },
      data: { inventoryPushMode: "DRY_RUN" },
    });
    return wb.count + inv.count > 0 ? s : null;
  });
  if (!prev) return { demoted: false };
  await recordAudit({
    accountId,
    action: "store.mode.autoLower",
    entityType: "Store",
    entityId: storeId,
    before: prev,
    after: {
      writeBackMode: prev.writeBackMode === "LIVE" ? "DRY_RUN" : prev.writeBackMode,
      inventoryPushMode: prev.inventoryPushMode === "LIVE" ? "DRY_RUN" : prev.inventoryPushMode,
      reason,
    },
  });
  logger.warn({ accountId, storeId }, "store write modes dropped to DRY_RUN");
  return { demoted: true, before: `${prev.writeBackMode}/${prev.inventoryPushMode}` };
}

/** Breaking spec change: every CANARY/LIVE connection of that vendor, in every account, drops to DRY_RUN. */
export async function demoteVendorConnections(type: ConnectionType, reason: string) {
  const conns = await systemDb().fulfillmentConnection.findMany({
    where: { type, liveMode: { in: [...LOWER_CONNECTION] } },
    select: { id: true, accountId: true },
  });
  const demoted: { accountId: string; id: string }[] = [];
  for (const c of conns) {
    if ((await demoteConnection(c.accountId, c.id, reason)).demoted) demoted.push(c);
  }
  return demoted;
}
