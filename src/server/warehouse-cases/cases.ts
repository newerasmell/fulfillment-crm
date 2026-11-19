import type { CrmOrderStatus, Prisma } from "@/generated/prisma/client";
import { z } from "zod";
import { elapsedMs } from "@/integrations/eushipments/status-map";
import { logger } from "@/lib/logger";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan, can } from "@/server/auth/rbac";
import { companyFilter } from "@/server/companies";
import { accountDb, systemDb, withAccountTransaction } from "@/server/db/client";
import { CANCEL_IN_FLIGHT, CANCEL_OPERATIONS } from "@/server/override/cancel-effects";
import { isStale } from "@/server/stock/levels";
import { getStockSettings, staleHoursFor } from "@/server/stock/settings";
import type { ScopedActor } from "@/server/stores";
import {
  warehouseEmail,
  WAREHOUSE_LEVELS,
  type CaseLine,
  type CustomerEmailInput,
  type Email,
  type WarehouseLevel,
} from "@/lib/warehouse-case-emails";
import { defaultsFor, escalationSettingsByCompany, type EscalationSettings } from "./settings";
import { holdKey, skuHolds } from "./sku";

/**
 * „Блокирани в склад“ (owner request 2026-11-18, real case: orders in euShipments "Awaiting pickup" for days, emails
 * unanswered). A shipment the warehouse accepted but has not handed to the courier is "stuck" from `flagHours` after
 * the CRM sent it (Saturdays and Sundays not counted by default). The stuck shipments of one warehouse account
 * (company × connection) form one open case:
 *   level 0 (flagHours, 12 h)        on the screen only;
 *   level 1 (firstEmailHours, 24 h)  first email to the warehouse is due;
 *   level 2 (reminderHours, 48 h)    second notice;
 *   level 3 (decisionHours, 72 h)    final notice + decision: ship or cancel (owner: within 2–3 days), and the
 *                                    customer is written to (replacement / refund / discount code).
 * The CRM only assembles the emails; a person sends them from the company's Gmail and marks them sent, and pastes
 * the warehouse's replies. Nothing is cancelled, re-routed or sent by itself. A shipment leaves its case by itself
 * when it moves (handed to the courier, cancelled …); a case with no stuck shipment left closes.
 * euShipments deletes an order only in New / Information received / Awaiting pickup and only for 14 days: the screen
 * shows that date.
 */

export const CASE_TASK = "warehouse_case_email_due";
const CHECKED_TYPES = ["EUSHIPMENTS", "FHB_V3"] as const;
/** "Not handed to the courier yet": accepted; FHB also confirmed / packed (PROCESSING) — still in the building. */
const STUCK_FULFILLMENT: Record<string, readonly CrmOrderStatus[]> = {
  EUSHIPMENTS: ["ACCEPTED"],
  FHB_V3: ["ACCEPTED", "PROCESSING"],
};
const STUCK_ORDER: CrmOrderStatus[] = ["ACCEPTED", "PROCESSING"];
const SHIPPED: readonly string[] = ["SHIPPED", "DELIVERED", "COD_PAID", "RETURNING", "RETURN_RECEIVED"];
export const EU_DELETE_DAYS = 14;
const HOUR = 3_600_000;

/** Pure: the level of one shipment for its company's settings. */
export function levelOf(
  hours: number,
  s: Pick<EscalationSettings, "firstEmailHours" | "reminderHours" | "decisionHours">,
) {
  if (hours >= s.decisionHours) return 3;
  if (hours >= s.reminderHours) return 2;
  if (hours >= s.firstEmailHours) return 1;
  return 0;
}

/** Pure: the email to offer next: never skips a step (1 → 2 → 3), never above the case's level. */
export function suggestedLevel(caseLevel: number, lastSentLevel: number): WarehouseLevel | null {
  if (caseLevel < 1) return null;
  return Math.max(1, Math.min(caseLevel, lastSentLevel + 1, 3)) as WarehouseLevel;
}

export interface StuckShipment {
  fulfillmentId: string;
  orderId: string;
  companyId: string;
  connectionId: string;
  since: Date;
  hours: number;
}

