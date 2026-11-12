import type { AlertSeverity } from "@/generated/prisma/client";
import { systemDb } from "@/server/db/client";
import { STOCK_CONNECTION_TYPES } from "@/server/routing/engine";
import { crmReservations, isStale, reservationKey, sellableOf } from "./levels";
import { getStockSettings, staleHoursFor } from "./settings";

/**
 * Stock discrepancy alerts (P5-01, SPEC §6.3), raised and auto-resolved by the stock.discrepancies cron:
 *  - stock_shopify_oversell (StoreVariantLink): Shopify shows more than the CRM can sell, beyond the group's
 *    threshold — at a mapped location against that warehouse, otherwise the store total against every warehouse;
 *  - stock_snapshot_stale (FulfillmentConnection): the newest snapshot of a warehouse is older than allowed;
 *  - stock_negative_sellable (VendorProduct): physical − CRM-reserved < 0 (the CRM promised more than is there);
 *  - stock_unexplained_drop (VendorProduct): an FHB "out" movement of the last day with no order and no receipt.
 * One open alert per (kind, entity); a resolved alert is not raised again for SUPPRESS_HOURS while the condition
 * persists (the person who resolved it has seen it). Reads the local mirrors only.
 */

export const STOCK_ALERT_KINDS = [
  "stock_shopify_oversell",
  "stock_snapshot_stale",
  "stock_negative_sellable",
  "stock_unexplained_drop",
] as const;
export type StockAlertKind = (typeof STOCK_ALERT_KINDS)[number];
const SUPPRESS_HOURS = 24;
const DROP_WINDOW_MS = 24 * 3_600_000;

interface Finding {
  kind: StockAlertKind;
  entityType: string;
  entityId: string;
  severity: AlertSeverity;
  title: string;
  body: string;
}

/** Everything that should have an open stock alert in one account right now. */
export async function stockFindings(accountId: string, now: Date = new Date()): Promise<Finding[]> {
  const db = systemDb();
  const settings = await getStockSettings(accountId);
  const reservations = await crmReservations(accountId);
  const out: Finding[] = [];
  const connections = await db.fulfillmentConnection.findMany({
    where: { accountId, enabled: true, type: { in: [...STOCK_CONNECTION_TYPES] } },
    select: { id: true, name: true, type: true },
  });
  const connectionIds = connections.map((c) => c.id);
  // Flat reads joined in memory: a nested relation over the whole catalogue binds one value per parent and passed
  // PostgreSQL's 32767 bind parameters with thousands of products (owner report 2026-11-12).
  const [vpRows, levelRows] = await Promise.all([
    db.vendorProduct.findMany({
      where: { accountId, connectionId: { in: connectionIds }, archived: false, productId: { not: null } },
      select: { id: true, connectionId: true, productId: true, vendorId: true },
      orderBy: { id: "asc" },
    }),
    db.stockLevel.findMany({
      where: { accountId, vendorProduct: { connectionId: { in: connectionIds }, archived: false } },
      select: { vendorProductId: true, physical: true, free: true, snapshotAt: true },
    }),
  ]);
  const levelOf = new Map(levelRows.map((l) => [l.vendorProductId, l]));
  const vps = vpRows.map((v) => ({ ...v, stockLevel: levelOf.get(v.id) ?? null }));
  // Sellable per (connection, product): first non-archived vendor product, as on the board.
  const sellable = new Map<string, number>();
  for (const vp of vps) {
    const k = reservationKey(vp.connectionId, vp.productId!);
    if (sellable.has(k) || !vp.stockLevel) continue;
    const reserved = reservations.get(k) ?? 0;
    sellable.set(k, sellableOf(vp.stockLevel, reserved));
    if (vp.stockLevel.physical - reserved < 0)
      out.push({
        kind: "stock_negative_sellable",
        entityType: "VendorProduct",
        entityId: vp.id,
        severity: "WARNING",
        title: `More reserved than on stock: ${vp.vendorId}`,
        body: `physical=${vp.stockLevel.physical} reserved=${reserved}`,
      });
  }
  for (const c of connections) {
    const newest = vps
      .filter((v) => v.connectionId === c.id && v.stockLevel)
      .reduce<Date | null>(
        (m, v) => (!m || v.stockLevel!.snapshotAt > m ? v.stockLevel!.snapshotAt : m),
        null,
      );
    if (newest && isStale(newest, staleHoursFor(settings, c.type), now))
      out.push({
        kind: "stock_snapshot_stale",
        entityType: "FulfillmentConnection",
        entityId: c.id,
        severity: "WARNING",
        title: `Stock snapshot is stale: ${c.name}`,
        body: `newest snapshot ${newest.toISOString()}`,
      });
  }
  const totalOf = (productId: string) =>
    connectionIds.reduce((s, cid) => s + (sellable.get(reservationKey(cid, productId)) ?? 0), 0);

  const [locations, linkRows] = await Promise.all([
    db.storeLocation.findMany({
      where: { accountId, connectionId: { not: null } },
      select: { storeId: true, shopifyLocationGid: true, connectionId: true },
    }),
    db.storeVariantLink.findMany({
      where: { accountId, productId: { not: null }, inventoryLevels: { some: {} } },
      select: { id: true, storeId: true, productId: true, sku: true, title: true },
    }),
  ]);
  const levelsOfLink = new Map<string, { locationGid: string; available: number; tracked: boolean }[]>();
  for (const l of await db.shopifyInventoryLevel.findMany({
    where: { accountId, variantLink: { productId: { not: null } } },
    select: { variantLinkId: true, locationGid: true, available: true, tracked: true },
  })) {
    const list = levelsOfLink.get(l.variantLinkId) ?? [];
    list.push(l);
    levelsOfLink.set(l.variantLinkId, list);
  }
  const links = linkRows.map((k) => ({ ...k, inventoryLevels: levelsOfLink.get(k.id) ?? [] }));
  const mapped = new Map(locations.map((l) => [`${l.storeId}:${l.shopifyLocationGid}`, l.connectionId!]));
  for (const link of links) {
    const tracked = link.inventoryLevels.filter((l) => l.tracked);
    if (!tracked.length) continue;
    const pairs = tracked
      .map((l) => ({ l, cid: mapped.get(`${link.storeId}:${l.locationGid}`) }))
      .filter((x): x is { l: (typeof tracked)[number]; cid: string } => !!x.cid);
    let over: string | null = null;
    if (pairs.length) {
      for (const { l, cid } of pairs) {
        const s = sellable.get(reservationKey(cid, link.productId!)) ?? 0;
        if (l.available > s + settings.shopifyThreshold) over = `shopify=${l.available} sellable=${s}`;
      }
    } else {
      const shopify = tracked.reduce((s, l) => s + l.available, 0);
      const total = totalOf(link.productId!);
      if (shopify > total + settings.shopifyThreshold) over = `shopify=${shopify} sellable=${total}`;
    }
    if (over)
      out.push({
        kind: "stock_shopify_oversell",
        entityType: "StoreVariantLink",
        entityId: link.id,
        severity: "WARNING",
        title: `Shopify shows more than we can ship: ${link.sku ?? link.title}`,
        body: over,
      });
  }

  const drops = await db.stockMovement.findMany({
    where: {
      accountId,
      connectionId: { in: connectionIds },
      kind: "out",
      occurredAt: { gte: new Date(now.getTime() - DROP_WINDOW_MS) },
      vendorProductId: { not: null },
    },
    select: { vendorProductId: true, quantity: true, raw: true, externalId: true },
  });
  for (const m of drops) {
    const raw = (m.raw ?? {}) as { order?: string | null; stock_receipt?: string | null };
    if (raw.order || raw.stock_receipt) continue;
    out.push({
      kind: "stock_unexplained_drop",
      entityType: "VendorProduct",
      entityId: m.vendorProductId!,
      severity: "INFO",
      title: "Stock went down at the warehouse without an order",
      body: `movement ${m.externalId}: ${m.quantity}`,
    });
  }
  return out;
}

