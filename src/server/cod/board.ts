import type { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { assertCan } from "@/server/auth/rbac";
import { companyFilter } from "@/server/companies";
import { accountDb, systemDb } from "@/server/db/client";
import { raiseAlertOnce } from "@/server/fhb/apply";
import { WINDOWS as FHB_WINDOWS } from "@/server/fhb/sync";
import { getReturnsCodSettings } from "@/server/returns/settings";
import type { BoardCtx } from "@/server/returns/board";
import {
  classifyCod,
  COD_BUCKETS,
  COD_MISMATCHES,
  totalsBy,
  type CodBucket,
  type CodMismatch,
  type CodRow,
  type Totals,
} from "./classify";

/**
 * Наложен платеж (P6-02): every COD shipment of the last LOOKBACK_DAYS with expected vs vendor COD, ageing,
 * totals by currency and company, mismatches, CSV. Reads the local mirrors only (the FHB and euShipments
 * read syncs fill them); never a vendor call. Mismatches become operator tasks in the COD sweep.
 */

export const LOOKBACK_DAYS = 365;
const SHIPMENT_STATUSES = ["SHIPPED", "DELIVERED", "COD_PAID"] as const;
export const COD_TABS = ["outstanding", "mismatch", "paid", "in_transit", "all"] as const;
export type CodTab = (typeof COD_TABS)[number];

export interface CodFilter {
  tab?: CodTab;
  bucket?: CodBucket;
  connectionTypes?: readonly string[];
  q?: string;
}

const num = (d: Prisma.Decimal | null) => (d == null ? null : Number(d));

async function loadRows(
  accountId: string,
  where: Prisma.FulfillmentWhereInput,
  now: Date,
  missingDays: number,
) {
  const db = accountDb(accountId);
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
  const shipments = await db.fulfillment.findMany({
    where: {
      AND: [
        where,
        { status: { in: [...SHIPMENT_STATUSES] }, createdAt: { gte: since } },
        { connection: { type: { in: ["FHB_V3", "EUSHIPMENTS"] } } },
      ],
    },
    select: {
      id: true,
      connectionId: true,
      externalId: true,
      status: true,
      codStatus: true,
      trackingNumbers: true,
      shippedAt: true,
      deliveredAt: true,
      createdAt: true,
      connection: { select: { name: true, type: true } },
      order: {
        select: {
          id: true,
          number: true,
          companyId: true,
          countryCode: true,
          paymentMethod: true,
          currency: true,
          codAmount: true,
          codLocalAmount: true,
          codLocalCurrency: true,
        },
      },
    },
    orderBy: [{ deliveredAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    take: 20_000,
  });
  const fhbKeys = shipments.filter((s) => s.connection.type === "FHB_V3");
  const euIds = shipments.filter((s) => s.connection.type === "EUSHIPMENTS").map((s) => s.id);
  const fhbRows: {
    connectionId: string;
    externalId: string;
    cod: Prisma.Decimal | null;
    status: string | null;
    receivedAt: Date | null;
    paidAt: Date | null;
  }[] = [];
  const byConn = new Map<string, string[]>();
  for (const s of fhbKeys) byConn.set(s.connectionId, [...(byConn.get(s.connectionId) ?? []), s.externalId]);
  for (const [connectionId, ids] of byConn)
    for (let i = 0; i < ids.length; i += 1000)
      fhbRows.push(
        ...(await db.fhbCodMirror.findMany({
          where: { connectionId, externalId: { in: ids.slice(i, i + 1000) } },
          select: {
            connectionId: true,
            externalId: true,
            cod: true,
            status: true,
            receivedAt: true,
            paidAt: true,
          },
        })),
      );
  const euRows = [];
  for (let i = 0; i < euIds.length; i += 1000)
    euRows.push(
      ...(await db.eushipmentsTracking.findMany({
        where: { fulfillmentId: { in: euIds.slice(i, i + 1000) } },
        select: {
          fulfillmentId: true,
          codAmount: true,
          codPaidAt: true,
          codPaidNumber: true,
          codCheckedAt: true,
          lastError: true,
        },
      })),
    );
  // FHB cod/list reads only orders created within WINDOWS.codDays of each run: a shipment is covered by the
  // last good run when it was created inside that run's window.
  const fhbCodOk = new Map(
    (byConn.size
      ? await db.fhbSyncState.findMany({
          where: { connectionId: { in: [...byConn.keys()] }, resource: "cod", lastOkAt: { not: null } },
          select: { connectionId: true, lastOkAt: true },
        })
      : []
    ).map((r) => [r.connectionId, r.lastOkAt!]),
  );
  const fhbCheckedAt = (connectionId: string, createdAt: Date) => {
    const ok = fhbCodOk.get(connectionId);
    if (!ok) return null;
    return createdAt.getTime() >= ok.getTime() - FHB_WINDOWS.codDays * 86_400_000 ? ok : null;
  };
  const fhbOf = new Map(fhbRows.map((r) => [`${r.connectionId}:${r.externalId}`, r]));
  const euOf = new Map(euRows.map((r) => [r.fulfillmentId, r]));
  return shipments.map((s) => {
    const fhb = fhbOf.get(`${s.connectionId}:${s.externalId}`);
    const row = classifyCod(
      {
        fulfillmentId: s.id,
        connectionType: s.connection.type,
        status: s.status,
        codStatus: s.codStatus,
        deliveredAt: s.deliveredAt,
        order: {
          paymentMethod: s.order.paymentMethod,
          currency: s.order.currency,
          codAmount: num(s.order.codAmount),
          codLocalAmount: num(s.order.codLocalAmount),
          codLocalCurrency: s.order.codLocalCurrency,
        },
        fhb: fhb
          ? { cod: num(fhb.cod), status: fhb.status, receivedAt: fhb.receivedAt, paidAt: fhb.paidAt }
          : null,
        fhbCodCheckedAt: s.connection.type === "FHB_V3" ? fhbCheckedAt(s.connectionId, s.createdAt) : null,
        eu: euOf.get(s.id) ?? null,
      },
      { now, missingDays },
    );
    return { shipment: s, row };
  });
}

/** COD shipments plus shipments where the warehouse reports COD the order does not have. */
const codWhere = (extra: Prisma.FulfillmentWhereInput): Prisma.FulfillmentWhereInput => ({
  AND: [extra, { order: { paymentMethod: "COD" } }],
});

function tabMatch(tab: CodTab, row: CodRow) {
  switch (tab) {
    case "outstanding":
      return !!row.expected && row.delivered && row.vendor.state !== "paid";
    case "mismatch":
      return !!row.mismatch;
    case "paid":
      return row.vendor.state === "paid";
    case "in_transit":
      return row.bucket === "in_transit";
    default:
      return true;
  }
}

async function scopedRows(ctx: BoardCtx, f: CodFilter, now: Date) {
  const settings = await getReturnsCodSettings(ctx.accountId);
  const order = companyFilter({
    companyScope: ctx.companyScope ?? null,
    activeCompanyId: ctx.activeCompanyId ?? null,
    lineCompanyIds: ctx.lineCompanyIds ?? null,
  });
  const q = f.q?.trim().slice(0, 80);
  const where: Prisma.FulfillmentWhereInput = {
    order,
    ...(f.connectionTypes ? { connection: { type: { in: f.connectionTypes as never } } } : {}),
    ...(q
      ? {
          OR: [
            { externalId: { contains: q, mode: "insensitive" } },
            { order: { number: { contains: q, mode: "insensitive" } } },
            { trackingNumbers: { has: q } },
          ],
        }
      : {}),
  };
  const rows = [
    ...(await loadRows(ctx.accountId, codWhere(where), now, settings.codMissingDays)),
    ...(
      await loadRows(
        ctx.accountId,
        { AND: [where, await unexpectedWhere(ctx.accountId)] },
        now,
        settings.codMissingDays,
      )
    ).filter((r) => r.row.mismatch === "unexpected"),
  ];
  return { settings, rows };
}

export async function listCod(ctx: BoardCtx, f: CodFilter = {}, now = new Date()) {
  assertCan(ctx.role, "cod.read");
  const { settings, rows } = await scopedRows(ctx, f, now);
  const companyIds = [
    ...new Set(rows.map((r) => r.shipment.order.companyId).filter((x): x is string => !!x)),
  ];
  const companies = await accountDb(ctx.accountId).company.findMany({
    where: { id: { in: companyIds } },
    select: { id: true, name: true },
  });
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  const tab = f.tab ?? "outstanding";
  const counts = Object.fromEntries(
    COD_TABS.map((t) => [t, rows.filter((r) => tabMatch(t, r.row)).length]),
  ) as Record<CodTab, number>;
  const buckets = Object.fromEntries(
    COD_BUCKETS.map((b) => [b, rows.filter((r) => r.row.bucket === b && tabMatch(tab, r.row)).length]),
  ) as Record<CodBucket, number>;
  const mismatches = Object.fromEntries(
    COD_MISMATCHES.map((m) => [m, rows.filter((r) => r.row.mismatch === m).length]),
  ) as Record<CodMismatch, number>;
  const inTab = rows.filter((r) => tabMatch(tab, r.row) && (!f.bucket || r.row.bucket === f.bucket));
  const byCurrency = [
    ...(totalsBy(inTab.map((r) => ({ key: "all", row: r.row })))
      .get("all")
      ?.values() ?? []),
  ];
  const byCompany = [...totalsBy(inTab.map((r) => ({ key: r.shipment.order.companyId ?? "", row: r.row })))]
    .map(([companyId, m]) => ({
      companyId,
      company: companyId ? (companyName.get(companyId) ?? "—") : "—",
      totals: [...m.values()] as Totals[],
    }))
    .sort((a, b) => a.company.localeCompare(b.company));
  return {
    settings,
    counts,
    buckets,
    mismatches,
    byCurrency,
    byCompany,
    total: inTab.length,
    rows: inTab.slice(0, 500).map((r) => toView(r, companyName)),
  };
}

function toView(r: Awaited<ReturnType<typeof loadRows>>[number], companyName: Map<string, string>) {
  const s = r.shipment;
  return {
    fulfillmentId: s.id,
    orderId: s.order.id,
    orderNumber: s.order.number,
    externalId: s.externalId,
    company: s.order.companyId ? (companyName.get(s.order.companyId) ?? null) : null,
    country: s.order.countryCode,
    connection: s.connection,
    status: s.status,
    trackingNumbers: s.trackingNumbers,
    shippedAt: s.shippedAt,
    deliveredAt: s.deliveredAt,
    ...r.row,
  };
}
export type CodViewRow = ReturnType<typeof toView>;

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
const money = (n: number | null | undefined) => (n == null ? "" : n.toFixed(2));

/** CSV of every row of the current filter (not only the first 500 on screen). */
export async function exportCodCsv(ctx: BoardCtx, f: CodFilter = {}, now = new Date()) {
  assertCan(ctx.role, "cod.read");
  const { rows } = await scopedRows(ctx, f, now);
  const tab = f.tab ?? "all";
  const companies = await accountDb(ctx.accountId).company.findMany({ select: { id: true, name: true } });
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  const header = [
    "order",
    "shipment",
    "company",
    "warehouse",
    "country",
    "status",
    "tracking",
    "delivered",
    "age_days",
    "bucket",
    "expected_cod",
    "currency",
    "vendor_status",
    "vendor_cod",
    "received_at",
    "paid_at",
    "payout_protocol",
    "mismatch",
  ];
  const lines = rows
    .filter((r) => tabMatch(tab, r.row) && (!f.bucket || r.row.bucket === f.bucket))
    .map((r) => {
      const v = toView(r, companyName);
      return [
        v.orderNumber,
        v.externalId,
        v.company ?? "",
        v.connection.name,
        v.country ?? "",
        v.status,
        v.trackingNumbers.join(" "),
        iso(v.deliveredAt),
        v.ageDays == null ? "" : String(v.ageDays),
        v.bucket,
        money(v.expected?.amount),
        v.expected?.currency ?? "",
        v.vendor.raw ?? v.vendor.state,
        money(v.vendor.amount),
        iso(v.vendor.receivedAt),
        iso(v.vendor.paidAt),
        v.vendor.protocol ?? "",
        v.mismatch ?? "",
      ];
    });
  return [header, ...lines];
}

export const COD_TASK_KINDS: Record<CodMismatch, string> = {
  amount: "cod_amount_mismatch",
  missing: "cod_missing",
  unexpected: "cod_unexpected",
};

const TASK_TITLE: Record<CodMismatch, (ref: string, v: CodRow) => string> = {
  amount: (ref, v) =>
    `COD of ${ref} differs: expected ${v.expected?.amount.toFixed(2)} ${v.expected?.currency}, warehouse reports ${v.vendor.amount?.toFixed(2)}`,
  missing: (ref, v) => `COD of ${ref} is missing at the warehouse ${v.ageDays} days after delivery`,
  unexpected: (ref, v) =>
    `Warehouse reports COD ${v.vendor.amount?.toFixed(2)} for ${ref}, which is not a COD order`,
};

/**
 * Mismatches → operator tasks (one open task per shipment and kind); tasks whose mismatch is gone (fixed, paid)
 * resolve themselves with an auto_resolve note. Prepaid shipments with vendor COD are checked here too.
 */
export async function sweepCodMismatches(accountId: string, now = new Date()) {
  const { codMissingDays } = await getReturnsCodSettings(accountId);
  const db = accountDb(accountId);
  const openTasks = await db.alert.findMany({
    where: { kind: { in: Object.values(COD_TASK_KINDS) }, status: { not: "RESOLVED" } },
    select: { id: true, kind: true, entityId: true },
  });
  const rows = [
    ...(await loadRows(accountId, codWhere({}), now, codMissingDays)),
    ...(await loadRows(accountId, await unexpectedWhere(accountId), now, codMissingDays)).filter(
      (r) => r.row.mismatch === "unexpected",
    ),
  ];
  // Every shipment this sweep actually looked at; open tasks of other shipments are re-checked by id (e.g. a
  // prepaid one whose warehouse COD went back to 0). Whatever is still not evaluated (outside the board window,
  // past the row cap, status changed) keeps its task open: only a re-checked shipment can "match now".
  const evaluated = new Set(rows.map((r) => r.shipment.id));
  const recheck = [
    ...new Set(openTasks.map((a) => a.entityId).filter((id): id is string => !!id && !evaluated.has(id))),
  ];
  for (let i = 0; i < recheck.length; i += 1000)
    for (const r of await loadRows(
      accountId,
      { id: { in: recheck.slice(i, i + 1000) } },
      now,
      codMissingDays,
    )) {
      evaluated.add(r.shipment.id);
      rows.push(r);
    }
  const active = new Set<string>();
  let raised = 0;
  for (const { shipment, row } of rows) {
    if (!row.mismatch) continue;
    const kind = COD_TASK_KINDS[row.mismatch];
    active.add(`${kind}:${shipment.id}`);
    if (openTasks.some((a) => a.kind === kind && a.entityId === shipment.id)) continue;
    const open = await db.alert.findFirst({
      where: { kind, entityType: "Fulfillment", entityId: shipment.id, status: { not: "RESOLVED" } },
      select: { id: true },
    });
    if (open) continue;
    await raiseAlertOnce(accountId, {
      kind,
      severity: "WARNING",
      isTask: true,
      title: TASK_TITLE[row.mismatch](shipment.order.number, row),
      entityType: "Fulfillment",
      entityId: shipment.id,
    });
    raised++;
  }
  let resolved = 0;
  for (const a of openTasks) {
    if (!a.entityId || !evaluated.has(a.entityId)) continue;
    if (active.has(`${a.kind}:${a.entityId}`)) continue;
    const r = await db.alert.updateMany({
      where: { id: a.id, status: { not: "RESOLVED" } },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    if (r.count === 1) {
      await db.alertNote.create({
        data: { accountId, alertId: a.id, action: "auto_resolve", note: "COD matches now" },
      });
      resolved++;
    }
  }
  return { raised, resolved };
}

/** Prepaid shipments the FHB COD list knows (cod > 0 on an order we did not send as COD). */
async function unexpectedWhere(accountId: string): Promise<Prisma.FulfillmentWhereInput> {
  const listed = await accountDb(accountId).fhbCodMirror.findMany({
    where: { cod: { gt: 0 } },
    select: { connectionId: true, externalId: true },
    take: 50_000,
  });
  const byConn = new Map<string, string[]>();
  for (const r of listed) byConn.set(r.connectionId, [...(byConn.get(r.connectionId) ?? []), r.externalId]);
  if (byConn.size === 0) return { id: { in: [] } };
  return {
    order: { paymentMethod: { not: "COD" } },
    OR: [...byConn].map(([connectionId, ids]) => ({ connectionId, externalId: { in: ids } })),
  };
}

export async function sweepAllCod(now = new Date()) {
  const accounts = await systemDb().fulfillmentConnection.findMany({
    where: { type: { in: ["FHB_V3", "EUSHIPMENTS"] } },
    select: { accountId: true },
    distinct: ["accountId"],
  });
  for (const { accountId } of accounts) {
    try {
      const r = await sweepCodMismatches(accountId, now);
      if (r.raised || r.resolved) logger.info({ accountId, ...r }, "cod sweep");
    } catch (err) {
      logger.error({ accountId, err: (err as Error).message }, "cod sweep failed");
    }
  }
}
