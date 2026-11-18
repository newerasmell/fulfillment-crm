import type { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { accountDb, systemDb } from "@/server/db/client";
import { CANCEL_IN_FLIGHT, CANCEL_OPERATIONS } from "@/server/override/cancel-effects";
import { eligibleConnections } from "@/server/override/options";
import { stockByConnection } from "@/server/routing/route";
import { isStale } from "./levels";
import { getStockSettings, staleHoursFor } from "./settings";

/**
 * Shipments the warehouse accepted but cannot fill (owner request 2026-11-18): an order "Приета от склада" for hours
 * while that warehouse has NOT ONE unit of an item it needs (fresh stock snapshot: physical 0 and free 0). Such an
 * order otherwise sits there until the 48-hour "stuck" alert. One task per order says what to do:
 *  - another warehouse of the order's line has the whole order → "Пренасочи към друг склад" (the existing re-route:
 *    the old warehouse confirms the cancel, then the order goes to the new one);
 *  - nowhere → "Откажи в склада" with the reason „Няма наличност“: once the warehouse confirms the cancel, the order
 *    goes to „Липсващи артикули“ by itself (cancel-effects.ts), where an expected inbound is shown.
 * Nothing is cancelled automatically: a stale or wrong snapshot must never stop a parcel that is leaving. The task
 * closes by itself once the shipment moves on or the units are back.
 */

export const NO_STOCK_TASK = "warehouse_stock_missing";
/** The warehouse had this long to sync its numbers (and to send the parcel) after accepting the order. */
export const NO_STOCK_GRACE_MS = 6 * 3_600_000;
/** No status news of the shipment for this long: a parcel that just left is not mistaken for a stuck one. */
export const NO_STOCK_QUIET_MS = 3_600_000;
/**
 * FHB: physical counts the units of accepted orders until they leave, so physical 0 means not one unit is there.
 * euShipments gives one available number with the accepted orders already taken out (the owner sees 0 while the
 * order holds its unit), so 0 alone proves nothing: there it takes a full day with no movement of the shipment as
 * well, and the task says "probably" and asks to check the cabinet.
 */
const RULES: Record<string, { graceMs: number; quietMs: number; probable: boolean }> = {
  FHB_V3: { graceMs: NO_STOCK_GRACE_MS, quietMs: NO_STOCK_QUIET_MS, probable: false },
  EUSHIPMENTS: { graceMs: 24 * 3_600_000, quietMs: 24 * 3_600_000, probable: true },
};
const CHECKED_TYPES = Object.keys(RULES);
const SHORTEST = {
  graceMs: Math.min(...Object.values(RULES).map((x) => x.graceMs)),
  quietMs: Math.min(...Object.values(RULES).map((x) => x.quietMs)),
};
const PAGE = 1000;
/** Movement = a status from the warehouse itself (not a Shopify write-back, a label or a COD event). */
const WAREHOUSE_STATUS = {
  OR: [{ source: "eushipments" }, { source: { startsWith: "fhb:" } }],
} satisfies Prisma.FulfillmentEventWhereInput;

export interface NoStockFinding {
  orderId: string;
  number: string;
  connectionName: string;
  missing: string[];
  /** Only likely (euShipments: no movement for a day while the number shows 0): check the cabinet first. */
  probable: boolean;
  /** Another warehouse of the line that has the whole order now (by its sellable numbers). */
  alternative: string | null;
}

/**
 * The accepted shipments of one account whose warehouse has none of an item they carry. Reads only. `checked` lists
 * every order looked at (a task of an order not looked at is never closed on this run's word).
 */
export async function shipmentsWithoutStock(accountId: string, now: Date = new Date()) {
  const db = accountDb(accountId);
  const settings = await getStockSettings(accountId);
  const before = (ms: number) => new Date(now.getTime() - ms);
  // A vendor date in the future (time zone, day/month mix-up) never counts as movement.
  const soon = new Date(now.getTime() + 3_600_000);
  const fetchPage = (cursor: string | undefined) =>
    db.fulfillment.findMany({
      where: {
        accountId,
        status: "ACCEPTED",
        order: { status: "ACCEPTED" },
        connection: { type: { in: CHECKED_TYPES as never } },
        // No new status of the shipment for a while (euShipments rewrites the row on every poll: the events tell).
        events: {
          none: { ...WAREHOUSE_STATUS, occurredAt: { gt: before(SHORTEST.quietMs), lte: soon } },
        },
        OR: [
          { submittedAt: { lte: before(SHORTEST.graceMs) } },
          { submittedAt: null, createdAt: { lte: before(SHORTEST.graceMs) } },
        ],
        // A re-route or a warehouse cancel already on its way (or unclear) decides for itself.
        reroutesFrom: { none: { status: { in: ["CANCEL_QUEUED", "UNCERTAIN"] } } },
        outboundRequests: {
          none: { operation: { in: [...CANCEL_OPERATIONS] }, status: { in: [...CANCEL_IN_FLIGHT] } },
        },
      },
      select: {
        id: true,
        events: {
          where: { ...WAREHOUSE_STATUS, occurredAt: { lte: soon } },
          select: { occurredAt: true },
          orderBy: { occurredAt: "desc" },
          take: 1,
        },
        submittedAt: true,
        createdAt: true,
        connectionId: true,
        connection: { select: { name: true, type: true } },
        // The shipment's own lines (a split / reship carries only part of the order).
        lines: {
          select: { quantity: true, orderLine: { select: { productId: true, sku: true, title: true } } },
        },
        order: {
          select: {
            id: true,
            number: true,
            companyId: true,
            company: { select: { lineId: true } },
            lines: { select: { productId: true, quantity: true, title: true, sku: true } },
          },
        },
      },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  const shipments: Awaited<ReturnType<typeof fetchPage>> = [];
  for (let cursor: string | undefined; ;) {
    const page = await fetchPage(cursor);
    shipments.push(...page);
    if (page.length < PAGE) break;
    cursor = page.at(-1)!.id;
  }
  const checked = new Set(shipments.map((s) => s.order.id));
  const linesOf = (s: (typeof shipments)[number]) =>
    (s.lines.length ? s.lines.map((l) => ({ ...l.orderLine, quantity: l.quantity })) : s.order.lines).filter(
      (l): l is typeof l & { productId: string } => !!l.productId && l.quantity > 0,
    );
  // Every stock level needed, in one read.
  const vps = shipments.length
    ? await db.vendorProduct.findMany({
        where: {
          accountId,
          archived: false,
          connectionId: { in: [...new Set(shipments.map((s) => s.connectionId))] },
          productId: { in: [...new Set(shipments.flatMap((s) => linesOf(s).map((l) => l.productId)))] },
        },
        select: {
          connectionId: true,
          productId: true,
          stockLevel: { select: { physical: true, free: true, snapshotAt: true } },
        },
      })
    : [];
  const levels = new Map<string, NonNullable<(typeof vps)[number]["stockLevel"]>[]>();
  for (const v of vps) {
    if (!v.stockLevel) continue;
    const k = `${v.connectionId}:${v.productId}`;
    levels.set(k, [...(levels.get(k) ?? []), v.stockLevel]);
  }
  const eligible = new Map<string, Awaited<ReturnType<typeof eligibleConnections>>>();
  const byOrder = new Map<string, NoStockFinding>();
  const keep = new Set<string>();
  for (const s of shipments) {
    const lines = linesOf(s);
    if (!lines.length) continue;
    const rule = RULES[s.connection.type]!;
    // The slower warehouse's own waiting time (the query used the shortest one).
    const lastMove = s.events[0]?.occurredAt ?? s.submittedAt ?? s.createdAt;
    if (lastMove > before(rule.quietMs) || (s.submittedAt ?? s.createdAt) > before(rule.graceMs)) continue;
    const stale = staleHoursFor(settings, s.connection.type);
    // A line whose numbers are all stale says nothing either way: the order's task is neither opened nor closed.
    if (
      lines.some((l) => {
        const lv = levels.get(`${s.connectionId}:${l.productId}`) ?? [];
        return lv.length > 0 && lv.every((x) => isStale(x.snapshotAt, stale, now));
      })
    )
      keep.add(s.order.id);
    const missing = lines.filter((l) => {
      const lv = levels.get(`${s.connectionId}:${l.productId}`) ?? [];
      // Only fresh snapshots that ALL show not one unit (two links to one product: any with stock wins).
      return (
        lv.length > 0 && lv.every((x) => !isStale(x.snapshotAt, stale, now) && x.physical <= 0 && x.free <= 0)
      );
    });
    if (!missing.length) continue;
    const key = `${s.order.companyId}:${s.order.company?.lineId ?? ""}`;
    if (!eligible.has(key))
      eligible.set(
        key,
        await eligibleConnections(accountId, {
          companyId: s.order.companyId,
          lineId: s.order.company?.lineId ?? null,
        }),
      );
    // A warehouse that would refuse the re-route (READ_ONLY) is never suggested.
    const others = eligible.get(key)!.filter((c) => c.id !== s.connectionId && c.liveMode !== "READ_ONLY");
    const stock = others.length
      ? await stockByConnection(
          accountId,
          others.map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type,
            companyId: c.companyId,
            enabled: true,
          })),
          s.order.lines.map((l) => ({
            productId: l.productId,
            quantity: l.quantity,
            title: l.sku ?? l.title,
          })),
        )
      : new Map();
    const alt = others.find((c) => stock.get(c.id)?.status === "ok");
    const prev = byOrder.get(s.order.id);
    byOrder.set(s.order.id, {
      orderId: s.order.id,
      number: s.order.number,
      connectionName: prev ? `${prev.connectionName}, ${s.connection.name}` : s.connection.name,
      missing: [...new Set([...(prev?.missing ?? []), ...missing.map((l) => l.sku ?? l.title)])],
      alternative: prev ? (prev.alternative ?? alt?.name ?? null) : (alt?.name ?? null),
      probable: (prev?.probable ?? false) || rule.probable,
    });
  }
  return Object.assign([...byOrder.values()], { checked, keep });
}

