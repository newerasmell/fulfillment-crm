import type { CrmOrderStatus, Prisma } from "@/generated/prisma/client";
import { DomainError, type Actor } from "@/server/accounts";
import { companyFilter, type CompanyScope } from "@/server/companies";
import { accountDb } from "@/server/db/client";

/** Order list tabs (DESIGN.md screen 2). "transit" fills up from phase 2 on. */
export const ORDER_TABS = {
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

const tabWhere = (tab: OrderTab): Prisma.OrderWhereInput => {
  const statuses = ORDER_TABS[tab];
  return statuses ? { status: { in: [...statuses] } } : {};
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
      orderBy: { placedAt: "desc" },
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
      : [...byStatus.values()].reduce((a, b) => a + b, 0);
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
    const where = { ...scope, placedAt: { gte: from, lt: to }, status: { not: "CANCELLED" as const } };
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
        where: { ...scope, id: { in: openTasks.map((a) => a.entityId!).filter(Boolean) } },
      })
    : 0;
  const [today, yesterday, recent] = await Promise.all([
    dayStats(startToday, new Date(startToday.getTime() + 86_400_000)),
    dayStats(startYesterday, startToday),
    db.order.findMany({
      where: scope,
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
