import type { CrmOrderStatus, Prisma } from "@/generated/prisma/client";
import { DomainError, type Actor } from "@/server/accounts";
import { companyFilter, type CompanyScope } from "@/server/companies";
import { accountDb } from "@/server/db/client";

/** Order list tabs (DESIGN.md screen 2). "transit" fills up from phase 2 on. */
export const ORDER_TABS = {
  /** "Чака таг": a store that takes only tagged orders (StoreOrderTag) keeps the others here, out of every other tab. */
  awaitingTag: ["AWAITING_TAG"],
  /** "Подозрителни": held by the anti-sabotage rule (more units than the line allows), waiting for a person. */
  qtyHold: ["QTY_HOLD"],
  review: ["IMPORTED", "CHECKING", "NEEDS_REVIEW"],
  ready: ["READY", "APPROVED", "QUEUED"],
  blocked: ["BLOCKED", "ON_HOLD", "SUBMIT_FAILED", "EXCEPTION", "UNKNOWN"],
  transit: ["SUBMITTING", "ACCEPTED", "PROCESSING", "SHIPPED"],
  all: null,
} as const satisfies Record<string, readonly CrmOrderStatus[] | null>;
export type OrderTab = keyof typeof ORDER_TABS;

export const isOrderTab = (v: string | undefined): v is OrderTab => !!v && v in ORDER_TABS;

type Ctx = { accountId: string; companyScope: CompanyScope; activeCompanyId: string | null };

export interface OrderFilters {
  tab: OrderTab;
  q?: string;
  storeId?: string;
  country?: string;
  payment?: "COD" | "PREPAID";
  page?: number;
}

export const ORDERS_PAGE_SIZE = 50;

