import type { ConnectionType, LiveMode } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { accountDb } from "@/server/db/client";
import { STOCK_CONNECTION_TYPES, stockByConnection, type StockCheck } from "@/server/routing";
import type { ScopedActor } from "@/server/stores";

/**
 * Which warehouses may ship an order by a person's choice (P4-09): the enabled stock-holding connections (FHB v3,
 * euShipments) of the companies in the order's PRODUCT LINE (P5-00: other lines sell other goods), plus shared
 * group-level connections (no company), the same set the routing stock fallback considers. An order of a company
 * that is not in a line yet can only use its own company's (and shared) warehouses. Reads only.
 */

export interface EligibleConnection {
  id: string;
  name: string;
  type: ConnectionType;
  liveMode: LiveMode;
  companyId: string | null;
  companyName: string | null;
}

export async function eligibleConnections(
  accountId: string,
  order: { companyId: string | null; lineId: string | null },
): Promise<EligibleConnection[]> {
  const rows = await accountDb(accountId).fulfillmentConnection.findMany({
    where: { enabled: true, type: { in: [...STOCK_CONNECTION_TYPES] } },
    select: {
      id: true,
      name: true,
      type: true,
      liveMode: true,
      companyId: true,
      company: { select: { name: true, lineId: true, archivedAt: true } },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return rows
    .filter((c) => {
      if (c.companyId === null) return true;
      if (!c.company || c.company.archivedAt) return false;
      if (order.lineId) return c.company.lineId === order.lineId;
      return c.companyId === order.companyId;
    })
    .map(({ company, ...c }) => ({ ...c, companyName: company?.name ?? null }));
}

/** The order (in the member's company scope) with what the choice needs. */
export async function scopedOrderForChoice(actor: ScopedActor, orderId: string) {
  const order = await accountDb(actor.accountId).order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      number: true,
      status: true,
      companyId: true,
      company: { select: { lineId: true, name: true } },
      lines: { select: { productId: true, quantity: true, title: true, sku: true } },
    },
  });
  if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? "")))
    throw new DomainError("not_found");
  return order;
}

export interface WarehouseOption extends EligibleConnection {
  /** The warehouse belongs to another company of the group than the selling company ("↔ склад на друга фирма"). */
  crossCompany: boolean;
  stock: StockCheck;
}

/** Every eligible warehouse with the stock of the order's lines there. */
export async function warehouseOptions(actor: ScopedActor, orderId: string): Promise<WarehouseOption[]> {
  const order = await scopedOrderForChoice(actor, orderId);
  const connections = await eligibleConnections(actor.accountId, {
    companyId: order.companyId,
    lineId: order.company?.lineId ?? null,
  });
  const lines = order.lines.map((l) => ({
    productId: l.productId,
    quantity: l.quantity,
    title: l.sku ?? l.title,
  }));
  const stock = await stockByConnection(
    actor.accountId,
    connections.map((c) => ({ ...c, enabled: true })),
    lines,
  );
  return connections.map((c) => ({
    ...c,
    crossCompany: !!order.companyId && !!c.companyId && c.companyId !== order.companyId,
    stock: stock.get(c.id) ?? { status: "unknown", lines: [] },
  }));
}
