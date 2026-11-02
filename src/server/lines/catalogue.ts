import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction, type AccountTxHelpers } from "@/server/db/client";
import { PRE_APPROVAL } from "@/server/shopify/statuses";
import {
  assertLineInScope,
  connectionPrefix,
  lineMembers,
  lockLine,
  skuAfterPrefix,
  type ScopedActor,
} from "./lines";

/**
 * Master catalogue tool (P5-00): "Създай основни продукти от каталога на склад X". Creates master products of a
 * line from one warehouse connection's mirrored products (FHB / euShipments VendorProduct rows): SKU = vendor id
 * with the connection's SKU prefix stripped. No duplicates (case-insensitive SKU in the line); an existing master
 * without a line is adopted into the line; a SKU another line already uses is skipped and reported. Then links
 * that warehouse's products and auto-links everything else of the line by SKU after prefix (other warehouses of
 * the line's companies, their stores' variants). EAN/barcode and names are never keys (see suggestions.ts).
 *
 * Production has 800+ products per warehouse and a 512 MB worker: it runs as a background job (lines.catalogue),
 * in small transactions, with progress on the run row and a cursor so a retried job resumes where it stopped.
 * Every step is idempotent: running it twice creates nothing new.
 */

type Tx = Prisma.TransactionClient;

export const BATCH = 50;
const AUTOLINK_BATCH = 200;
const MAX_CONFLICT_SAMPLES = 20;
const RELINKABLE = [...PRE_APPROVAL];

export const StartInput = z.object({
  lineId: z.string().min(1).max(64),
  connectionId: z.string().min(1).max(64),
});

export type EnqueueCatalogue = (d: { accountId: string; runId: string; lineId: string }) => Promise<unknown>;

