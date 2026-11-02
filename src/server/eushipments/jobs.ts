import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { systemDb } from "@/server/db/client";
import { QUEUES } from "@/server/jobs/queues";
import { EuVendorIds } from "./connection";
import {
  pollEuBookings,
  pollEuCod,
  pollEuOrders,
  syncEuCities,
  syncEuProducts,
  syncEuReference,
  syncEuStock,
  testEuConnection,
} from "./read";

/** Every payload names its account, so failures show up in that account's dead-letter view only. */
export const EuConnectionJob = z.object({ accountId: z.string().min(1), connectionId: z.string().min(1) });
export type EuConnectionJob = z.infer<typeof EuConnectionJob>;
export const EuCitiesJob = EuConnectionJob.extend({ countryId: z.number().int().positive() });
export type EuCitiesJob = z.infer<typeof EuCitiesJob>;

/**
 * Zod at the queue boundary: a malformed payload is never run. It throws, so pg-boss fails the job and it ends
 * in the dead-letter queue (QUEUES options) instead of doing anything with half an id.
 */
export function parseEuJob<T>(schema: z.ZodType<T>, data: unknown, queue: string): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  logger.error({ queue, issues: r.error.issues.map((i) => i.path.join(".")) }, "malformed eushipments job");
  throw new Error(`malformed ${queue} job payload`);
}

const one = (queue: string) => (boss: PgBoss, d: EuConnectionJob) =>
  boss.send(queue, d, { singletonKey: d.connectionId });

export const enqueueEu = {
  testConnection: one(QUEUES.eushipmentsTestConnection.name),
  syncReference: one(QUEUES.eushipmentsSyncReference.name),
  syncProducts: one(QUEUES.eushipmentsSyncProducts.name),
  syncStock: one(QUEUES.eushipmentsSyncStock.name),
  pollOrders: one(QUEUES.eushipmentsPollOrders.name),
  pollBookings: one(QUEUES.eushipmentsPollBookings.name),
  pollCod: one(QUEUES.eushipmentsPollCod.name),
  syncCities: (boss: PgBoss, d: EuCitiesJob) =>
    boss.send(QUEUES.eushipmentsSyncCities.name, d, { singletonKey: `${d.connectionId}:${d.countryId}` }),
};

/** Kinds an operator may start by hand from the connection screen. */
export const MANUAL_SYNCS = ["test", "reference", "products", "stock", "orders", "bookings", "cod"] as const;
export type ManualSync = (typeof MANUAL_SYNCS)[number];

export function enqueueManualSync(boss: PgBoss, kind: ManualSync, d: EuConnectionJob) {
  switch (kind) {
    case "test":
      return enqueueEu.testConnection(boss, d);
    case "reference":
      return enqueueEu.syncReference(boss, d);
    case "products":
      return enqueueEu.syncProducts(boss, d);
    case "stock":
      return enqueueEu.syncStock(boss, d);
    case "orders":
      return enqueueEu.pollOrders(boss, d);
    case "bookings":
      return enqueueEu.pollBookings(boss, d);
    case "cod":
      return enqueueEu.pollCod(boss, d);
  }
}

/**
 * Connections the pollers may read: enabled, with a token, a company and a passed connection test.
 * The connection row list is the one cross-account read (cron has no account); every job then runs scoped.
 */
export async function usableEuConnections() {
  const rows = await systemDb().fulfillmentConnection.findMany({
    where: { type: "EUSHIPMENTS", enabled: true, credentialId: { not: null } },
    select: {
      id: true,
      accountId: true,
      vendorIds: true,
      eushipmentsSyncs: { where: { kind: "connection" }, select: { lastOkAt: true, lastError: true } },
    },
  });
  return rows.filter((r) => {
    const test = r.eushipmentsSyncs[0];
    return EuVendorIds.safeParse(r.vendorIds).success && !!test?.lastOkAt && !test.lastError;
  });
}

