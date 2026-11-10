import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";

/**
 * "Синхронизация на наличности" settings (owner request 2026-11-10): per product line the anti-sabotage rule, and
 * the stock groups — the stores that sell one warehouse's stock (their Shopify location is mapped to it), which
 * therefore show the same sellable number and lose a unit together when any of them sells it.
 */

const Limit = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(v)))
  .pipe(z.number().int().min(1).max(100_000).nullable());

export const LineGuardInput = z
  .object({
    lineId: z.string().min(1).max(64),
    enabled: z.boolean(),
    maxPerProduct: Limit,
    maxPerOrder: Limit,
  })
  .refine((v) => !v.enabled || v.maxPerProduct != null || v.maxPerOrder != null, {
    message: "guard_needs_limit",
  });

export async function saveLineGuard(actor: ScopedActor, raw: z.input<typeof LineGuardInput>) {
  assertCan(actor.role, "lines.manage");
  const input = LineGuardInput.parse(raw);
  const db = accountDb(actor.accountId);
  const line = await db.productLine.findUnique({ where: { id: input.lineId }, select: { id: true } });
  if (!line) throw new DomainError("not_found");
  const where = { accountId_lineId: { accountId: actor.accountId, lineId: input.lineId } };
  const before = await db.lineStockGuard.findUnique({
    where,
    select: { enabled: true, maxPerProduct: true, maxPerOrder: true },
  });
  const data = {
    enabled: input.enabled,
    maxPerProduct: input.maxPerProduct,
    maxPerOrder: input.maxPerOrder,
    updatedById: actor.userId,
  };
  await db.lineStockGuard.upsert({
    where,
    create: { accountId: actor.accountId, lineId: input.lineId, ...data },
    update: data,
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "line.stock_guard",
    entityType: "ProductLine",
    entityId: input.lineId,
    before: before ?? null,
    after: { enabled: input.enabled, maxPerProduct: input.maxPerProduct, maxPerOrder: input.maxPerOrder },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

export interface StockGroupView {
  lineId: string | null;
  lineName: string | null;
  lineColor: string | null;
  guard: { enabled: boolean; maxPerProduct: number | null; maxPerOrder: number | null } | null;
  warehouses: {
    id: string;
    name: string;
    type: string;
    stores: { id: string; name: string; pushMode: string; buffer: number }[];
  }[];
}

/** Lines with their guard and, per warehouse of the line, the stores that share its stock. */
export async function stockSyncOverview(actor: ScopedActor): Promise<StockGroupView[]> {
  assertCan(actor.role, "inventory.push");
  const db = accountDb(actor.accountId);
  const scope = actor.companyScope ? { companyId: { in: actor.companyScope } } : {};
  const [lines, guards, connections] = await Promise.all([
    db.productLine.findMany({
      // Lines of the member's companies only (all lines for an unrestricted member).
      where: {
        archivedAt: null,
        ...(actor.companyScope ? { companies: { some: { id: { in: actor.companyScope } } } } : {}),
      },
      select: { id: true, name: true, color: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    db.lineStockGuard.findMany({
      select: { lineId: true, enabled: true, maxPerProduct: true, maxPerOrder: true },
    }),
    db.fulfillmentConnection.findMany({
      where: { ...scope, type: { in: ["FHB_V3", "EUSHIPMENTS"] } },
      select: {
        id: true,
        name: true,
        type: true,
        company: { select: { lineId: true } },
        storeLocations: {
          where: {
            isActive: true,
            store: {
              archivedAt: null,
              ...(actor.companyScope ? { companyId: { in: actor.companyScope } } : {}),
            },
          },
          select: {
            store: { select: { id: true, name: true, inventoryPushMode: true, inventoryBuffer: true } },
          },
        },
      },
      orderBy: { name: "asc" },
    }),
  ]);
  const guardOf = new Map(guards.map((g) => [g.lineId, g]));
  const out: StockGroupView[] = lines.map((l) => {
    const g = guardOf.get(l.id);
    return {
      lineId: l.id,
      lineName: l.name,
      lineColor: l.color,
      guard: g ? { enabled: g.enabled, maxPerProduct: g.maxPerProduct, maxPerOrder: g.maxPerOrder } : null,
      warehouses: [],
    };
  });
  const noLine: StockGroupView = {
    lineId: null,
    lineName: null,
    lineColor: null,
    guard: null,
    warehouses: [],
  };
  for (const c of connections) {
    const stores = new Map<string, StockGroupView["warehouses"][number]["stores"][number]>();
    for (const sl of c.storeLocations)
      stores.set(sl.store.id, {
        id: sl.store.id,
        name: sl.store.name,
        pushMode: sl.store.inventoryPushMode,
        buffer: sl.store.inventoryBuffer,
      });
    const entry = { id: c.id, name: c.name, type: c.type, stores: [...stores.values()] };
    (out.find((o) => o.lineId === c.company?.lineId) ?? noLine).warehouses.push(entry);
  }
  return noLine.warehouses.length ? [...out, noLine] : out;
}