/** Raises what is missing and resolves what no longer holds, for every account. */
export async function sweepStockAlerts(now: Date = new Date()) {
  const db = systemDb();
  const accounts = await db.account.findMany({ select: { id: true } });
  let created = 0;
  let resolved = 0;
  for (const { id: accountId } of accounts) {
    const findings = await stockFindings(accountId, now);
    const wanted = new Map(findings.map((f) => [`${f.kind}:${f.entityId}`, f]));
    const open = await db.alert.findMany({
      where: { accountId, kind: { in: [...STOCK_ALERT_KINDS] }, status: { not: "RESOLVED" } },
      select: { id: true, kind: true, entityId: true },
    });
    const openKeys = new Set(open.map((a) => `${a.kind}:${a.entityId}`));
    for (const [key, f] of wanted) {
      if (openKeys.has(key)) continue;
      const recent = await db.alert.findFirst({
        where: {
          accountId,
          kind: f.kind,
          entityType: f.entityType,
          entityId: f.entityId,
          status: "RESOLVED",
          resolvedAt: { gte: new Date(now.getTime() - SUPPRESS_HOURS * 3_600_000) },
          // Only a person's resolution mutes it: one the sweep closed itself was never seen (a flapping
          // condition must alert again).
          notes: { none: { action: "auto_resolve" } },
        },
        select: { id: true },
      });
      if (recent) continue;
      await db.alert.create({
        data: {
          accountId,
          kind: f.kind,
          isTask: f.kind !== "stock_unexplained_drop",
          severity: f.severity,
          title: f.title.slice(0, 300),
          body: f.body.slice(0, 2000),
          entityType: f.entityType,
          entityId: f.entityId,
        },
      });
      created++;
    }
    for (const a of open) {
      if (wanted.has(`${a.kind}:${a.entityId}`)) continue;
      const res = await db.alert.updateMany({
        where: { id: a.id, status: { not: "RESOLVED" } },
        data: { status: "RESOLVED", resolvedAt: now },
      });
      if (res.count === 1) {
        await db.alertNote.create({
          data: { accountId, alertId: a.id, action: "auto_resolve", note: "condition cleared" },
        });
        resolved++;
      }
    }
  }
  return { created, resolved };
}