type Tx = Prisma.TransactionClient;
const STUCK_CAP = 5000;
/** euShipments deletes only in these statuses (and for 14 days); other waiting statuses get no date. */
const EU_DELETABLE = new Set(["new", "information received", "awaiting pickup"]);
const euDeleteUntil = (type: string, rawStatus: string | null, since: Date) =>
  // No status yet = just accepted ("New").
  type === "EUSHIPMENTS" && EU_DELETABLE.has((rawStatus ?? "new").trim().toLowerCase())
    ? new Date(since.getTime() + EU_DELETE_DAYS * 86_400_000)
    : null;
const isStuckStatus = (type: string, status: string) =>
  (STUCK_FULFILLMENT[type] ?? []).includes(status as CrmOrderStatus);

/** The stuck shipments of one account right now (reads only). */
async function stuckShipments(
  tx: Tx,
  accountId: string,
  settings: Map<string, EscalationSettings>,
  now: Date,
) {
  const minFlag = Math.min(defaultsFor("").flagHours, ...[...settings.values()].map((s) => s.flagHours));
  const rows = await tx.fulfillment.findMany({
    where: {
      accountId,
      status: { in: ["ACCEPTED", "PROCESSING"] },
      order: { status: { in: STUCK_ORDER } },
      connection: { type: { in: [...CHECKED_TYPES] } },
      // Calendar time is never less than working time: a cheap first cut.
      OR: [
        { submittedAt: { lte: new Date(now.getTime() - minFlag * HOUR) } },
        { submittedAt: null, createdAt: { lte: new Date(now.getTime() - minFlag * HOUR) } },
      ],
    },
    select: {
      id: true,
      orderId: true,
      status: true,
      submittedAt: true,
      createdAt: true,
      connectionId: true,
      connection: { select: { type: true, companyId: true } },
      order: { select: { companyId: true } },
    },
    orderBy: { submittedAt: "asc" },
    take: STUCK_CAP,
  });
  if (rows.length === STUCK_CAP)
    logger.warn({ accountId, cap: STUCK_CAP }, "warehouse cases: more stuck shipments than one run reads");
  const out: StuckShipment[] = [];
  for (const f of rows) {
    if (!isStuckStatus(f.connection.type, f.status)) continue;
    // The warehouse account's company writes to its warehouse (an order of another company may ship from it).
    const companyId = f.connection.companyId ?? f.order.companyId;
    if (!companyId) continue;
    const s = settings.get(companyId) ?? defaultsFor(companyId);
    const since = f.submittedAt ?? f.createdAt;
    const hours = Math.floor(elapsedMs(since, now, s.workDaysOnly) / HOUR);
    if (hours < s.flagHours) continue;
    out.push({
      fulfillmentId: f.id,
      orderId: f.orderId,
      companyId,
      connectionId: f.connectionId,
      since,
      hours,
    });
  }
  return out;
}

const openKeyOf = (companyId: string, connectionId: string) => `${companyId}:${connectionId}`;

async function openCase(tx: Tx, accountId: string, companyId: string, connectionId: string) {
  const openKey = openKeyOf(companyId, connectionId);
  const found = await tx.warehouseCase.findFirst({ where: { accountId, openKey }, select: { id: true } });
  if (found) return found.id;
  // Under the account's case lock: no second writer can create the same open case meanwhile.
  const c = await tx.warehouseCase.create({ data: { accountId, companyId, connectionId, openKey } });
  return c.id;
}

/** One writer per account at a time: the job, the refresh button and "Изпратено" never interleave. */
function withCaseLock<T>(accountId: string, fn: (tx: Tx) => Promise<T>) {
  return withAccountTransaction(
    accountId,
    async (tx, { lockKey }) => {
      await lockKey(`warehouse-cases:${accountId}`);
      return fn(tx);
    },
    { timeout: 60_000, maxWait: 30_000 },
  );
}

