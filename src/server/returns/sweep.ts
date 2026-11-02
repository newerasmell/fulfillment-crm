import { Prisma } from "@/generated/prisma/client";
import { jsonEqual } from "@/lib/json-equal";
import { logger } from "@/lib/logger";
import { accountDb, systemDb } from "@/server/db/client";
import { raiseAlertOnce } from "@/server/fhb/apply";
import {
  buildCases,
  isOverdue,
  type CaseDraft,
  type FulfillmentIn,
  type LocalReturnIn,
  type ReturnItem,
  type RmaIn,
} from "./build";
import { getReturnsCodSettings } from "./settings";

/**
 * Returns sweep (P6-01): reads the local mirrors only (never a vendor) and keeps ReturnCase in step with them.
 * Idempotent: running it twice changes nothing. A case never goes back from RECEIVED to RETURNING, never loses
 * the operator's "processed" mark and is never deleted.
 * Also raises "returning but not received after N days" (alert return_overdue) and resolves it once the parcel
 * is back or the case is processed.
 */

export const OVERDUE_KIND = "return_overdue";
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;
const RETURN_STATUSES = ["RETURNING", "RETURN_RECEIVED"] as const;

async function loadInput(accountId: string) {
  const db = accountDb(accountId);
  const connections = await db.fulfillmentConnection.findMany({
    where: { type: { in: ["FHB_V3", "EUSHIPMENTS"] } },
    select: { id: true, type: true, companyId: true },
  });
  const fhbIds = connections.filter((c) => c.type === "FHB_V3").map((c) => c.id);
  const [rmaRows, localRows] = await Promise.all([
    db.fhbOrderMirror.findMany({
      where: { connectionId: { in: fhbIds }, OR: [{ inRma: true }, { returnedAt: { not: null } }] },
      select: {
        connectionId: true,
        externalId: true,
        rawStatus: true,
        returnedAt: true,
        returnType: true,
        trackingNumbers: true,
        raw: true,
      },
    }),
    db.fhbReturnMirror.findMany({
      where: { connectionId: { in: fhbIds } },
      select: {
        connectionId: true,
        uid: true,
        type: true,
        status: true,
        barcodes: true,
        items: true,
        photos: true,
        vendorCreatedAt: true,
      },
    }),
  ]);

  // Shipments involved: in a return status, FHB ones with return info, the ones rma/list names, and the ones a
  // local return's package barcode points at.
  const ids = new Set<string>();
  const add = (rows: { id: string }[]) => rows.forEach((r) => ids.add(r.id));
  add(
    await db.fulfillment.findMany({
      where: { status: { in: [...RETURN_STATUSES] }, connectionId: { in: connections.map((c) => c.id) } },
      select: { id: true },
    }),
  );
  if (fhbIds.length) {
    add(
      await db.fulfillment.findMany({
        where: { connectionId: { in: fhbIds }, returnInfo: { not: Prisma.AnyNull } },
        select: { id: true },
      }),
    );
  }
  for (const connectionId of fhbIds) {
    const externalIds = rmaRows.filter((r) => r.connectionId === connectionId).map((r) => r.externalId);
    for (let i = 0; i < externalIds.length; i += 500)
      add(
        await db.fulfillment.findMany({
          where: { connectionId, externalId: { in: externalIds.slice(i, i + 500) } },
          select: { id: true },
        }),
      );
    const barcodes = [
      ...new Set(localRows.filter((l) => l.connectionId === connectionId).flatMap((l) => l.barcodes)),
    ];
    for (let i = 0; i < barcodes.length; i += 500)
      add(
        await db.fulfillment.findMany({
          where: { connectionId, trackingNumbers: { hasSome: barcodes.slice(i, i + 500) } },
          select: { id: true },
        }),
      );
  }

  const fulfillments: FulfillmentIn[] = [];
  const all = [...ids];
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    const [rows, events] = await Promise.all([
      db.fulfillment.findMany({
        where: { id: { in: chunk } },
        select: {
          id: true,
          connectionId: true,
          externalId: true,
          status: true,
          rawStatus: true,
          trackingNumbers: true,
          returnInfo: true,
          order: {
            select: {
              id: true,
              number: true,
              companyId: true,
              lines: { select: { title: true, sku: true, quantity: true } },
            },
          },
          lines: { select: { quantity: true, orderLine: { select: { title: true, sku: true } } } },
        },
      }),
      db.fulfillmentEvent.findMany({
        where: { fulfillmentId: { in: chunk }, status: { in: [...RETURN_STATUSES] } },
        select: { fulfillmentId: true, status: true, occurredAt: true },
      }),
    ]);
    const first = new Map<string, Date>();
    for (const e of events) {
      const k = `${e.fulfillmentId}:${e.status}`;
      const prev = first.get(k);
      if (!prev || e.occurredAt < prev) first.set(k, e.occurredAt);
    }
    for (const f of rows) {
      const items: ReturnItem[] = (
        f.lines.length
          ? f.lines.map((l) => ({ title: l.orderLine.title, sku: l.orderLine.sku, quantity: l.quantity }))
          : f.order.lines.map((l) => ({ title: l.title, sku: l.sku, quantity: l.quantity }))
      ).slice(0, 50);
      fulfillments.push({
        id: f.id,
        connectionId: f.connectionId,
        externalId: f.externalId,
        status: f.status,
        rawStatus: f.rawStatus,
        trackingNumbers: f.trackingNumbers,
        returnInfo: f.returnInfo,
        order: { id: f.order.id, number: f.order.number, companyId: f.order.companyId },
        items,
        returningEventAt: first.get(`${f.id}:RETURNING`) ?? null,
        receivedEventAt: first.get(`${f.id}:RETURN_RECEIVED`) ?? null,
      });
    }
  }
  return {
    connections,
    fulfillments,
    rma: rmaRows as RmaIn[],
    local: localRows as LocalReturnIn[],
  };
}