function taskText(f: NoStockFinding) {
  const items = f.missing.join(", ");
  if (f.probable) {
    const title =
      `Поръчка ${f.number}: стои в склада ${f.connectionName} над ден без движение, ${items} показва 0 — ` +
      `проверете в кабинета дали има бройка` +
      (f.alternative
        ? ` (има в ${f.alternative} → пренасочете)`
        : ` (ако няма → откажете с причина „Няма наличност“)`);
    const body =
      `The shipment has not moved for a day and the warehouse shows 0 of ${items}. euShipments shows the available ` +
      `number with accepted orders already taken out, so 0 alone does not prove the unit is missing: check the cabinet. ` +
      (f.alternative
        ? `${f.alternative} has the whole order: "Пренасочи към друг склад".`
        : `If it is not there: "Откажи в склада" with the reason „Няма наличност“ — once the warehouse confirms, the ` +
          `order goes to „Липсващи артикули“ by itself.`);
    return { title: title.slice(0, 300), body };
  }
  const title = f.alternative
    ? `Поръчка ${f.number}: в склада ${f.connectionName} няма ${items} — пренасочете към ${f.alternative}`
    : `Поръчка ${f.number}: в склада ${f.connectionName} няма ${items}, няма и в другите складове — откажете в склада с причина „Няма наличност“`;
  const body = f.alternative
    ? `The warehouse accepted the order but its last stock snapshot shows no unit of ${items}. ${f.alternative} has ` +
      `the whole order: "Пренасочи към друг склад" on the order page (the old warehouse confirms the cancel first).`
    : `The warehouse accepted the order but its last stock snapshot shows no unit of ${items}, and no other warehouse of ` +
      `the line has the order. "Откажи в склада" with the reason „Няма наличност“: once the warehouse confirms the ` +
      `cancel, the order goes to „Липсващи артикули“ by itself (an expected inbound is shown there).`;
  return { title: title.slice(0, 300), body };
}