/** Brings one account's cases up to date: adds newly stuck shipments, settles moved ones, closes empty cases. */
export async function syncWarehouseCases(accountId: string, now: Date = new Date()) {
  const settings = await escalationSettingsByCompany(accountId);
  return withCaseLock(accountId, async (tx) => {
    const stuck = await stuckShipments(tx, accountId, settings, now);
    const stuckIds = new Set(stuck.map((s) => s.fulfillmentId));
    let added = 0;
    const caseIds = new Map<string, string>();
    for (const s of stuck) {
      const key = openKeyOf(s.companyId, s.connectionId);
      if (!caseIds.has(key)) caseIds.set(key, await openCase(tx, accountId, s.companyId, s.connectionId));
    }
    if (stuck.length) {
      added += (
        await tx.warehouseCaseOrder.createMany({
          data: stuck.map((s) => ({
            accountId,
            caseId: caseIds.get(openKeyOf(s.companyId, s.connectionId))!,
            orderId: s.orderId,
            fulfillmentId: s.fulfillmentId,
            since: s.since,
          })),
          skipDuplicates: true,
        })
      ).count;
      // Stuck again after it left its open case for a while (e.g. cancelled by mistake, then back): back in.
      added += (
        await tx.warehouseCaseOrder.updateMany({
          where: {
            accountId,
            caseId: { in: [...caseIds.values()] },
            fulfillmentId: { in: [...stuckIds] },
            resolvedAt: { not: null },
          },
          data: { resolvedAt: null, outcome: null },
        })
      ).count;
    }
    // Shipments of open cases that are no longer stuck: settled by what happened to the shipment itself.
    const open = await tx.warehouseCaseOrder.findMany({
      where: { accountId, resolvedAt: null, case: { closedAt: null } },
      select: {
        id: true,
        fulfillmentId: true,
        fulfillment: { select: { status: true, connection: { select: { type: true } } } },
        order: { select: { status: true } },
      },
    });
    let settled = 0;
    const byOutcome = new Map<string, string[]>();
    for (const o of open) {
      if (stuckIds.has(o.fulfillmentId)) continue;
      const st = o.fulfillment.status;
      // Still waiting in the building (the order paused, or the company's hours were raised): left as it is.
      if (isStuckStatus(o.fulfillment.connection.type, st) && o.order.status !== "CANCELLED") continue;
      const outcome = SHIPPED.includes(st) ? "shipped" : st === "CANCELLED" ? "cancelled" : "other";
      byOutcome.set(outcome, [...(byOutcome.get(outcome) ?? []), o.id]);
    }
    for (const [outcome, ids] of byOutcome)
      settled += (
        await tx.warehouseCaseOrder.updateMany({
          where: { id: { in: ids }, accountId, resolvedAt: null },
          data: { resolvedAt: now, outcome },
        })
      ).count;
    // A case with nothing stuck left is closed (a new stuck shipment opens a new case).
    const empty = await tx.warehouseCase.findMany({
      where: { accountId, closedAt: null, orders: { none: { resolvedAt: null } } },
      select: { id: true },
    });
    for (const c of empty)
      await tx.warehouseCase.updateMany({
        where: { id: c.id, accountId, closedAt: null },
        data: { closedAt: now, openKey: null },
      });
    await syncCaseTasks(tx, accountId, settings, now);
    return { added, settled, closed: empty.length };
  });
}

/**
 * One task per warehouse connection while an email is due that has not been sent; CRITICAL at the decision level.
 * A task a person closed by hand is not opened again for the same email of the same case.
 */
async function syncCaseTasks(
  tx: Tx,
  accountId: string,
  settings: Map<string, EscalationSettings>,
  now: Date,
) {
  const cases = await caseSummaries(tx, accountId, settings, now);
  const due = new Map<string, CaseSummary>();
  for (const c of cases) {
    if (!c.suggested || c.suggested <= c.lastSentLevel) continue;
    const prev = due.get(c.connectionId);
    if (!prev || c.level > prev.level) due.set(c.connectionId, c);
  }
  const tasks = await tx.alert.findMany({
    where: { accountId, kind: CASE_TASK, entityType: "FulfillmentConnection" },
    select: {
      id: true,
      entityId: true,
      title: true,
      body: true,
      status: true,
      createdAt: true,
      notes: { where: { action: "auto_resolve" }, select: { id: true }, take: 1 },
    },
  });
  for (const a of tasks.filter((x) => x.status !== "RESOLVED")) {
    const c = a.entityId ? due.get(a.entityId) : undefined;
    if (!c) {
      const r = await tx.alert.updateMany({
        where: { id: a.id, accountId, status: { not: "RESOLVED" } },
        data: { status: "RESOLVED", resolvedAt: now },
      });
      if (r.count)
        await tx.alertNote.create({
          data: { accountId, alertId: a.id, action: "auto_resolve", note: "email sent or case closed" },
        });
      continue;
    }
    const t = taskText(c);
    if (a.title !== t.title || a.body !== t.body)
      await tx.alert.updateMany({
        where: { id: a.id, accountId },
        data: { title: t.title, body: t.body, severity: t.severity },
      });
    due.delete(a.entityId!);
  }
  for (const c of due.values()) {
    const t = taskText(c);
    const closedByHand = tasks.some(
      (a) =>
        a.status === "RESOLVED" &&
        a.entityId === c.connectionId &&
        a.createdAt >= c.openedAt &&
        a.body?.startsWith(emailMark(c.suggested)) &&
        a.notes.length === 0,
    );
    if (closedByHand) continue;
    await tx.alert.create({
      data: {
        accountId,
        kind: CASE_TASK,
        severity: t.severity,
        isTask: true,
        title: t.title,
        body: t.body,
        entityType: "FulfillmentConnection",
        entityId: c.connectionId,
      },
    });
  }
}