export async function registerEushipmentsWorkers(boss: PgBoss, opts: { pollingIntervalSeconds: number }) {
  const each =
    (queue: string, fn: (accountId: string, connectionId: string) => Promise<unknown>) =>
    async (jobs: { data: EuConnectionJob }[]) => {
      for (const job of jobs) {
        const data = parseEuJob(EuConnectionJob, job.data, queue);
        const info = await fn(data.accountId, data.connectionId);
        logger.info({ connectionId: data.connectionId, info }, "eushipments sync done");
      }
    };

  await boss.work<EuConnectionJob>(QUEUES.eushipmentsTestConnection.name, opts, async (jobs) => {
    for (const job of jobs) {
      const data = parseEuJob(EuConnectionJob, job.data, QUEUES.eushipmentsTestConnection.name);
      const info = await testEuConnection(data.accountId, data.connectionId);
      // A good test with a company chosen starts the first mirrors.
      if (info.companyVisible) {
        await enqueueEu.syncReference(boss, data);
        await enqueueEu.syncProducts(boss, data);
        await enqueueEu.syncStock(boss, data);
      }
    }
  });
  await boss.work<EuConnectionJob>(
    QUEUES.eushipmentsSyncReference.name,
    opts,
    each(QUEUES.eushipmentsSyncReference.name, syncEuReference),
  );
  await boss.work<EuConnectionJob>(
    QUEUES.eushipmentsSyncProducts.name,
    opts,
    each(QUEUES.eushipmentsSyncProducts.name, syncEuProducts),
  );
  await boss.work<EuConnectionJob>(
    QUEUES.eushipmentsSyncStock.name,
    opts,
    each(QUEUES.eushipmentsSyncStock.name, syncEuStock),
  );
  await boss.work<EuConnectionJob>(
    QUEUES.eushipmentsPollOrders.name,
    opts,
    each(QUEUES.eushipmentsPollOrders.name, pollEuOrders),
  );
  await boss.work<EuConnectionJob>(
    QUEUES.eushipmentsPollBookings.name,
    opts,
    each(QUEUES.eushipmentsPollBookings.name, pollEuBookings),
  );
  await boss.work<EuConnectionJob>(
    QUEUES.eushipmentsPollCod.name,
    opts,
    each(QUEUES.eushipmentsPollCod.name, pollEuCod),
  );
  await boss.work<EuCitiesJob>(QUEUES.eushipmentsSyncCities.name, opts, async (jobs) => {
    for (const job of jobs) {
      const data = parseEuJob(EuCitiesJob, job.data, QUEUES.eushipmentsSyncCities.name);
      await syncEuCities(data.accountId, data.connectionId, data.countryId);
    }
  });

  await boss.work(QUEUES.eushipmentsTick.name, opts, async () => {
    const conns = await usableEuConnections();
    for (const c of conns) {
      const d = { accountId: c.accountId, connectionId: c.id };
      await enqueueEu.syncProducts(boss, d);
      await enqueueEu.syncStock(boss, d);
      await enqueueEu.pollOrders(boss, d);
      await enqueueEu.pollBookings(boss, d);
    }
    if (conns.length) logger.info({ connections: conns.length }, "eushipments tick queued");
  });
  await boss.work(QUEUES.eushipmentsDaily.name, opts, async () => {
    // Re-test every connection with a token once a day, so a transient failure does not stop polling for good.
    const all = await systemDb().fulfillmentConnection.findMany({
      where: { type: "EUSHIPMENTS", enabled: true, credentialId: { not: null } },
      select: { id: true, accountId: true },
    });
    for (const c of all) await enqueueEu.testConnection(boss, { accountId: c.accountId, connectionId: c.id });
    for (const c of await usableEuConnections()) {
      const d = { accountId: c.accountId, connectionId: c.id };
      await enqueueEu.syncReference(boss, d);
      await enqueueEu.pollCod(boss, d);
    }
  });
}