/** Plain JSON (dates as ISO strings) so a stored row and a fresh draft compare equal regardless of key order. */
const plain = (d: unknown) => JSON.parse(JSON.stringify(d)) as unknown;

/** Merges a fresh draft onto the stored case: state never regresses, dates only move earlier. */
export function mergeDraft(
  d: CaseDraft,
  prev: { state: string; receivedAt: Date | null; returningSince: Date | null } | undefined,
) {
  const state = prev?.state === "RECEIVED" ? "RECEIVED" : d.state;
  const earliest = (a: Date | null, b: Date | null | undefined) =>
    a && b ? (a < b ? a : b) : (a ?? b ?? null);
  return {
    ...d,
    state,
    receivedAt: earliest(d.receivedAt, prev?.receivedAt),
    returningSince: earliest(d.returningSince, prev?.returningSince),
  };
}

export async function syncReturnCases(accountId: string, now = new Date()) {
  const input = await loadInput(accountId);
  const drafts = buildCases(input);
  const db = accountDb(accountId);
  const existing = new Map<
    string,
    {
      id: string;
      state: string;
      receivedAt: Date | null;
      returningSince: Date | null;
      fp: unknown;
    }
  >();
  const keys = drafts.map((d) => d.caseKey);
  for (let i = 0; i < keys.length; i += 500) {
    const rows = await db.returnCase.findMany({
      where: { caseKey: { in: keys.slice(i, i + 500) } },
    });
    for (const r of rows) {
      const { caseKey: _k, ...stored } = {
        caseKey: r.caseKey,
        connectionId: r.connectionId,
        fulfillmentId: r.fulfillmentId,
        orderId: r.orderId,
        companyId: r.companyId,
        sources: r.sources,
        state: r.state,
        rawStatus: r.rawStatus,
        returnType: r.returnType,
        reference: r.reference,
        trackingNumbers: r.trackingNumbers,
        returnTracking: r.returnTracking,
        items: r.items,
        photos: r.photos,
        localReturnUid: r.localReturnUid,
        returningSince: r.returningSince,
        receivedAt: r.receivedAt,
      };
      existing.set(r.caseKey, {
        id: r.id,
        state: r.state,
        receivedAt: r.receivedAt,
        returningSince: r.returningSince,
        fp: plain(stored),
      });
    }
  }
  let created = 0;
  let updated = 0;
  let received = 0;
  for (const d of drafts) {
    const prev = existing.get(d.caseKey);
    const m = mergeDraft(d, prev);
    const { caseKey, ...data } = m;
    if (prev && jsonEqual(prev.fp, plain(data))) continue;
    const row = {
      ...data,
      items: json(data.items),
      photos: json(data.photos),
      lastSyncAt: now,
    };
    if (!prev) {
      const r = await db.returnCase.createMany({
        data: [{ accountId, caseKey, ...row }],
        skipDuplicates: true,
      });
      created += r.count;
      if (r.count && m.state === "RECEIVED") received++;
    } else {
      await db.returnCase.update({ where: { id: prev.id }, data: row });
      updated++;
      if (prev.state !== "RECEIVED" && m.state === "RECEIVED") received++;
    }
  }
  const overdue = await sweepOverdue(accountId, now);
  return { cases: drafts.length, created, updated, received, ...overdue };
}

