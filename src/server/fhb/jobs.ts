import type { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { systemDb } from "@/server/db/client";
import { QUEUES } from "@/server/jobs/queues";
import { processFhbCallback, staleFhbEvents } from "./callbacks";
import { FHB_PERIODIC_RESOURCES, runFhbSync, type FhbSyncRequest } from "./sync";

/** Every payload names its account, so failures show up in that account's dead-letter view only. */
export interface FhbCallbackJob {
  accountId: string;
  eventId: string;
}

export interface FhbSyncJob extends FhbSyncRequest {
  accountId: string;
  connectionId: string;
}

export const fhbSyncKey = (d: FhbSyncJob) =>
  [d.connectionId, d.resource, d.service ?? "", d.country ?? "", d.externalId ?? ""].join(":");

export const enqueueFhb = {
  callback: (boss: PgBoss, d: FhbCallbackJob) =>
    boss.send(QUEUES.fhbCallback.name, d, { singletonKey: d.eventId }),
  sync: (boss: PgBoss, d: FhbSyncJob) => boss.send(QUEUES.fhbSync.name, d, { singletonKey: fhbSyncKey(d) }),
  /** Every periodic resource of one connection (after create, or the "sync now" button). */
  syncAll: async (boss: PgBoss, d: { accountId: string; connectionId: string; force?: boolean }) => {
    for (const resource of FHB_PERIODIC_RESOURCES) await enqueueFhb.sync(boss, { ...d, resource });
  },
};

export async function registerFhbWorkers(boss: PgBoss, opts: { pollingIntervalSeconds: number }) {
  await boss.work<FhbCallbackJob>(QUEUES.fhbCallback.name, opts, async (jobs) => {
    for (const { data } of jobs) await processFhbCallback(data.accountId, data.eventId);
  });

  await boss.work(QUEUES.fhbCallbackSweep.name, opts, async () => {
    const stale = await staleFhbEvents();
    for (const e of stale) {
      if (e.accountId) await enqueueFhb.callback(boss, { accountId: e.accountId, eventId: e.id });
    }
    if (stale.length) logger.info({ count: stale.length }, "fhb callbacks re-queued");
  });

  await boss.work<FhbSyncJob>(QUEUES.fhbSync.name, opts, async (jobs) => {
    for (const { data } of jobs) {
      const { accountId, connectionId, ...req } = data;
      const r = await runFhbSync(accountId, connectionId, req);
      if (!r.skipped) logger.info({ connectionId, resource: req.resource, count: r.count }, "fhb sync done");
    }
  });

  await boss.work(QUEUES.fhbReconcile.name, opts, async () => {
    const connections = await systemDb().fulfillmentConnection.findMany({
      where: { type: "FHB_V3", enabled: true, credentialId: { not: null } },
      select: { id: true, accountId: true },
    });
    for (const c of connections)
      await enqueueFhb.syncAll(boss, { accountId: c.accountId, connectionId: c.id });
    if (connections.length) logger.info({ connections: connections.length }, "fhb reconcile queued");
  });
}
