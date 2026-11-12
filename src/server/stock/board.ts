import { Prisma, type ConnectionType } from "@/generated/prisma/client";
import type { CompanyScope } from "@/server/companies";
import { companyFilter } from "@/server/companies";
import { accountDb, withSystemTransaction } from "@/server/db/client";
import { globalOutboxPaused } from "@/server/outbox/outbox";
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
import { planInventoryPush, type SkipReason } from "./push";

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
      where: { ...companyFilter(ctx), archivedAt: null },
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
  /**
   * One entry per Shopify variant linked to this product (sum over its locations). More than one = several
   * listings in the store sell the same physical product; `available` above is then their SUM, not one listing.
   */
  variants: { sku: string | null; title: string | null; variantGid: string | null; available: number }[];
  /** Variant link ids behind this cell (for the "why does it differ" explanation). */
  linkIds: string[];
  /** Available at locations NOT mapped to a warehouse (e.g. an old app's location): in `available`, never pushed. */
  unmappedAvailable: number;
  fetchedAt: Date | null;
  mismatch: boolean;
  /** Filled for mismatching cells of the shown page only (explainMismatches). */
  why: MismatchWhy | null;
}

/** Store-wide reasons a push does not run (as the sweep and the sender decide). */
export type StoreBlock = "push_off" | "push_dry" | "disconnected" | "paused" | "no_location";

/** Per variant × mapped location that differs: the push planner's own skip reason, or what the last push did. */
export type LocationWhy =
  | { kind: SkipReason }
  /** Planned with these numbers: the next sweep (every 10 min) sends it. */
  | { kind: "will_push"; target: number }
  /** What the push would set, while a store-wide block keeps it from being sent. */
  | { kind: "would_set"; target: number }
  /** Applied after our last read of Shopify: the next inventory read (every 10 min) shows it. */
  | { kind: "applied_waiting_read"; target: number; at: Date }
  /** Applied, and a LATER Shopify read shows another number: something else wrote the quantity. */
  | { kind: "overwritten"; target: number; at: Date }
  | { kind: "failed"; at: Date; error: string | null };

export interface MismatchWhy {
  store: StoreBlock[];
  locations: { locationName: string; sku: string | null; why: LocationWhy }[];
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
        id: true,
        storeId: true,
        sku: true,
        title: true,
        shopifyVariantGid: true,
        inventoryLevels: { select: { locationGid: true, available: true, fetchedAt: true, tracked: true } },
      },
    },
  } satisfies Prisma.ProductSelect;
}

/**
 * Masters per chunk so that no nested read (variants of every store, their inventory levels, vendor products) needs
 * more than ~20 000 bind parameters (PostgreSQL's limit is 32 767), with room for several listings per store. Pure.
 */