const emailMark = (level: WarehouseLevel | null) => `[email ${level}]`;

function taskText(c: CaseSummary) {
  const what =
    c.suggested === 1 ? "първи мейл" : c.suggested === 2 ? "напомняне" : "последно предупреждение и решение";
  return {
    severity: (c.level >= 3 ? "CRITICAL" : "WARNING") as "CRITICAL" | "WARNING",
    title:
      `Блокирани в склад ${c.connectionName} (${c.companyName}): ${c.openCount} поръчки, най-старата ${c.oldestHours} ч — ` +
      `изпратете ${what} от „Блокирани в склад“`,
    body:
      `${emailMark(c.suggested)} ${c.openCount} shipments have not left the warehouse; the oldest for ` +
      `${c.oldestHours} h (level ${c.level}). Open „Блокирани в склад“, copy email ${c.suggested} into the ` +
      `company's Gmail, send it and mark it sent.`,
  };
}

interface CaseSummary {
  id: string;
  openedAt: Date;
  companyId: string;
  companyName: string;
  connectionId: string;
  connectionName: string;
  openCount: number;
  oldestHours: number;
  level: number;
  lastSentLevel: number;
  suggested: WarehouseLevel | null;
}

/** Open cases with their level (the task sync). */
async function caseSummaries(
  tx: Tx,
  accountId: string,
  settings: Map<string, EscalationSettings>,
  now: Date,
): Promise<CaseSummary[]> {
  const cases = await tx.warehouseCase.findMany({
    where: { accountId, closedAt: null },
    select: {
      id: true,
      openedAt: true,
      companyId: true,
      connectionId: true,
      company: { select: { name: true } },
      connection: { select: { name: true } },
      orders: { where: { resolvedAt: null }, select: { since: true } },
      messages: { where: { direction: "OUT", kind: { startsWith: "warehouse_" } }, select: { kind: true } },
    },
  });
  return cases.map((c) => {
    const s = settings.get(c.companyId) ?? defaultsFor(c.companyId);
    const hours = c.orders.map((o) => Math.floor(elapsedMs(o.since, now, s.workDaysOnly) / HOUR));
    const oldestHours = Math.max(0, ...hours);
    const level = levelOf(oldestHours, s);
    const lastSentLevel = Math.max(
      0,
      ...c.messages.map((m) => Number(m.kind.slice("warehouse_".length)) || 0),
    );
    return {
      id: c.id,
      openedAt: c.openedAt,
      companyId: c.companyId,
      companyName: c.company.name,
      connectionId: c.connectionId,
      connectionName: c.connection.name,
      openCount: c.orders.length,
      oldestHours,
      level,
      lastSentLevel,
      suggested: suggestedLevel(level, lastSentLevel),
    };
  });
}

/** Every account (the stock job, every 30 min). */
export async function sweepWarehouseCases(now: Date = new Date()) {
  const accounts = await systemDb().account.findMany({ select: { id: true } });
  const total = { added: 0, settled: 0, closed: 0 };
  for (const { id } of accounts) {
    try {
      const r = await syncWarehouseCases(id, now);
      total.added += r.added;
      total.settled += r.settled;
      total.closed += r.closed;
    } catch (err) {
      logger.warn({ accountId: id, err: String(err) }, "warehouse case sync failed");
    }
  }
  return total;
}

