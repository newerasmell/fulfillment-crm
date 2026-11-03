import type { ConnectionType, Prisma } from "@/generated/prisma/client";
import type { CompanyScope } from "@/server/companies";
import { companyFilter } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import { lineProductWhere } from "@/server/lines/lines";
import { STOCK_CONNECTION_TYPES } from "@/server/routing/engine";
import {
  crmReservations,
  daysLeft,
  isStale,
  reservationKey,
  salesByProduct,
  sellableOf,
  type WarehouseCell,
} from "./levels";
import { getStockSettings, staleHoursFor, type StockSettingsValues } from "./settings";

/**
 * "Продукти и наличности" (DESIGN.md screen 4, SPEC §6.3) per MASTER product of the selected product line: one
 * column per warehouse connection (physical / free / CRM-reserved / sellable, snapshot age and source), Shopify
 * quantity per store, quick filters with counts, testers under their original, 50 per page. Reads the local
 * mirrors only (VendorProduct + StockLevel, ShopifyInventoryLevel); nothing here calls a vendor or Shopify.
 */

export const BOARD_PAGE_SIZE = 50;
/** Masters loaded per board view (filters and counts are computed over this set). */
export const BOARD_MAX_PRODUCTS = 5000;
/** Days of sales used for the run-out estimate. */
export const SALES_WINDOW_DAYS = 30;

export const BOARD_FILTERS = ["all", "inStock", "zero", "testers", "runningOut", "shopifyMismatch"] as const;
export type BoardFilter = (typeof BOARD_FILTERS)[number];
export const BOARD_VIEWS = ["stock", "movements", "bundles", "archive", "notices"] as const;
export type BoardView = (typeof BOARD_VIEWS)[number];

export interface StockCtx {
  accountId: string;
  role: string;
  companyScope: CompanyScope;
  activeCompanyId: string | null;
  activeLineId: string | null;
  lineCompanyIds: string[] | null;
}

const contains = (q: string) => ({ contains: q, mode: "insensitive" as const });

/** Masters of the sidebar line (members who cannot pick "all lines" also keep masters without a line). */
export function boardProductWhere(ctx: StockCtx): Prisma.ProductWhereInput {
  if (!ctx.activeLineId) return {};
  return ctx.role === "OWNER" || ctx.role === "ADMIN"
    ? { lineId: ctx.activeLineId }
    : lineProductWhere(ctx.activeLineId);
}

export function searchProductWhere(q: string): Prisma.ProductWhereInput {
  if (!q) return {};
  return {
    OR: [
      { sku: contains(q) },
      { name: contains(q) },
      // EAN is a search term only, never a join key.
      { eans: { some: { ean: contains(q) } } },
      {
        vendorProducts: {
          some: { OR: [{ vendorId: contains(q) }, { vendorCode: contains(q) }, { vendorEan: contains(q) }] },
        },
      },
      { variantLinks: { some: { sku: contains(q) } } },
    ],
  };
}