export function boardChunkSize(stores: number, connections: number) {
  // Composite keys bind ~2 values per parent, and a master may have a few listings per store: budget 4 per store.
  const perMaster = 4 * Math.max(1, stores, connections);
  return Math.max(20, Math.min(500, Math.floor(20_000 / perMaster)));
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
    /** storeId → safety buffer the push subtracts (Shopify is compared with sellable − buffer). */
    buffers?: Map<string, number>;
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
      variants: [],
      linkIds: [],
      unmappedAvailable: 0,
      fetchedAt: null,
      mismatch: false,
      why: null,
    });
    const mapping = opts.locationMap.get(link.storeId) ?? new Map<string, string>();
    cell.linkIds.push(link.id);
    const tracked = link.inventoryLevels.filter((l) => l.tracked);
    if (tracked.length)
      cell.variants.push({
        sku: link.sku ?? null,
        title: link.title ?? null,
        variantGid: link.shopifyVariantGid ?? null,
        available: tracked.reduce((a, l) => a + l.available, 0),
      });
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
      else cell.unmappedAvailable += lvl.available;
    }
  }
  for (const cell of Object.values(shopify)) {
    if (cell.available === null) continue;
    const buffer = opts.buffers?.get(cell.storeId) ?? 0;
    const expected = (sellable: number) => Math.max(0, sellable - buffer);
    cell.mismatch = cell.mapped.length
      ? cell.mapped.some((m) => Math.abs(m.available - expected(m.sellable ?? 0)) > settings.shopifyThreshold)
      : Math.abs(cell.available - expected(totalSellable)) > settings.shopifyThreshold;
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
    // Inactive locations are never pushed (planInventoryPush), so they are not compared either.
    where: { storeId: { in: storeIds }, connectionId: { not: null }, isActive: true },
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
  opts: {
    view?: BoardView;
    q?: string;
    filter?: BoardFilter;
    page?: number;
    now?: Date;
    /** Rows per page (default BOARD_PAGE_SIZE); Справки (P10-04) reads one page of up to BOARD_MAX_PRODUCTS. */
    pageSize?: number;
  } = {},
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
  const db = accountDb(ctx.accountId);
  // Ids first, then the rows in chunks: one query for thousands of masters × their variants in every store passed
  // PostgreSQL's 32767 bind parameters (owner report 2026-11-12: a warehouse with 4000+ products, "query parameter
  // limit … exceeded"). Each chunk is its own short query (and RLS transaction).
  const ids = await db.product.findMany({
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
    select: { id: true },
    orderBy: { sku: "asc" },
    take: BOARD_MAX_PRODUCTS,
  });
  const chunk = boardChunkSize(storeIds.length, connectionIds.length);
  const products: Loaded[] = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const part = await db.product.findMany({
      // Same view filter again (a master archived between the two reads stays out of the stock view).
      where: { id: { in: ids.slice(i, i + chunk).map((x) => x.id) }, archived: view === "archive" },
      select: productSelect(connectionIds, storeIds),
      orderBy: { sku: "asc" },
    });
    products.push(...part);
  }
  const buffers = new Map(stores.map((s) => [s.id, s.inventoryBuffer]));
  const rows = products.map((p) =>
    buildRow(p, { connections, reservations, sales, settings, locationMap: maps, buffers, now }),
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
  const size = Math.min(BOARD_MAX_PRODUCTS, Math.max(1, opts.pageSize ?? BOARD_PAGE_SIZE));
  const shown = sorted.slice((page - 1) * size, page * size);
  // Only for the page on screen (a full report page of 5000 rows does not need it).
  if (size <= BOARD_PAGE_SIZE)
    await explainMismatches(ctx.accountId, shown, { threshold: settings.shopifyThreshold, buffers, now });
  return {
    connections,
    stores,
    settings,
    counts,
    total: sorted.length,
    truncated: ids.length >= BOARD_MAX_PRODUCTS,
    rows: shown,
  };
}

/**
 * Fills `why` on every differing Shopify cell of these rows from the push planner itself (planInventoryPush, limited
 * to these masters), so the board never states a reason the push does not use, plus the store-wide blocks and the
 * latest push line per variant × location. Reads the local DB only.
 */