type View = ScopedActor & { activeCompanyId?: string | null; lineCompanyIds?: string[] | null };

/** The „Блокирани в склад“ screen: open cases (and the last week's closed ones), with every email ready. */
export async function warehouseCasesView(actor: View, now: Date = new Date()) {
  const db = accountDb(actor.accountId);
  const canSeeCustomers = can(actor.role, "orders.review");
  const scope = companyFilter({
    companyScope: actor.companyScope,
    activeCompanyId: actor.activeCompanyId ?? null,
    lineCompanyIds: actor.lineCompanyIds ?? null,
  });
  const [settings, stock] = await Promise.all([
    escalationSettingsByCompany(actor.accountId),
    getStockSettings(actor.accountId),
  ]);
  const cases = await db.warehouseCase.findMany({
    where: {
      ...scope,
      OR: [{ closedAt: null }, { closedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } }],
    },
    orderBy: [{ closedAt: { sort: "desc", nulls: "first" } }, { openedAt: "asc" }],
    take: 50,
    select: {
      id: true,
      companyId: true,
      connectionId: true,
      openedAt: true,
      closedAt: true,
      company: { select: { name: true } },
      connection: { select: { name: true, type: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          direction: true,
          kind: true,
          orderId: true,
          recipients: true,
          subject: true,
          body: true,
          orderNumbers: true,
          createdAt: true,
        },
      },
      orders: {
        orderBy: { since: "asc" },
        select: {
          id: true,
          since: true,
          resolvedAt: true,
          outcome: true,
          warehouseConfirmedAt: true,
          customerEmailedAt: true,
          fulfillment: {
            select: {
              id: true,
              externalId: true,
              rawStatus: true,
              status: true,
              trackingNumbers: true,
              outboundRequests: {
                where: { operation: { in: [...CANCEL_OPERATIONS] }, status: { in: [...CANCEL_IN_FLIGHT] } },
                select: { id: true },
                take: 1,
              },
              reroutesFrom: {
                where: { status: { in: ["CANCEL_QUEUED", "UNCERTAIN"] } },
                select: { id: true },
                take: 1,
              },
              lines: {
                select: {
                  quantity: true,
                  orderLine: { select: { productId: true, sku: true, title: true } },
                },
              },
            },
          },
          order: {
            select: {
              id: true,
              number: true,
              companyId: true,
              customerName: true,
              email: true,
              store: { select: { name: true } },
              lines: { select: { productId: true, sku: true, title: true, quantity: true } },
            },
          },
        },
      },
    },
  });
  const productIds = [
    ...new Set(
      cases.flatMap((c) =>
        c.orders.flatMap((o) => o.order.lines.map((l) => l.productId).filter((p): p is string => !!p)),
      ),
    ),
  ];
  const [levels, holds] = await Promise.all([
    productIds.length
      ? db.vendorProduct.findMany({
          where: {
            productId: { in: productIds },
            connectionId: { in: [...new Set(cases.map((c) => c.connectionId))] },
            archived: false,
          },
          select: {
            connectionId: true,
            productId: true,
            stockLevel: { select: { physical: true, free: true, snapshotAt: true } },
          },
        })
      : [],
    skuHolds(actor.accountId, productIds),
  ]);
  return cases.map((c) => {
    const s = settings.get(c.companyId) ?? defaultsFor(c.companyId);
    const stale = staleHoursFor(stock, c.connection.type);
    const zero = (productId: string | null) => {
      if (!productId) return false;
      const lv = levels.filter(
        (v) => v.connectionId === c.connectionId && v.productId === productId && v.stockLevel,
      );
      return (
        lv.length > 0 &&
        lv.every(
          (v) =>
            !isStale(v.stockLevel!.snapshotAt, stale, now) &&
            v.stockLevel!.physical <= 0 &&
            v.stockLevel!.free <= 0,
        )
      );
    };
    const orders = c.orders.map((o) => {
      const items = (
        o.fulfillment.lines.length
          ? o.fulfillment.lines.map((l) => ({ ...l.orderLine, quantity: l.quantity }))
          : o.order.lines
      ).map((l) => ({ productId: l.productId, sku: l.sku, title: l.title, quantity: l.quantity }));
      const hours = Math.floor(elapsedMs(o.since, o.resolvedAt ?? now, s.workDaysOnly) / HOUR);
      return {
        id: o.id,
        orderId: o.order.id,
        number: o.order.number,
        ref: o.fulfillment.externalId,
        awb: o.fulfillment.trackingNumbers[0] ?? null,
        rawStatus: o.fulfillment.rawStatus,
        since: o.since,
        hours,
        level: o.resolvedAt ? null : levelOf(hours, s),
        resolvedAt: o.resolvedAt,
        outcome: o.outcome,
        warehouseConfirmedAt: o.warehouseConfirmedAt,
        customerEmailedAt: o.customerEmailedAt,
        cancelInFlight: o.fulfillment.outboundRequests.length > 0 || o.fulfillment.reroutesFrom.length > 0,
        deleteUntil: euDeleteUntil(c.connection.type, o.fulfillment.rawStatus, o.since),
        items,
        zeroStock: items.filter((i) => zero(i.productId)).map((i) => i.sku ?? i.title),
        holds: items
          .map((i) => (i.productId ? holds.get(holdKey(c.connectionId, i.productId)) : undefined))
          .filter((h): h is NonNullable<typeof h> => !!h),
        // A customer's name and email only for who reviews orders of that order's company (an order of another
        // company can ship from this company's warehouse account).
        customer:
          canSeeCustomers && (!actor.companyScope || actor.companyScope.includes(o.order.companyId ?? ""))
            ? {
                name: o.order.customerName,
                email: o.order.email,
                store: o.order.store?.name ?? c.company.name,
              }
            : null,
      };
    });
    const open = orders.filter((o) => !o.resolvedAt);
    const oldestHours = Math.max(0, ...open.map((o) => o.hours));
    const level = levelOf(oldestHours, s);
    const out = c.messages.filter((m) => m.direction === "OUT" && m.kind.startsWith("warehouse_"));
    const lastSent = out.at(-1) ?? null;
    const lastSentLevel = Math.max(0, ...out.map((m) => Number(m.kind.slice("warehouse_".length)) || 0));
    const repliedSinceLast =
      !!lastSent && c.messages.some((m) => m.direction === "IN" && m.createdAt > lastSent.createdAt);
    const caseLines: CaseLine[] = open.map((o) => ({
      ref: o.ref,
      orderNumber: o.number,
      awb: o.awb,
      status: o.rawStatus,
      since: o.since,
      hours: o.hours,
      items: o.items,
      zeroStock: o.zeroStock,
    }));
    const emails = Object.fromEntries(
      WAREHOUSE_LEVELS.map((lvl) => [
        lvl,
        warehouseEmail({
          level: lvl,
          company: c.company.name,
          warehouse: c.connection.name,
          lines: caseLines,
          to: s.warehouseTo,
          cc: s.warehouseCc,
          escalationTo: s.escalationTo,
          lastSentAt: lastSent?.createdAt ?? null,
          repliedSinceLast,
          now,
        }),
      ]),
    ) as Record<WarehouseLevel, Email>;
    return {
      id: c.id,
      companyId: c.companyId,
      companyName: c.company.name,
      connectionId: c.connectionId,
      connectionName: c.connection.name,
      connectionType: c.connection.type,
      openedAt: c.openedAt,
      closedAt: c.closedAt,
      settings: s,
      configured: s.warehouseTo.length > 0,
      oldestHours,
      level,
      lastSentLevel,
      lastSentAt: lastSent?.createdAt ?? null,
      repliedSinceLast,
      suggested: c.closedAt ? null : suggestedLevel(level, lastSentLevel),
      emails,
      // A customer email is shown only to who may see that order's customer; never its address otherwise.
      messages: c.messages.map((m) =>
        m.kind === "customer" && !orders.some((o) => o.orderId === m.orderId && o.customer)
          ? { ...m, recipients: [], body: "", subject: `Customer email (${m.orderNumbers[0] ?? ""})` }
          : m,
      ),
      orders,
      /** The customer email of each shipment not shipped, filled on the screen as the discount code is typed. */
      customerInputs: Object.fromEntries(
        orders
          .filter((o) => o.outcome !== "shipped")
          .flatMap((o) => (o.customer ? [{ ...o, customer: o.customer }] : []))
          .map((o) => [
            o.id,
            {
              subject: s.customerSubject,
              body: s.customerBody,
              to: o.customer.email,
              customerName: o.customer.name,
              orderNumber: o.number,
              items: o.items.map((i) => ({ title: i.title, quantity: i.quantity })),
              store: o.customer.store,
              discountPercent: s.discountPercent,
              discountCode: null,
            } satisfies CustomerEmailInput,
          ]),
      ) as Record<string, CustomerEmailInput>,
    };
  });
}