function baseWhere(ctx: Ctx, f: Omit<OrderFilters, "tab" | "page">): Prisma.OrderWhereInput {
  const q = f.q?.trim();
  return {
    ...companyFilter(ctx),
    ...(f.storeId ? { storeId: f.storeId } : {}),
    ...(f.country ? { countryCode: f.country.toUpperCase() } : {}),
    ...(f.payment ? { paymentMethod: f.payment } : {}),
    ...(q
      ? {
          OR: [
            { number: { contains: q, mode: "insensitive" } },
            { customerName: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { phone: { contains: q.replace(/\s+/g, "") } },
            { lines: { some: { sku: { contains: q, mode: "insensitive" } } } },
          ],
        }
      : {}),
  };
}

/** "Всички" leaves out orders still waiting for their store's tag (owner request 2026-11-09: they are not work yet). */
const tabWhere = (tab: OrderTab): Prisma.OrderWhereInput => {
  const statuses = ORDER_TABS[tab];
  return statuses ? { status: { in: [...statuses] } } : { status: { not: "AWAITING_TAG" } };
};

export async function listOrders(ctx: Ctx, f: OrderFilters) {
  const db = accountDb(ctx.accountId);
  const where = { ...baseWhere(ctx, f), ...tabWhere(f.tab) };
  const page = Math.max(1, f.page ?? 1);
  const [rows, total] = await Promise.all([
    db.order.findMany({
      where,
      select: {
        id: true,
        number: true,
        status: true,
        customerName: true,
        countryCode: true,
        currency: true,
        total: true,
        paymentMethod: true,
        codAmount: true,
        placedAt: true,
        tags: true,
        store: { select: { name: true, code: true } },
        _count: { select: { lines: true } },
        companyId: true,
        company: { select: { name: true, line: { select: { name: true, color: true } } } },
        fulfillments: {
          where: { status: { notIn: ["CANCELLED", "SUBMIT_FAILED"] } },
          select: { connectionId: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        check: { select: { connectionId: true } },
      },
      // Ties by id: the order page's J / K follow exactly this order.
      orderBy: [{ placedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * ORDERS_PAGE_SIZE,
      take: ORDERS_PAGE_SIZE,
    }),
    db.order.count({ where }),
  ]);
  // Shipping warehouse (P5-00 marker): the active shipment's connection, else the one the check routed to.
  const connIds = [
    ...new Set(
      rows
        .map((r) => r.fulfillments[0]?.connectionId ?? r.check?.connectionId)
        .filter((c): c is string => !!c),
    ),
  ];
  const conns = connIds.length
    ? await db.fulfillmentConnection.findMany({
        where: { id: { in: connIds } },
        select: { id: true, name: true, type: true, companyId: true, company: { select: { name: true } } },
      })
    : [];
  const connOf = new Map(conns.map((c) => [c.id, c]));
  const withWarehouse = rows.map(({ fulfillments, check, ...r }) => {
    const c = connOf.get(fulfillments[0]?.connectionId ?? check?.connectionId ?? "");
    return {
      ...r,
      warehouse: c
        ? {
            name: c.name,
            type: c.type,
            companyName: c.company?.name ?? null,
            otherCompany: !!r.companyId && !!c.companyId && c.companyId !== r.companyId,
          }
        : null,
    };
  });
  return { rows: withWarehouse, total, page, pages: Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE)) };
}

/** Counts per tab for the same filters (each tab number links to its list). */
export async function orderTabCounts(ctx: Ctx, f: Omit<OrderFilters, "tab" | "page">) {
  const db = accountDb(ctx.accountId);
  const grouped = await db.order.groupBy({
    by: ["status"],
    where: baseWhere(ctx, f),
    _count: { _all: true },
  });
  const byStatus = new Map(grouped.map((g) => [g.status, g._count._all]));
  const sum = (s: readonly CrmOrderStatus[] | null) =>
    s
      ? s.reduce((n, st) => n + (byStatus.get(st) ?? 0), 0)
      : [...byStatus.entries()].reduce((a, [st, n]) => (st === "AWAITING_TAG" ? a : a + n), 0);
  return Object.fromEntries(Object.entries(ORDER_TABS).map(([k, v]) => [k, sum(v)])) as Record<
    OrderTab,
    number
  >;
}

/** One order for the detail page; not_found when it belongs to a company outside the member's scope. */
export async function getOrder(actor: Actor & { companyScope: CompanyScope }, id: string) {
  const order = await accountDb(actor.accountId).order.findUnique({
    where: { id },
    include: {
      store: { select: { id: true, name: true, code: true, domain: true } },
      company: { select: { name: true } },
      lines: {
        include: {
          product: { select: { id: true, sku: true, name: true } },
          productChoice: { select: { userId: true, note: true, createdAt: true } },
        },
        orderBy: { title: "asc" },
      },
      codOverride: { select: { note: true, createdAt: true, previous: true } },
    },
  });
  if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? ""))) {
    throw new DomainError("not_found");
  }
  const alerts = await accountDb(actor.accountId).alert.findMany({
    where: { entityType: "Order", entityId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return { ...order, alerts };
}

/** Начало: attention numbers and today vs yesterday (server local day, UTC on Render). */
export async function dashboardSummary(ctx: Ctx, now = new Date()) {
  const db = accountDb(ctx.accountId);
  const scope = companyFilter(ctx);
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const startYesterday = new Date(startToday.getTime() - 86_400_000);

  const dayStats = async (from: Date, to: Date) => {
    // Orders still waiting for their store's tag are not counted (not work yet; they may never be confirmed).
    const where = {
      ...scope,
      placedAt: { gte: from, lt: to },
      status: { notIn: ["CANCELLED" as const, "AWAITING_TAG" as const, "QTY_HOLD" as const] },
    };
    const [orders, items, countries, cod] = await Promise.all([
      db.order.count({ where }),
      db.orderLine.aggregate({ where: { order: where }, _sum: { quantity: true } }),
      db.order.groupBy({ by: ["countryCode"], where }),
      db.order.groupBy({
        by: ["currency"],
        where: { ...where, paymentMethod: "COD" },
        _sum: { codAmount: true },
      }),
    ]);
    return {
      orders,
      items: items._sum.quantity ?? 0,
      countries: countries.filter((c) => c.countryCode).length,
      cod: cod.map((c) => ({ currency: c.currency, amount: Number(c._sum.codAmount ?? 0) })),
    };
  };

  const counts = await orderTabCounts(ctx, {});
  // Alerts carry no company: count only open order tasks whose order is visible in this scope.
  const openTasks = await db.alert.findMany({
    where: { isTask: true, status: { not: "RESOLVED" }, entityType: "Order" },
    select: { entityId: true },
    distinct: ["entityId"],
    take: 5000,
  });
  const errors = openTasks.length
    ? await db.order.count({
        where: {
          ...scope,
          status: { not: "AWAITING_TAG" },
          id: { in: openTasks.map((a) => a.entityId!).filter(Boolean) },
        },
      })
    : 0;
  const [today, yesterday, recent] = await Promise.all([
    dayStats(startToday, new Date(startToday.getTime() + 86_400_000)),
    dayStats(startYesterday, startToday),
    db.order.findMany({
      where: { ...scope, status: { not: "AWAITING_TAG" } },
      select: {
        id: true,
        number: true,
        customerName: true,
        status: true,
        createdAt: true,
        store: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
  ]);
  return { attention: { review: counts.review, blocked: counts.blocked, errors }, today, yesterday, recent };
}

/** The orders list the order page was opened from (tab + filters), carried in the order page URL. */
export type OrderListContext = Omit<OrderFilters, "page">;

/** Reads the list context from the order page's query (the same keys the orders list uses). */
export function parseOrderListContext(
  sp: Record<string, string | string[] | undefined>,
): OrderListContext | null {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  const tab = one(sp.tab);
  if (!tab || !isOrderTab(tab)) return null;
  const payment = one(sp.payment);
  return {
    tab,
    q: one(sp.q)?.slice(0, 100),
    storeId: one(sp.store)?.slice(0, 64),
    country: one(sp.country)?.slice(0, 2),
    payment: payment === "COD" || payment === "PREPAID" ? payment : undefined,
  };
}

/** The same list context as a query string (for links between orders and back to the list). */
export function orderListQuery(c: OrderListContext | null) {
  if (!c) return "";
  const p = new URLSearchParams({ tab: c.tab });
  if (c.q) p.set("q", c.q);
  if (c.storeId) p.set("store", c.storeId);
  if (c.country) p.set("country", c.country);
  if (c.payment) p.set("payment", c.payment);
  return p.toString();
}

/**
 * The orders just above (newer) and below (older) one order in the list it was opened from — the same tab,
 * filters and order as that list (owner request 2026-11-09: J / K must walk the list, e.g. one country's review
 * orders, not jump across countries or into cancelled ones). Opened from elsewhere: every order of the member's
 * scope that is still in work (no cancelled / shipped-outside / waiting-for-tag ones).
 */
export async function orderNeighbours(
  ctx: Ctx & { lineCompanyIds?: string[] | null },
  orderId: string,
  list: OrderListContext | null = null,
): Promise<{ newer: string | null; older: string | null }> {
  const db = accountDb(ctx.accountId);
  const cur = await db.order.findFirst({
    where: { id: orderId, ...companyFilter(ctx) },
    select: { id: true, placedAt: true },
  });
  if (!cur) return { newer: null, older: null };
  const base: Prisma.OrderWhereInput = list
    ? { ...baseWhere(ctx, list), ...tabWhere(list.tab) }
    : { ...companyFilter(ctx), status: { notIn: ["CANCELLED", "FULFILLED_EXTERNALLY", "AWAITING_TAG"] } };
  const [newer, older] = await Promise.all([
    db.order.findFirst({
      where: {
        AND: [
          base,
          { OR: [{ placedAt: { gt: cur.placedAt } }, { placedAt: cur.placedAt, id: { gt: cur.id } }] },
        ],
      },
      orderBy: [{ placedAt: "asc" }, { id: "asc" }],
      select: { id: true },
    }),
    db.order.findFirst({
      where: {
        AND: [
          base,
          { OR: [{ placedAt: { lt: cur.placedAt } }, { placedAt: cur.placedAt, id: { lt: cur.id } }] },
        ],
      },
      orderBy: [{ placedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    }),
  ]);
  return { newer: newer?.id ?? null, older: older?.id ?? null };
}
