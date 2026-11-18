import type { Prisma } from "@/generated/prisma/client";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { companyFilter } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";

/**
 * Units a warehouse could not give (owner request 2026-11-18). A stuck order cancelled (or re-routed away) with
 * „Няма наличност“ hands its unit back to the warehouse's "available" number although the unit is not on the shelf:
 * sold again, it gets stuck again. Each such cancel is a SkuIncident of its products at that warehouse:
 *  - an open incident keeps its quantity out of what the CRM sells from that warehouse (Shopify push, routing,
 *    „Липсващи артикули“) — counted as reserved;
 *  - two open incidents of one product at one warehouse within FREEZE_WINDOW → the product is frozen there:
 *    nothing of it is sold from that warehouse;
 *  - a person unlocks it (the warehouse wrote that it has the goods, or a stock count), with a note; audited.
 * Nothing here talks to a warehouse or to Shopify; the numbers simply change at the next push.
 */

type Tx = Prisma.TransactionClient;
export const FREEZE_WINDOW_MS = 14 * 86_400_000;
/** What a frozen product counts as reserved: more than any warehouse holds (sellable clamps at 0). */
export const FROZEN_UNITS = 1_000_000_000;

/** Warehouses whose "available" number takes a cancelled order's unit back whether or not it is there. */
const PHANTOM_TYPES = new Set<string>(["EUSHIPMENTS"]);

export const holdKey = (connectionId: string, productId: string) => `${connectionId}:${productId}`;

/** Records the incidents of one cancelled shipment (idempotent per shipment and product). */
export async function recordSkuIncident(tx: Tx, input: { accountId: string; fulfillmentId: string }) {
  const f = await tx.fulfillment.findFirst({
    where: { id: input.fulfillmentId, accountId: input.accountId },
    select: {
      connectionId: true,
      connection: { select: { type: true } },
      lines: { select: { quantity: true, orderLine: { select: { productId: true } } } },
      order: { select: { lines: { select: { productId: true, quantity: true } } } },
    },
  });
  // Only where the warehouse's number lies after a cancel: euShipments gives the unit back to "available".
  // FHB's physical counts what is on the shelf, so a cancel there invents nothing.
  if (!f || !PHANTOM_TYPES.has(f.connection.type)) return 0;
  // The shipment's own lines (a split carries only part of the order); the order's lines for an older shipment.
  const lines = f.lines.length
    ? f.lines.map((l) => ({ productId: l.orderLine.productId, quantity: l.quantity }))
    : f.order.lines;
  const qty = new Map<string, number>();
  for (const l of lines)
    if (l.productId && l.quantity > 0) qty.set(l.productId, (qty.get(l.productId) ?? 0) + l.quantity);
  if (!qty.size) return 0;
  const r = await tx.skuIncident.createMany({
    data: [...qty].map(([productId, quantity]) => ({
      accountId: input.accountId,
      connectionId: f.connectionId,
      productId,
      fulfillmentId: input.fulfillmentId,
      quantity,
    })),
    skipDuplicates: true,
  });
  return r.count;
}

export interface SkuHold {
  connectionId: string;
  productId: string;
  /** Units kept out (the open incidents' quantities). */
  units: number;
  incidents: number;
  frozen: boolean;
  firstAt: Date;
  lastAt: Date;
}

/** Pure: two open incidents within the window → frozen. */
export function isFrozen(dates: Date[]) {
  const t = dates.map((d) => d.getTime()).sort((a, b) => a - b);
  for (let i = 1; i < t.length; i++) if (t[i]! - t[i - 1]! <= FREEZE_WINDOW_MS) return true;
  return false;
}