/** Starts (or returns the already waiting/running) run for this line + warehouse. The worker does the work. */
export async function startMasterCatalogue(
  actor: ScopedActor,
  raw: z.input<typeof StartInput>,
  enqueue: EnqueueCatalogue,
) {
  assertCan(actor.role, "lines.catalogue");
  const input = StartInput.parse(raw);
  await assertLineInScope(actor, input.lineId);
  const db = accountDb(actor.accountId);
  const connection = await db.fulfillmentConnection.findUnique({
    where: { id: input.connectionId },
    select: { id: true, type: true, companyId: true, company: { select: { lineId: true } } },
  });
  if (!connection || !["FHB_V3", "EUSHIPMENTS"].includes(connection.type)) throw new DomainError("not_found");
  if (connection.company?.lineId !== input.lineId) throw new DomainError("connection_not_in_line");
  if (actor.companyScope && !actor.companyScope.includes(connection.companyId ?? "")) {
    throw new DomainError("not_found");
  }
  const open = await db.masterCatalogueRun.findFirst({
    where: { lineId: input.lineId, connectionId: connection.id, status: { in: ["QUEUED", "RUNNING"] } },
  });
  const run =
    open ??
    (await db.masterCatalogueRun.create({
      data: {
        accountId: actor.accountId,
        lineId: input.lineId,
        connectionId: connection.id,
        createdById: actor.userId,
        total: await db.vendorProduct.count({ where: { connectionId: connection.id, archived: false } }),
      },
    }));
  await enqueue({ accountId: actor.accountId, runId: run.id, lineId: input.lineId });
  if (!open) {
    await recordAudit({
      accountId: actor.accountId,
      userId: actor.userId,
      action: "line.catalogue_started",
      entityType: "MasterCatalogueRun",
      entityId: run.id,
      after: { lineId: input.lineId, connectionId: connection.id },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }
  return run;
}

const nameOf = (raw: unknown, fallback: string) => {
  const n = raw && typeof raw === "object" ? (raw as { name?: unknown }).name : null;
  return typeof n === "string" && n.trim() ? n.trim().slice(0, 300) : fallback;
};

interface Counters {
  processed: number;
  created: number;
  linked: number;
  adopted: number;
  alreadyLinked: number;
  conflicts: number;
  samples: string[];
}

/** Masters of a line (and unassigned ones) whose SKU equals one of `skus`, case-insensitive. */
async function mastersBySku(tx: Tx, skus: string[]) {
  if (!skus.length) return [];
  return tx.product.findMany({
    where: { OR: skus.map((s) => ({ sku: { equals: s, mode: "insensitive" as const } })) },
    select: { id: true, sku: true, lineId: true, archived: true },
  });
}

/** One batch of the "masters" phase: create / adopt / link for up to BATCH vendor products. */
async function mastersBatch(
  tx: Tx,
  helpers: AccountTxHelpers,
  accountId: string,
  lineId: string,
  prefix: string,
  rows: { id: string; vendorId: string; productId: string | null; raw: unknown }[],
  c: Counters,
) {
  await lockLine(helpers, lineId);
  const skus = [
    ...new Set(rows.map((r) => skuAfterPrefix(r.vendorId, prefix)).filter((s): s is string => !!s)),
  ];
  const masters = await mastersBySku(tx, skus);
  const byLower = new Map<string, typeof masters>();
  for (const m of masters) byLower.set(m.sku.toLowerCase(), [...(byLower.get(m.sku.toLowerCase()) ?? []), m]);
  const linkedIds = rows.map((r) => r.productId).filter((p): p is string => !!p);
  const linkedProducts = linkedIds.length
    ? await tx.product.findMany({ where: { id: { in: linkedIds } }, select: { id: true, lineId: true } })
    : [];
  const lineOfLinked = new Map(linkedProducts.map((p) => [p.id, p.lineId]));

  for (const r of rows) {
    c.processed++;
    if (r.productId) {
      c.alreadyLinked++;
      const pl = lineOfLinked.get(r.productId);
      if (pl === null) {
        await tx.product.update({ where: { id: r.productId }, data: { lineId } });
        lineOfLinked.set(r.productId, lineId);
        c.adopted++;
      } else if (pl && pl !== lineId) {
        c.conflicts++;
        if (c.samples.length < MAX_CONFLICT_SAMPLES) c.samples.push(r.vendorId);
      }
      continue;
    }
    const sku = skuAfterPrefix(r.vendorId, prefix);
    if (!sku) continue;
    const candidates = (byLower.get(sku.toLowerCase()) ?? []).filter((m) => !m.archived);
    const inLine = candidates.filter((m) => m.lineId === lineId);
    const unassigned = candidates.filter((m) => m.lineId === null);
    const all = byLower.get(sku.toLowerCase()) ?? [];
    let productId: string | null = null;
    if (inLine.length === 1) productId = inLine[0]!.id;
    else if (inLine.length === 0 && unassigned.length === 1 && candidates.length === 1) {
      productId = unassigned[0]!.id;
      await tx.product.update({ where: { id: productId }, data: { lineId } });
      unassigned[0]!.lineId = lineId;
      c.adopted++;
    } else if (all.length === 0) {
      const created = await tx.product.create({
        data: { accountId, sku, name: nameOf(r.raw, sku), lineId },
        select: { id: true, sku: true, lineId: true, archived: true },
      });
      byLower.set(sku.toLowerCase(), [created]);
      productId = created.id;
      c.created++;
    }
    if (!productId) {
      // Another line (or an archived / case-ambiguous master) already uses this SKU: a person decides.
      c.conflicts++;
      if (c.samples.length < MAX_CONFLICT_SAMPLES) c.samples.push(sku);
      continue;
    }
    await tx.vendorProduct.update({ where: { id: r.id }, data: { productId } });
    c.linked++;
  }
}

/** Links unlinked vendor products and store variants of the line whose SKU after prefix is exactly one master of the line. */
export async function autoLinkLine(accountId: string, lineId: string): Promise<number> {
  const db = accountDb(accountId);
  const members = await lineMembers(accountId, lineId);
  let linked = 0;
  const matchIn = async (tx: Tx, skus: string[]) => {
    const masters = (await mastersBySku(tx, skus)).filter((m) => m.lineId === lineId && !m.archived);
    const byLower = new Map<string, string[]>();
    for (const m of masters)
      byLower.set(m.sku.toLowerCase(), [...(byLower.get(m.sku.toLowerCase()) ?? []), m.id]);
    return (sku: string | null) => {
      const ids = sku ? byLower.get(sku.toLowerCase()) : undefined;
      return ids && ids.length === 1 ? ids[0]! : null; // two masters differing by case: a person decides
    };
  };

  for (const conn of members.connections) {
    const prefix = connectionPrefix(conn.skuPrefixRule);
    let cursor: string | undefined;
    for (;;) {
      const rows = await db.vendorProduct.findMany({
        where: {
          connectionId: conn.id,
          archived: false,
          productId: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, vendorId: true },
        orderBy: { id: "asc" },
        take: AUTOLINK_BATCH,
      });
      if (!rows.length) break;
      cursor = rows[rows.length - 1]!.id;
      linked += await withAccountTransaction(accountId, async (tx) => {
        const match = await matchIn(
          tx,
          rows.map((r) => skuAfterPrefix(r.vendorId, prefix)).filter((s): s is string => !!s),
        );
        let n = 0;
        for (const r of rows) {
          const productId = match(skuAfterPrefix(r.vendorId, prefix));
          if (!productId) continue;
          // Conditional: a link made meanwhile (sync, person) is never overwritten.
          n += (
            await tx.vendorProduct.updateMany({ where: { id: r.id, productId: null }, data: { productId } })
          ).count;
        }
        return n;
      });
    }
  }

  for (const store of members.stores) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await db.storeVariantLink.findMany({
        where: { storeId: store.id, productId: null, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true, sku: true },
        orderBy: { id: "asc" },
        take: AUTOLINK_BATCH,
      });
      if (!rows.length) break;
      cursor = rows[rows.length - 1]!.id;
      linked += await withAccountTransaction(accountId, async (tx) => {
        const match = await matchIn(
          tx,
          rows.map((r) => skuAfterPrefix(r.sku, store.skuPrefix)).filter((s): s is string => !!s),
        );
        let n = 0;
        for (const r of rows) {
          const productId = match(skuAfterPrefix(r.sku, store.skuPrefix));
          if (!productId) continue;
          const done = await tx.storeVariantLink.updateMany({
            where: { id: r.id, productId: null },
            data: { productId, matchMethod: "sku", matchedAt: new Date() },
          });
          if (!done.count) continue;
          n++;
          // Same as the Shopify sync's automatic match: only lines without a product, of orders not sent anywhere.
          await tx.orderLine.updateMany({
            where: { variantLinkId: r.id, productId: null, order: { status: { in: RELINKABLE } } },
            data: { productId },
          });
        }
        return n;
      });
    }
  }
  return linked;
}