/** Raises return_overdue for cases still RETURNING after N days; resolves the ones that are no longer overdue. */
export async function sweepOverdue(accountId: string, now = new Date()) {
  const { returnOverdueDays } = await getReturnsCodSettings(accountId);
  const db = accountDb(accountId);
  const returning = await db.returnCase.findMany({
    where: { state: "RETURNING", processedAt: null },
    select: {
      id: true,
      state: true,
      processedAt: true,
      returningSince: true,
      firstSeenAt: true,
      fulfillmentId: true,
      reference: true,
    },
  });
  const overdueEntities = new Set<string>();
  let raised = 0;
  for (const c of returning) {
    if (!isOverdue(c, returnOverdueDays, now)) continue;
    const entityType = c.fulfillmentId ? "Fulfillment" : "ReturnCase";
    const entityId = c.fulfillmentId ?? c.id;
    overdueEntities.add(`${entityType}:${entityId}`);
    const open = await db.alert.findFirst({
      where: { kind: OVERDUE_KIND, entityType, entityId, status: { not: "RESOLVED" } },
      select: { id: true },
    });
    if (open) continue;
    await raiseAlertOnce(accountId, {
      kind: OVERDUE_KIND,
      severity: "WARNING",
      isTask: true,
      title: `Return ${c.reference} is still on its way back after ${returnOverdueDays} days — check with the carrier`,
      entityType,
      entityId,
    });
    raised++;
  }
  let resolved = 0;
  const open = await db.alert.findMany({
    where: { kind: OVERDUE_KIND, status: { not: "RESOLVED" } },
    select: { id: true, entityType: true, entityId: true },
  });
  for (const a of open) {
    if (overdueEntities.has(`${a.entityType}:${a.entityId}`)) continue;
    const r = await db.alert.updateMany({
      where: { id: a.id, status: { not: "RESOLVED" } },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    if (r.count === 1) {
      await db.alertNote.create({
        data: { accountId, alertId: a.id, action: "auto_resolve", note: "return received or processed" },
      });
      resolved++;
    }
  }
  return { overdueRaised: raised, overdueResolved: resolved };
}

/** Every account with an FHB or euShipments connection (worker). */
export async function sweepAllReturns(now = new Date()) {
  const accounts = await systemDb().fulfillmentConnection.findMany({
    where: { type: { in: ["FHB_V3", "EUSHIPMENTS"] } },
    select: { accountId: true },
    distinct: ["accountId"],
  });
  const results: { accountId: string; ok: boolean }[] = [];
  for (const { accountId } of accounts) {
    try {
      const r = await syncReturnCases(accountId, now);
      if (r.created || r.updated || r.overdueRaised || r.overdueResolved)
        logger.info({ accountId, ...r }, "returns sweep");
      results.push({ accountId, ok: true });
    } catch (err) {
      // One broken account must not stop the others.
      logger.error({ accountId, err: (err as Error).message }, "returns sweep failed");
      results.push({ accountId, ok: false });
    }
  }
  return results;
}