/** Every account: opens one task per stuck order, closes the tasks whose order is no longer stuck. */
export async function sweepShipmentsWithoutStock(now: Date = new Date()) {
  const db = systemDb();
  const accounts = await db.account.findMany({ select: { id: true } });
  let opened = 0;
  let resolved = 0;
  for (const { id: accountId } of accounts) {
    let found: Awaited<ReturnType<typeof shipmentsWithoutStock>>;
    try {
      found = await shipmentsWithoutStock(accountId, now);
    } catch (err) {
      logger.warn({ accountId, err: String(err) }, "no-stock check failed");
      continue;
    }
    const wanted = new Map(found.map((f) => [f.orderId, f]));
    const checked = found.checked;
    const open = await db.alert.findMany({
      where: { accountId, kind: NO_STOCK_TASK, entityType: "Order", status: { not: "RESOLVED" } },
      select: { id: true, entityId: true, title: true },
    });
    for (const a of open) {
      const f = a.entityId ? wanted.get(a.entityId) : undefined;
      if (!f) {
        // Closed only for an order this run looked at and found fine (shipment moved on / units back).
        if (a.entityId && found.keep.has(a.entityId)) continue;
        if (a.entityId && !checked.has(a.entityId)) {
          const still = await db.fulfillment.count({
            where: { accountId, orderId: a.entityId, status: "ACCEPTED", order: { status: "ACCEPTED" } },
          });
          if (still) continue;
        }
        const r = await db.alert.updateMany({
          where: { id: a.id, accountId, status: { not: "RESOLVED" } },
          data: { status: "RESOLVED", resolvedAt: now },
        });
        if (r.count) {
          resolved++;
          await db.alertNote.create({
            data: {
              accountId,
              alertId: a.id,
              action: "auto_resolve",
              note: "shipment moved on or stock is back",
            },
          });
        }
        continue;
      }
      // The advice changed (another warehouse got the units, or lost them): the task says it.
      const { title, body } = taskText(f);
      if (a.title !== title)
        await db.alert.updateMany({ where: { id: a.id, accountId }, data: { title, body } });
      wanted.delete(f.orderId);
    }
    for (const f of wanted.values()) {
      const { title, body } = taskText(f);
      await db.alert.create({
        data: {
          accountId,
          kind: NO_STOCK_TASK,
          severity: "CRITICAL",
          isTask: true,
          title,
          body,
          entityType: "Order",
          entityId: f.orderId,
        },
      });
      opened++;
    }
  }
  return { opened, resolved };
}