/** Warehouses (stock-holding connections) and stores the member sees under the sidebar filters. */
export async function boardScope(ctx: StockCtx) {
  const db = accountDb(ctx.accountId);
  const [connections, stores] = await Promise.all([
    db.fulfillmentConnection.findMany({
      where: { type: { in: [...STOCK_CONNECTION_TYPES] }, ...companyFilter(ctx) },
      select: { id: true, name: true, type: true, liveMode: true, enabled: true },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    }),
    db.store.findMany({
      where: companyFilter(ctx),
      select: { id: true, name: true, code: true, inventoryBuffer: true, inventoryPushMode: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return { connections, stores };
}

export interface ShopifyCell {
  storeId: string;
  /** Sum of "available" over the store's mirrored locations; null = never read. */
  available: number | null;
  /** Mapped locations: Shopify available at the location vs the sellable of the warehouse it stands for. */
  mapped: { connectionId: string; available: number; sellable: number | null }[];
  fetchedAt: Date | null;
  mismatch: boolean;
}

export interface BoardRow {
  id: string;
  sku: string;
  name: string;
  isTester: boolean;
  parentProductId: string | null;
  archived: boolean;
  eans: string[];
  isBundle: boolean;
  cells: Record<string, WarehouseCell>;
  totalSellable: number;
  totalPhysical: number;
  shopify: Record<string, ShopifyCell>;
  sold: number;
  daysLeft: number | null;
  flags: { inStock: boolean; zero: boolean; runningOut: boolean; shopifyMismatch: boolean; stale: boolean };
}

type Loaded = Prisma.ProductGetPayload<{
  select: ReturnType<typeof productSelect>;
}>;

function productSelect(connectionIds: string[], storeIds: string[]) {
  return {
    id: true,
    sku: true,
    name: true,
    isTester: true,
    parentProductId: true,
    archived: true,
    parent: { select: { sku: true } },
    eans: { select: { ean: true }, orderBy: { createdAt: "asc" as const } },
    vendorProducts: {
      where: { connectionId: { in: connectionIds }, archived: false },
      select: { id: true, connectionId: true, vendorId: true, vendorCode: true, raw: true, stockLevel: true },
      orderBy: { id: "asc" as const },
    },
    variantLinks: {
      where: { storeId: { in: storeIds } },
      select: {
        storeId: true,
        inventoryLevels: { select: { locationGid: true, available: true, fetchedAt: true, tracked: true } },
      },
    },
  } satisfies Prisma.ProductSelect;
}

/** Pure: one board row from a loaded master (exported for tests). */
export function buildRow(
  p: Loaded,
  opts: {
    connections: { id: string; type: ConnectionType }[];
    reservations: Map<string, number>;
    sales: Map<string, number>;
    settings: StockSettingsValues;
    /** storeId → (locationGid → connectionId) for mapped locations. */
    locationMap: Map<string, Map<string, string>>;
    now: Date;
  },
): BoardRow {
  const { settings, now } = opts;
  const cells: Record<string, WarehouseCell> = {};
  for (const c of opts.connections) {
    // First non-archived vendor product per warehouse (same rule as the routing stock check).
    const vp = p.vendorProducts.find((v) => v.connectionId === c.id);
    if (!vp) continue;
    const reserved = opts.reservations.get(reservationKey(c.id, p.id)) ?? 0;
    const level = vp.stockLevel;
    cells[c.id] = {
      connectionId: c.id,
      vendorProductId: vp.id,
      vendorId: vp.vendorId,
      vendorCode: vp.vendorCode,
      physical: level?.physical ?? 0,
      free: level?.free ?? 0,
      reserved,
      sellable: level ? sellableOf(level, reserved) : 0,
      snapshotAt: level?.snapshotAt ?? null,
      source: level?.source ?? null,
      stale: !level || isStale(level.snapshotAt, staleHoursFor(settings, c.type), now),
    };
  }
  const values = Object.values(cells);
  const totalSellable = values.reduce((s, c) => s + c.sellable, 0);
  const totalPhysical = values.reduce((s, c) => s + c.physical, 0);

  const shopify: Record<string, ShopifyCell> = {};
  for (const link of p.variantLinks) {
    const cell = (shopify[link.storeId] ??= {
      storeId: link.storeId,
      available: null,
      mapped: [],
      fetchedAt: null,
      mismatch: false,
    });
    const mapping = opts.locationMap.get(link.storeId) ?? new Map<string, string>();
    for (const lvl of link.inventoryLevels) {
      if (!lvl.tracked) continue;
      cell.available = (cell.available ?? 0) + lvl.available;
      if (!cell.fetchedAt || lvl.fetchedAt > cell.fetchedAt) cell.fetchedAt = lvl.fetchedAt;
      const connectionId = mapping.get(lvl.locationGid);
      if (connectionId)
        cell.mapped.push({
          connectionId,
          available: lvl.available,
          sellable: cells[connectionId]?.sellable ?? null,
        });
    }
  }
  for (const cell of Object.values(shopify)) {
    if (cell.available === null) continue;
    cell.mismatch = cell.mapped.length
      ? cell.mapped.some((m) => Math.abs(m.available - (m.sellable ?? 0)) > settings.shopifyThreshold)
      : Math.abs(cell.available - totalSellable) > settings.shopifyThreshold;
  }
  const sold = opts.sales.get(p.id) ?? 0;
  const left = daysLeft(totalSellable, sold, SALES_WINDOW_DAYS);
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    isTester: p.isTester,
    parentProductId: p.parentProductId,
    archived: p.archived,
    eans: p.eans.map((e) => e.ean),
    isBundle: p.vendorProducts.some((v) => (v.raw as { type?: string } | null)?.type === "multi"),
    cells,
    totalSellable,
    totalPhysical,
    shopify,
    sold,
    daysLeft: left,
    flags: {
      inStock: totalSellable > 0,
      zero: totalPhysical === 0,
      runningOut: totalSellable > 0 && left !== null && left <= settings.runOutDays,
      shopifyMismatch: Object.values(shopify).some((s) => s.mismatch),
      stale: values.some((c) => c.stale),
    },
  };
}

export function matchesFilter(row: BoardRow, f: BoardFilter) {
  switch (f) {
    case "inStock":
      return row.flags.inStock;
    case "zero":
      return row.flags.zero;
    case "testers":
      return row.isTester;
    case "runningOut":
      return row.flags.runningOut;
    case "shopifyMismatch":
      return row.flags.shopifyMismatch;
    default:
      return true;
  }
}

/** Pure: originals by SKU, each followed by its testers ("Тестерите под оригинала"). */
export function groupTesters<T extends { sku: string; isTester: boolean; parentSku: string | null }>(
  rows: T[],
): T[] {
  const key = (r: T) => (r.isTester && r.parentSku ? r.parentSku : r.sku);
  return [...rows].sort((a, b) => {
    const k = key(a).localeCompare(key(b));
    if (k) return k;
    if (a.isTester !== b.isTester) return a.isTester ? 1 : -1;
    return a.sku.localeCompare(b.sku);
  });
}

export async function locationMaps(accountId: string, storeIds: string[]) {
  const rows = await accountDb(accountId).storeLocation.findMany({
    where: { storeId: { in: storeIds }, connectionId: { not: null } },
    select: { storeId: true, shopifyLocationGid: true, connectionId: true },
  });
  const out = new Map<string, Map<string, string>>();
  for (const r of rows) {
    const m = out.get(r.storeId) ?? new Map<string, string>();
    m.set(r.shopifyLocationGid, r.connectionId!);
    out.set(r.storeId, m);
  }
  return out;
}

/** Board rows of the current scope (stock / bundles / archive views). */
export async function stockBoard(
  ctx: StockCtx,
  opts: { view?: BoardView; q?: string; filter?: BoardFilter; page?: number; now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  const view = opts.view ?? "stock";
  const { connections, stores } = await boardScope(ctx);
  const connectionIds = connections.map((c) => c.id);
  const storeIds = stores.map((s) => s.id);
  const [settings, reservations, sales, maps] = await Promise.all([
    getStockSettings(ctx.accountId),
    crmReservations(ctx.accountId),
    salesByProduct(ctx.accountId, SALES_WINDOW_DAYS, now),
    locationMaps(ctx.accountId, storeIds),
  ]);
  const q = opts.q?.trim() ?? "";
  const products = await accountDb(ctx.accountId).product.findMany({
    where: {
      archived: view === "archive",
      ...(view === "bundles"
        ? {
            vendorProducts: {
              some: { connectionId: { in: connectionIds }, raw: { path: ["type"], equals: "multi" } },
            },
          }
        : {}),
      AND: [boardProductWhere(ctx), searchProductWhere(q)],
    },
    select: productSelect(connectionIds, storeIds),
    orderBy: { sku: "asc" },
    take: BOARD_MAX_PRODUCTS,
  });
  const rows = products.map((p) =>
    buildRow(p, { connections, reservations, sales, settings, locationMap: maps, now }),
  );
  const counts = Object.fromEntries(
    BOARD_FILTERS.map((f) => [f, rows.filter((r) => matchesFilter(r, f)).length]),
  ) as Record<BoardFilter, number>;
  const filter = opts.filter ?? "all";
  const parentSku = new Map(products.map((p) => [p.id, p.parent?.sku ?? null]));
  const sorted = groupTesters(
    rows
      .filter((r) => matchesFilter(r, filter))
      .map((r) => ({ ...r, parentSku: parentSku.get(r.id) ?? null })),
  );
  const page = Math.max(1, opts.page ?? 1);
  return {
    connections,
    stores,
    settings,
    counts,
    total: sorted.length,
    truncated: products.length >= BOARD_MAX_PRODUCTS,
    rows: sorted.slice((page - 1) * BOARD_PAGE_SIZE, page * BOARD_PAGE_SIZE),
  };
}

/** Right panel: codes, EAN history, stock per warehouse (euShipments per physical warehouse), Shopify, movements. */
export async function stockProductDetail(ctx: StockCtx, productId: string, now: Date = new Date()) {
  const db = accountDb(ctx.accountId);
  const { connections, stores } = await boardScope(ctx);
  const connectionIds = connections.map((c) => c.id);
  const storeIds = stores.map((s) => s.id);
  const product = await db.product.findFirst({
    where: { id: productId, AND: [boardProductWhere(ctx)] },
    select: {
      ...productSelect(connectionIds, storeIds),
      eans: {
        select: { ean: true, note: true, source: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      },
      vendorProducts: {
        where: { connectionId: { in: connectionIds } },
        select: {
          id: true,
          connectionId: true,
          vendorId: true,
          vendorCode: true,
          vendorEan: true,
          archived: true,
          raw: true,
          stockLevel: true,
          lastSyncAt: true,
        },
        orderBy: { id: "asc" },
      },
      testers: { select: { id: true, sku: true, name: true } },
      parent: { select: { id: true, sku: true, name: true } },
    },
  });
  if (!product) return null;
  const [settings, reservations, sales, maps, locations] = await Promise.all([
    getStockSettings(ctx.accountId),
    crmReservations(ctx.accountId),
    salesByProduct(ctx.accountId, SALES_WINDOW_DAYS, now),
    locationMaps(ctx.accountId, storeIds),
    db.storeLocation.findMany({
      where: { storeId: { in: storeIds } },
      select: { storeId: true, shopifyLocationGid: true, name: true, connectionId: true },
    }),
  ]);
  const row = buildRow(
    { ...product, vendorProducts: product.vendorProducts.filter((v) => !v.archived) } as unknown as Loaded,
    { connections, reservations, sales, settings, locationMap: maps, now },
  );
  const vpIds = product.vendorProducts.map((v) => v.id);
  const [movements, euStock, inbound, shopifyLevels] = await Promise.all([
    db.stockMovement.findMany({
      where: { vendorProductId: { in: vpIds } },
      orderBy: { occurredAt: "desc" },
      take: 10,
      select: { id: true, occurredAt: true, kind: true, quantity: true, connectionId: true },
    }),
    db.eushipmentsStock.findMany({
      where: { vendorProductId: { in: vpIds } },
      select: { connectionId: true, warehouseName: true, availQty: true, availDate: true },
      orderBy: { warehouseName: "asc" },
    }),
    db.inboundLine.findMany({
      where: {
        productId,
        inbound: { connectionId: { in: connectionIds }, status: { notIn: [...CLOSED_INBOUND] } },
      },
      select: {
        expectedQty: true,
        receivedQty: true,
        inbound: {
          select: { id: true, externalRef: true, connectionId: true, expectedAt: true, status: true },
        },
      },
      take: 20,
    }),
    db.shopifyInventoryLevel.findMany({
      where: { storeId: { in: storeIds }, variantLink: { productId } },
      select: {
        storeId: true,
        locationGid: true,
        available: true,
        onHand: true,
        tracked: true,
        fetchedAt: true,
      },
    }),
  ]);
  const locationName = new Map(locations.map((l) => [`${l.storeId}:${l.shopifyLocationGid}`, l]));
  return {
    product,
    row,
    connections,
    stores,
    settings,
    movements,
    euStock,
    inbound,
    shopifyLevels: shopifyLevels.map((l) => ({
      ...l,
      location: locationName.get(`${l.storeId}:${l.locationGid}`) ?? null,
    })),
  };
}

/** Raw inbound statuses after which nothing more arrives (FHB "deleted", euShipments CLOSED/DELETED). */
export const CLOSED_INBOUND = ["deleted", "CLOSED", "DELETED", "CANCELLED"] as const;

/** "Движения": vendor movements of the member's warehouses (FHB stock/movements; reservations when recorded). */
export async function stockMovements(ctx: StockCtx, opts: { q?: string; page?: number } = {}) {
  const db = accountDb(ctx.accountId);
  const { connections } = await boardScope(ctx);
  const q = opts.q?.trim() ?? "";
  const where: Prisma.StockMovementWhereInput = {
    connectionId: { in: connections.map((c) => c.id) },
    ...(q
      ? {
          OR: [
            { externalId: q },
            { vendorProduct: { is: { vendorId: contains(q) } } },
            { vendorProduct: { is: { product: { is: { sku: contains(q) } } } } },
            { vendorProduct: { is: { product: { is: { name: contains(q) } } } } },
          ],
        }
      : {}),
  };
  const page = Math.max(1, opts.page ?? 1);
  const [rows, total] = await Promise.all([
    db.stockMovement.findMany({
      where,
      include: {
        connection: { select: { name: true, type: true } },
        vendorProduct: {
          select: { vendorId: true, product: { select: { id: true, sku: true, name: true } } },
        },
      },
      orderBy: { occurredAt: "desc" },
      skip: (page - 1) * BOARD_PAGE_SIZE,
      take: BOARD_PAGE_SIZE,
    }),
    db.stockMovement.count({ where }),
  ]);
  return { rows, total };
}