export async function explainMismatches(
  accountId: string,
  rows: BoardRow[],
  opts: { threshold: number; buffers: Map<string, number>; now?: Date },
) {
  const now = opts.now ?? new Date();
  const threshold = opts.threshold;
  const byStore = new Map<string, { productIds: Set<string>; cells: ShopifyCell[] }>();
  for (const r of rows)
    for (const c of Object.values(r.shopify)) {
      if (!c.mismatch) continue;
      const e = byStore.get(c.storeId) ?? { productIds: new Set<string>(), cells: [] };
      e.productIds.add(r.id);
      e.cells.push(c);
      byStore.set(c.storeId, e);
    }
  if (!byStore.size) return;
  const db = accountDb(accountId);
  const linkIds = [...new Set([...byStore.values()].flatMap((e) => e.cells.flatMap((c) => c.linkIds)))];
  const [stores, latest] = await Promise.all([
    db.store.findMany({
      where: { id: { in: [...byStore.keys()] } },
      select: {
        id: true,
        inventoryPushMode: true,
        connectionStatus: true,
        account: { select: { outboxPaused: true } },
      },
    }),
    latestPushLines(accountId, linkIds),
  ]);
  for (const store of stores) {
    const entry = byStore.get(store.id)!;
    const plan = await planInventoryPush(accountId, store.id, now, {
      productIds: [...entry.productIds],
      suspicious: "stored",
    });
    const buffer = opts.buffers.get(store.id) ?? 0;
    const expected = (sellable: number) => Math.max(0, sellable - buffer);
    const blocks: StoreBlock[] = [];
    if (store.inventoryPushMode === "DISABLED") blocks.push("push_off");
    if (store.inventoryPushMode === "DRY_RUN") blocks.push("push_dry");
    if ((store.connectionStatus as { ok?: boolean } | null)?.ok !== true) blocks.push("disconnected");
    if (globalOutboxPaused() || store.account.outboxPaused) blocks.push("paused");
    if (plan.mappedLocations === 0) blocks.push("no_location");
    const key = (linkId: string, gid: string) => `${linkId}|${gid}`;
    const lineOf = new Map(plan.lines.map((l) => [key(l.variantLinkId, l.locationGid), l]));
    const skipOf = new Map(plan.skips.map((k) => [key(k.variantLinkId, k.locationGid), k]));
    const gids = [...new Set([...plan.lines, ...plan.skips].map((x) => x.locationGid))];
    for (const cell of entry.cells) {
      const locations: MismatchWhy["locations"] = [];
      for (const linkId of cell.linkIds)
        for (const gid of gids) {
          const sk = skipOf.get(key(linkId, gid));
          const line = lineOf.get(key(linkId, gid));
          const sku = cell.variants.length > 1 ? (sk?.sku ?? line?.sku ?? null) : null;
          if (sk) {
            // Only where this location is part of the difference: no level there, it differs, or the cell is
            // compared as a total (no mapped level at all). A skip at a location that agrees is not a cause.
            const here = cell.mapped.filter((m) => m.connectionId === sk.connectionId);
            const relevant =
              !cell.mapped.length ||
              !here.length ||
              here.some((m) => Math.abs(m.available - expected(m.sellable ?? 0)) > threshold);
            if (relevant) locations.push({ locationName: sk.locationName, sku, why: { kind: sk.reason } });
            continue;
          }
          if (!line || Math.abs(line.target - line.shopifyNow) <= threshold) continue; // agrees here
          const last = latest.get(key(linkId, gid));
          // A store-wide block (push off, dry run, disconnected, paused) means nothing is sent "next time".
          let why: LocationWhy = blocks.length
            ? { kind: "would_set", target: line.target }
            : { kind: "will_push", target: line.target };
          if (
            last &&
            (last.status === "applied" || last.status === "unchanged") &&
            last.target === line.target
          )
            why =
              line.shopifyFetchedAt > last.at
                ? { kind: "overwritten", target: last.target, at: last.at }
                : { kind: "applied_waiting_read", target: last.target, at: last.at };
          else if (last && last.status === "failed") why = { kind: "failed", at: last.at, error: last.error };
          else if (
            last &&
            last.pushStatus === "FAILED" &&
            last.pushError &&
            !last.pushError.startsWith("plan_expired")
          )
            why = { kind: "failed", at: last.at, error: last.pushError };
          locations.push({ locationName: line.locationName, sku, why });
        }
      cell.why = { store: blocks, locations };
    }
  }
}

/** The newest push line per variant × location (one row each, newest push first). */
async function latestPushLines(accountId: string, linkIds: string[]) {
  const out = new Map<
    string,
    {
      status: string;
      target: number;
      error: string | null;
      pushStatus: string;
      pushError: string | null;
      at: Date;
    }
  >();
  if (!linkIds.length) return out;
  // Raw SQL (DISTINCT ON) runs only on the system client; it is scoped by the explicit accountId filter below.
  const rows = await withSystemTransaction(
    (tx) =>
      tx.$queryRaw<
        {
          variantLinkId: string;
          locationGid: string;
          status: string;
          target: number;
          error: string | null;
          pushStatus: string;
          pushError: string | null;
          at: Date;
        }[]
      >`
      SELECT DISTINCT ON (l."variantLinkId", l."locationGid")
        l."variantLinkId", l."locationGid", l.status, l.target, l.error,
        p.status::text AS "pushStatus", p."lastError" AS "pushError", COALESCE(p."sentAt", p."createdAt") AS at
      FROM "InventoryPushLine" l
      JOIN "InventoryPush" p ON p."accountId" = l."accountId" AND p.id = l."pushId"
      WHERE l."accountId" = ${accountId} AND l."variantLinkId" IN (${Prisma.join(linkIds)})
      ORDER BY l."variantLinkId", l."locationGid", p."createdAt" DESC`,
  );
  for (const r of rows) out.set(`${r.variantLinkId}|${r.locationGid}`, r);
  return out;
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
    {
      connections,
      reservations,
      sales,
      settings,
      locationMap: maps,
      buffers: new Map(stores.map((s) => [s.id, s.inventoryBuffer])),
      now,
    },
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
