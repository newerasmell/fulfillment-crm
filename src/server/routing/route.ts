import { DomainError } from "@/server/accounts";
import { accountDb } from "@/server/db/client";
import {
  checkStock,
  evaluateRouting,
  STOCK_CONNECTION_TYPES,
  type RoutingConnection,
  type RoutingDecision,
  type RoutingOrder,
  type RoutingRuleRow,
  type StockCheck,
} from "./engine";

/**
 * routeOrder(): which warehouse connection should ship this order, and why (P4-02). Reads only; nothing is
 * stored here (the validator engine stores the decision with the order's check, see src/server/checks).
 * For many orders at once, load the context once: `routeWithContext(await loadRoutingContext(a), order)`.
 */

export interface RoutingContext {
  accountId: string;
  rules: RoutingRuleRow[];
  connections: RoutingConnection[];
  storeCodes: Map<string, string>;
}

export async function loadRoutingContext(accountId: string): Promise<RoutingContext> {
  const db = accountDb(accountId);
  const [rules, connections, stores] = await Promise.all([
    db.routingRule.findMany({ orderBy: [{ priority: "asc" }, { id: "asc" }] }),
    db.fulfillmentConnection.findMany({
      select: { id: true, name: true, type: true, companyId: true, enabled: true },
    }),
    db.store.findMany({ select: { id: true, code: true } }),
  ]);
  return { accountId, rules, connections, storeCodes: new Map(stores.map((s) => [s.id, s.code])) };
}

/** Sellable units per CRM product at each stock-holding connection (first non-archived vendor product). */
export async function stockByConnection(
  accountId: string,
  connections: RoutingConnection[],
  lines: RoutingOrder["lines"],
): Promise<Map<string, StockCheck>> {
  const productIds = [...new Set(lines.map((l) => l.productId).filter((p): p is string => !!p))];
  const targets = connections.filter((c) => STOCK_CONNECTION_TYPES.includes(c.type));
  const vps = productIds.length
    ? await accountDb(accountId).vendorProduct.findMany({
        where: {
          connectionId: { in: targets.map((c) => c.id) },
          productId: { in: productIds },
          archived: false,
        },
        select: { connectionId: true, productId: true, stockLevel: { select: { sellable: true } } },
        orderBy: { id: "asc" },
      })
    : [];
  const out = new Map<string, StockCheck>();
  for (const c of targets) {
    const available = new Map<string, number>();
    for (const vp of vps) {
      if (vp.connectionId !== c.id || !vp.productId || available.has(vp.productId) || !vp.stockLevel)
        continue;
      available.set(vp.productId, vp.stockLevel.sellable);
    }
    out.set(c.id, checkStock(lines, available));
  }
  return out;
}

export async function routeWithContext(ctx: RoutingContext, order: RoutingOrder): Promise<RoutingDecision> {
  const stock = await stockByConnection(ctx.accountId, ctx.connections, order.lines);
  return evaluateRouting({
    order,
    rules: ctx.rules,
    connections: ctx.connections,
    stock,
    storeCodes: ctx.storeCodes,
  });
}

export async function loadRoutingOrder(accountId: string, orderId: string): Promise<RoutingOrder> {
  const order = await accountDb(accountId).order.findUnique({
    where: { id: orderId },
    select: {
      companyId: true,
      storeId: true,
      countryCode: true,
      paymentMethod: true,
      tags: true,
      lines: { select: { productId: true, quantity: true, title: true, sku: true } },
    },
  });
  if (!order) throw new DomainError("not_found");
  return {
    ...order,
    lines: order.lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      title: l.sku ?? l.title,
    })),
  };
}

/** The routing decision for one order (reads only). */
export async function routeOrder(accountId: string, orderId: string): Promise<RoutingDecision> {
  const [ctx, order] = await Promise.all([
    loadRoutingContext(accountId),
    loadRoutingOrder(accountId, orderId),
  ]);
  return routeWithContext(ctx, order);
}