/**
 * Worker body of one run. Resumable: progress and the cursor are written with every batch, so a crash or a
 * retried job continues after the last committed batch. A run that is DONE is left alone.
 */
export async function processCatalogueRun(
  accountId: string,
  runId: string,
  opts: { batchSize?: number } = {},
) {
  const db = accountDb(accountId);
  const run = await db.masterCatalogueRun.findUnique({
    where: { id: runId },
    include: { connection: { select: { skuPrefixRule: true } } },
  });
  if (!run || run.status === "DONE") return run;
  const batchSize = opts.batchSize ?? BATCH;
  await db.masterCatalogueRun.update({
    where: { id: runId },
    data: { status: "RUNNING", error: null, startedAt: run.startedAt ?? new Date() },
  });
  const prefix = connectionPrefix(run.connection.skuPrefixRule);
  try {
    let cursor = run.cursor ?? undefined;
    if (run.phase === "masters") {
      for (;;) {
        const rows = await db.vendorProduct.findMany({
          where: {
            connectionId: run.connectionId,
            archived: false,
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          select: { id: true, vendorId: true, productId: true, raw: true },
          orderBy: { id: "asc" },
          take: batchSize,
        });
        if (!rows.length) break;
        const last = rows[rows.length - 1]!.id;
        await withAccountTransaction(
          accountId,
          async (tx, helpers) => {
            const fresh = await tx.masterCatalogueRun.findUniqueOrThrow({ where: { id: runId } });
            const c: Counters = {
              processed: 0,
              created: 0,
              linked: 0,
              adopted: 0,
              alreadyLinked: 0,
              conflicts: 0,
              samples: Array.isArray(fresh.conflictSamples) ? (fresh.conflictSamples as string[]) : [],
            };
            await mastersBatch(tx, helpers, accountId, run.lineId, prefix, rows, c);
            await tx.masterCatalogueRun.update({
              where: { id: runId },
              data: {
                cursor: last,
                processed: { increment: c.processed },
                created: { increment: c.created },
                linked: { increment: c.linked },
                adopted: { increment: c.adopted },
                alreadyLinked: { increment: c.alreadyLinked },
                conflicts: { increment: c.conflicts },
                conflictSamples: c.samples,
              },
            });
          },
          { timeout: 30_000, maxWait: 15_000 },
        );
        cursor = last;
      }
      await db.masterCatalogueRun.update({ where: { id: runId }, data: { phase: "autolink" } });
    }
    const autoLinked = await autoLinkLine(accountId, run.lineId);
    const done = await db.masterCatalogueRun.update({
      where: { id: runId },
      data: { phase: "done", status: "DONE", autoLinked, finishedAt: new Date() },
    });
    logger.info(
      { runId, created: done.created, linked: done.linked, conflicts: done.conflicts, autoLinked },
      "master catalogue run done",
    );
    return done;
  } catch (err) {
    await db.masterCatalogueRun
      .update({ where: { id: runId }, data: { status: "FAILED", error: "db_error" } })
      .catch(() => undefined);
    logger.warn({ runId, err: (err as Error).name }, "master catalogue run failed");
    throw err;
  }
}

export async function listCatalogueRuns(accountId: string, lineId: string, take = 10) {
  return accountDb(accountId).masterCatalogueRun.findMany({
    where: { lineId },
    include: { connection: { select: { name: true, type: true } } },
    orderBy: { createdAt: "desc" },
    take,
  });
}