export type WarehouseCaseView = Awaited<ReturnType<typeof warehouseCasesView>>[number];

/** The open case shipments of one order (the order page's block). */
export async function orderCaseInfo(accountId: string, orderId: string, now: Date = new Date()) {
  const db = accountDb(accountId);
  const rows = await db.warehouseCaseOrder.findMany({
    where: { orderId, resolvedAt: null, case: { closedAt: null } },
    select: {
      since: true,
      warehouseConfirmedAt: true,
      customerEmailedAt: true,
      fulfillment: { select: { rawStatus: true } },
      case: { select: { id: true, companyId: true, connection: { select: { name: true, type: true } } } },
    },
  });
  if (!rows.length) return [];
  const settings = await escalationSettingsByCompany(accountId);
  return rows.map((r) => {
    const s = settings.get(r.case.companyId) ?? defaultsFor(r.case.companyId);
    const hours = Math.floor(elapsedMs(r.since, now, s.workDaysOnly) / HOUR);
    return {
      caseId: r.case.id,
      connectionName: r.case.connection.name,
      hours,
      level: levelOf(hours, s),
      warehouseConfirmedAt: r.warehouseConfirmedAt,
      customerEmailedAt: r.customerEmailedAt,
      deleteUntil: euDeleteUntil(r.case.connection.type, r.fulfillment.rawStatus, r.since),
    };
  });
}