/** The open holds of an account (optionally only some products), per warehouse and product. */
export async function skuHolds(accountId: string, onlyProductIds?: string[]): Promise<Map<string, SkuHold>> {
  const rows = await accountDb(accountId).skuIncident.findMany({
    where: { clearedAt: null, ...(onlyProductIds ? { productId: { in: onlyProductIds } } : {}) },
    select: { connectionId: true, productId: true, quantity: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const grouped = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = holdKey(r.connectionId, r.productId);
    grouped.set(k, [...(grouped.get(k) ?? []), r]);
  }
  const out = new Map<string, SkuHold>();
  for (const [k, list] of grouped) {
    out.set(k, {
      connectionId: list[0]!.connectionId,
      productId: list[0]!.productId,
      units: list.reduce((s, r) => s + r.quantity, 0),
      incidents: list.length,
      frozen: isFrozen(list.map((r) => r.createdAt)),
      firstAt: list[0]!.createdAt,
      lastAt: list.at(-1)!.createdAt,
    });
  }
  return out;
}

/** Units to count as reserved for a hold (all of them when frozen). */
export const heldUnits = (h: SkuHold) => (h.frozen ? FROZEN_UNITS : h.units);

export const UnlockSkuInput = z.object({
  connectionId: z.string().min(1).max(64),
  productId: z.string().min(1).max(64),
  note: z.string().trim().min(3).max(500),
});

/** A person unlocks a product at a warehouse: every open incident of it is cleared. */
export async function unlockSku(actor: ScopedActor, raw: z.input<typeof UnlockSkuInput>) {
  assertCan(actor.role, "orders.review");
  const input = UnlockSkuInput.parse(raw);
  const db = accountDb(actor.accountId);
  // Only at a warehouse of the actor's companies.
  const conn = await db.fulfillmentConnection.findFirst({
    where: { id: input.connectionId, accountId: actor.accountId },
    select: { companyId: true },
  });
  if (!conn || (actor.companyScope && !actor.companyScope.includes(conn.companyId ?? "")))
    throw new DomainError("not_found");
  const r = await db.skuIncident.updateMany({
    where: {
      accountId: actor.accountId,
      connectionId: input.connectionId,
      productId: input.productId,
      clearedAt: null,
    },
    data: { clearedAt: new Date(), clearedById: actor.userId, clearNote: input.note },
  });
  if (!r.count) throw new DomainError("not_found");
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "sku_hold.unlock",
    entityType: "Product",
    entityId: input.productId,
    after: { connectionId: input.connectionId, cleared: r.count, note: input.note },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return r.count;
}

/** The "SKU под наблюдение" list: the warehouses of the companies the viewer sees (and the sidebar's choice). */
export async function skuWatchList(
  actor: Pick<ScopedActor, "accountId" | "companyScope"> & {
    activeCompanyId?: string | null;
    lineCompanyIds?: string[] | null;
  },
) {
  const accountId = actor.accountId;
  const db = accountDb(accountId);
  const visible = new Set(
    (
      await db.fulfillmentConnection.findMany({
        where: companyFilter({
          companyScope: actor.companyScope,
          activeCompanyId: actor.activeCompanyId ?? null,
          lineCompanyIds: actor.lineCompanyIds ?? null,
        }),
        select: { id: true },
      })
    ).map((c) => c.id),
  );
  const holds = [...(await skuHolds(accountId)).values()].filter((h) => visible.has(h.connectionId));
  if (!holds.length) return [];
  const [products, connections] = await Promise.all([
    db.product.findMany({
      where: { id: { in: [...new Set(holds.map((h) => h.productId))] } },
      select: { id: true, sku: true, name: true },
    }),
    db.fulfillmentConnection.findMany({
      where: { id: { in: [...new Set(holds.map((h) => h.connectionId))] } },
      select: { id: true, name: true },
    }),
  ]);
  const p = new Map(products.map((x) => [x.id, x]));
  const c = new Map(connections.map((x) => [x.id, x.name]));
  return holds
    .map((h) => ({
      ...h,
      sku: p.get(h.productId)?.sku ?? null,
      title: p.get(h.productId)?.name ?? h.productId,
      connectionName: c.get(h.connectionId) ?? h.connectionId,
    }))
    .sort((a, b) => Number(b.frozen) - Number(a.frozen) || b.lastAt.getTime() - a.lastAt.getTime());
}