/** A case the actor may act on: in their companies and still open (a closed case is history). */
async function loadCase(actor: ScopedActor, caseId: string, opts: { allowClosed?: boolean } = {}) {
  const c = await accountDb(actor.accountId).warehouseCase.findFirst({
    where: { id: caseId },
    select: { id: true, companyId: true, connectionId: true, closedAt: true },
  });
  if (!c || (actor.companyScope && !actor.companyScope.includes(c.companyId)))
    throw new DomainError("not_found");
  if (c.closedAt && !opts.allowClosed) throw new DomainError("case_closed");
  return c;
}

const emails = z.array(z.string().trim().max(200)).max(40);
export const SentInput = z.object({
  caseId: z.string().min(1).max(64),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  recipients: emails,
  subject: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(20_000),
  orderNumbers: z.array(z.string().max(64)).max(500),
});

/** A person sent a warehouse email from the company's Gmail: recorded (the next step is offered from it). */
export async function markWarehouseEmailSent(
  actor: ScopedActor,
  raw: z.input<typeof SentInput>,
  now: Date = new Date(),
) {
  assertCan(actor.role, "orders.review");
  const v = SentInput.parse(raw);
  await loadCase(actor, v.caseId);
  const settings = await escalationSettingsByCompany(actor.accountId);
  // Recorded and the task settled in one step, under the case lock (the sweep may be closing the case meanwhile).
  await withCaseLock(actor.accountId, async (tx) => {
    const open = await tx.warehouseCase.count({
      where: { id: v.caseId, accountId: actor.accountId, closedAt: null },
    });
    if (!open) throw new DomainError("case_closed");
    await tx.warehouseCaseMessage.create({
      data: {
        accountId: actor.accountId,
        caseId: v.caseId,
        direction: "OUT",
        kind: `warehouse_${v.level}`,
        recipients: v.recipients,
        subject: v.subject,
        body: v.body,
        orderNumbers: v.orderNumbers,
        createdById: actor.userId,
        createdAt: now,
      },
    });
    await syncCaseTasks(tx, actor.accountId, settings, now);
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "warehouse_case.email_sent",
    entityType: "WarehouseCase",
    entityId: v.caseId,
    after: { level: v.level, orders: v.orderNumbers.length },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

export const ReplyInput = z.object({
  caseId: z.string().min(1).max(64),
  body: z.string().trim().min(2).max(20_000),
  /** Case shipments the warehouse wrote it has the goods for ("we have it, it will ship"). */
  confirmedCaseOrderIds: z.array(z.string().min(1).max(64)).max(500).default([]),
});

/**
 * The warehouse's reply, pasted in. For the shipments it says it has the goods for (owner: "имаме го, ще тръгне",
 * no courier status needed), the products held at that warehouse are unlocked.
 */
export async function addWarehouseReply(actor: ScopedActor, raw: z.input<typeof ReplyInput>) {
  assertCan(actor.role, "orders.review");
  const v = ReplyInput.parse(raw);
  const c = await loadCase(actor, v.caseId);
  const now = new Date();
  const unlocked = await withAccountTransaction(actor.accountId, async (tx) => {
    const confirmed = v.confirmedCaseOrderIds.length
      ? await tx.warehouseCaseOrder.findMany({
          // Only shipments still waiting in this case: a settled one (e.g. cancelled for no stock) proves nothing.
          where: { id: { in: v.confirmedCaseOrderIds }, caseId: c.id, resolvedAt: null },
          select: {
            id: true,
            order: { select: { number: true, lines: { select: { productId: true } } } },
            fulfillment: { select: { lines: { select: { orderLine: { select: { productId: true } } } } } },
          },
        })
      : [];
    if (confirmed.length !== v.confirmedCaseOrderIds.length) throw new DomainError("not_found");
    await tx.warehouseCaseMessage.create({
      data: {
        accountId: actor.accountId,
        caseId: c.id,
        direction: "IN",
        kind: "reply",
        recipients: [],
        subject: "Reply",
        body: v.body,
        orderNumbers: confirmed.map((o) => o.order.number),
        createdById: actor.userId,
      },
    });
    if (!confirmed.length) return 0;
    await tx.warehouseCaseOrder.updateMany({
      where: { id: { in: confirmed.map((o) => o.id) }, warehouseConfirmedAt: null },
      data: { warehouseConfirmedAt: now },
    });
    const products = [
      ...new Set(
        confirmed.flatMap((o) =>
          (o.fulfillment.lines.length
            ? o.fulfillment.lines.map((l) => l.orderLine.productId)
            : o.order.lines.map((l) => l.productId)
          ).filter((p): p is string => !!p),
        ),
      ),
    ];
    const r = await tx.skuIncident.updateMany({
      where: { connectionId: c.connectionId, productId: { in: products }, clearedAt: null },
      data: {
        clearedAt: now,
        clearedById: actor.userId,
        clearNote:
          `warehouse wrote it has the goods (${confirmed.map((o) => o.order.number).join(", ")})`.slice(
            0,
            500,
          ),
      },
    });
    return r.count;
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "warehouse_case.reply",
    entityType: "WarehouseCase",
    entityId: c.id,
    after: { confirmed: v.confirmedCaseOrderIds.length, unlocked },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { unlocked };
}

export const CustomerSentInput = z.object({
  caseOrderId: z.string().min(1).max(64),
  recipients: emails,
  subject: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(20_000),
});

/** A person wrote to the customer of a stuck order (from the company's Gmail): recorded on the case. */
export async function markCustomerEmailed(actor: ScopedActor, raw: z.input<typeof CustomerSentInput>) {
  assertCan(actor.role, "orders.review");
  const v = CustomerSentInput.parse(raw);
  const db = accountDb(actor.accountId);
  const o = await db.warehouseCaseOrder.findFirst({
    where: { id: v.caseOrderId },
    select: { id: true, caseId: true, orderId: true, order: { select: { number: true, companyId: true } } },
  });
  // Only the customer of an order of the actor's companies.
  if (!o || (actor.companyScope && !actor.companyScope.includes(o.order.companyId ?? "")))
    throw new DomainError("not_found");
  // The customer of a cancelled order is written to after the case closed, too.
  await loadCase(actor, o.caseId, { allowClosed: true });
  await db.warehouseCaseMessage.create({
    data: {
      accountId: actor.accountId,
      caseId: o.caseId,
      direction: "OUT",
      kind: "customer",
      orderId: o.orderId,
      recipients: v.recipients,
      subject: v.subject,
      body: v.body,
      orderNumbers: [o.order.number],
      createdById: actor.userId,
    },
  });
  await db.warehouseCaseOrder.updateMany({ where: { id: o.id }, data: { customerEmailedAt: new Date() } });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "warehouse_case.customer_emailed",
    entityType: "Order",
    entityId: o.orderId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}
