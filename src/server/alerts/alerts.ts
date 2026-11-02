import { z } from "zod";
import type { AlertSeverity, CrmOrderStatus } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import type { CompanyScope } from "@/server/companies";
import { accountDb, systemDb, withAccountTransaction } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";

type Env = Record<string, string | undefined>;

/**
 * Alerts and tasks (P4-08): ONE list of everything open — blocked / unknown / stuck orders, submit failures,
 * UNCERTAIN sends, Shopify changes or cancellations after approval, import failures — with assign and
 * resolve-with-note. Alerts are written by many modules (outbox, vendors, Shopify import); this module only
 * reads them, adds the history (AlertNote) and raises the order-state alerts the others do not (sweep).
 */

export const ALERT_CATEGORIES = [
  "uncertain",
  "blocked",
  "unknown",
  "stuck",
  "submit_failed",
  "shopify_changed",
  "import_failed",
  "other",
] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

/** Category of an alert kind (kinds come from many modules; matched by their naming). */
export function categoryOf(kind: string): AlertCategory {
  if (/uncertain/.test(kind)) return "uncertain";
  if (/stuck/.test(kind)) return "stuck";
  if (/unknown/.test(kind)) return "unknown";
  if (/import_failed/.test(kind)) return "import_failed";
  if (/after_approval|cod_nothing_outstanding/.test(kind)) return "shopify_changed";
  if (/submit_failed|rejected|writeback_failed/.test(kind)) return "submit_failed";
  if (/blocked/.test(kind)) return "blocked";
  return "other";
}

type Ctx = ScopedActor & { activeCompanyId?: string | null; lineCompanyIds?: string[] | null };

interface ListFilter {
  category?: AlertCategory;
  mine?: boolean;
}

/** Company of each alert's entity (null = not company-bound, e.g. an API spec change). */
async function companiesOf(
  accountId: string,
  alerts: { entityType: string | null; entityId: string | null }[],
) {
  const db = accountDb(accountId);
  const ids = (t: string) => [
    ...new Set(alerts.filter((a) => a.entityType === t && a.entityId).map((a) => a.entityId!)),
  ];
  const [orders, fulfillments, requests, stores, connections] = await Promise.all([
    db.order.findMany({
      where: { id: { in: ids("Order") } },
      select: { id: true, companyId: true, number: true },
    }),
    db.fulfillment.findMany({
      where: { id: { in: ids("Fulfillment") } },
      select: { id: true, orderId: true, order: { select: { companyId: true, number: true } } },
    }),
    db.outboundRequest.findMany({
      where: { id: { in: ids("OutboundRequest") } },
      select: {
        id: true,
        connection: { select: { companyId: true } },
        fulfillment: { select: { orderId: true, order: { select: { companyId: true, number: true } } } },
      },
    }),
    db.store.findMany({ where: { id: { in: ids("Store") } }, select: { id: true, companyId: true } }),
    db.fulfillmentConnection.findMany({
      where: { id: { in: ids("FulfillmentConnection") } },
      select: { id: true, companyId: true },
    }),
  ]);
  const out = new Map<string, { companyId: string | null; orderId?: string; orderNumber?: string }>();
  for (const o of orders)
    out.set(`Order:${o.id}`, { companyId: o.companyId, orderId: o.id, orderNumber: o.number });
  for (const f of fulfillments)
    out.set(`Fulfillment:${f.id}`, {
      companyId: f.order.companyId,
      orderId: f.orderId,
      orderNumber: f.order.number,
    });
  for (const r of requests)
    out.set(`OutboundRequest:${r.id}`, {
      companyId: r.fulfillment?.order.companyId ?? r.connection.companyId,
      orderId: r.fulfillment?.orderId,
      orderNumber: r.fulfillment?.order.number,
    });
  for (const s of stores) out.set(`Store:${s.id}`, { companyId: s.companyId });
  for (const c of connections) out.set(`FulfillmentConnection:${c.id}`, { companyId: c.companyId });
  return out;
}

/** Restricted members see alerts of their companies only; the sidebar company filter narrows further. */
function visible(
  company: string | null | undefined,
  scope: CompanyScope,
  active: string | null | undefined,
  lineCompanyIds?: string[] | null,
) {
  if (active) return company === active;
  // Sidebar product line (P5-00): alerts of that line's companies; group-level alerts (no company) as before.
  if (lineCompanyIds) return company ? lineCompanyIds.includes(company) : !scope;
  if (!scope) return true;
  return !!company && scope.includes(company);
}

const OPEN = { status: { not: "RESOLVED" as const } };

async function openAlertsInScope(ctx: Ctx) {
  const alerts = await accountDb(ctx.accountId).alert.findMany({
    where: OPEN,
    orderBy: [{ createdAt: "desc" }],
    take: 1000,
  });
  const entities = await companiesOf(ctx.accountId, alerts);
  return alerts
    .map((a) => {
      const e = a.entityType && a.entityId ? entities.get(`${a.entityType}:${a.entityId}`) : undefined;
      return {
        ...a,
        category: categoryOf(a.kind),
        companyId: e?.companyId ?? null,
        order: e?.orderId ? { id: e.orderId, number: e.orderNumber! } : null,
      };
    })
    .filter((a) => visible(a.companyId, ctx.companyScope ?? null, ctx.activeCompanyId, ctx.lineCompanyIds));
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

export async function listOpenAlerts(ctx: Ctx, f: ListFilter = {}) {
  assertCan(ctx.role, "account.read");
  const all = await openAlertsInScope(ctx);
  const rows = all
    .filter((a) => (!f.category || a.category === f.category) && (!f.mine || a.assigneeId === ctx.userId))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || +b.createdAt - +a.createdAt);
  const assigneeIds = [...new Set(rows.map((r) => r.assigneeId).filter((x): x is string => !!x))];
  const users = assigneeIds.length
    ? await systemDb().user.findMany({ where: { id: { in: assigneeIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({ ...r, assigneeName: r.assigneeId ? (nameOf.get(r.assigneeId) ?? null) : null }));
}

/** Counts for Начало and the list's chips. */
export async function alertCounts(ctx: Ctx) {
  assertCan(ctx.role, "account.read");
  const all = await openAlertsInScope(ctx);
  const byCategory = Object.fromEntries(ALERT_CATEGORIES.map((c) => [c, 0])) as Record<AlertCategory, number>;
  for (const a of all) byCategory[a.category]++;
  return {
    total: all.length,
    tasks: all.filter((a) => a.isTask).length,
    critical: all.filter((a) => a.severity === "CRITICAL").length,
    mine: all.filter((a) => a.assigneeId === ctx.userId).length,
    byCategory,
  };
}

async function loadInScope(ctx: Ctx, alertId: string) {
  const alert = await accountDb(ctx.accountId).alert.findUnique({ where: { id: alertId } });
  if (!alert) throw new DomainError("not_found");
  const e = (await companiesOf(ctx.accountId, [alert])).get(`${alert.entityType}:${alert.entityId}`);
  if (!visible(e?.companyId ?? null, ctx.companyScope ?? null, null)) throw new DomainError("not_found");
  return alert;
}

export async function alertHistory(ctx: Ctx, alertId: string) {
  assertCan(ctx.role, "account.read");
  await loadInScope(ctx, alertId);
  return accountDb(ctx.accountId).alertNote.findMany({ where: { alertId }, orderBy: { createdAt: "asc" } });
}

/** Assign to a member of this account (null = unassign). */
export async function assignAlert(ctx: Ctx, alertId: string, assigneeId: string | null) {
  assertCan(ctx.role, "alerts.manage");
  const alert = await loadInScope(ctx, alertId);
  if (alert.status === "RESOLVED") throw new DomainError("alert_resolved");
  if (assigneeId) {
    const member = await accountDb(ctx.accountId).membership.findFirst({ where: { userId: assigneeId } });
    if (!member) throw new DomainError("not_a_member");
  }
  await withAccountTransaction(ctx.accountId, async (tx) => {
    await tx.alert.update({
      where: { id: alertId },
      data: { assigneeId, status: assigneeId ? "ACKNOWLEDGED" : "OPEN" },
    });
    await tx.alertNote.create({
      data: { accountId: ctx.accountId, alertId, userId: ctx.userId, action: "assign", note: assigneeId },
    });
  });
  await recordAudit({
    accountId: ctx.accountId,
    userId: ctx.userId,
    action: "alert.assign",
    entityType: "Alert",
    entityId: alertId,
    before: { assigneeId: alert.assigneeId },
    after: { assigneeId },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

export const ResolveNote = z.string().trim().min(2).max(2000);

/** Resolve with a note (required: what was done). Conditional, so two people cannot both resolve it. */
export async function resolveAlert(ctx: Ctx, alertId: string, rawNote: string) {
  assertCan(ctx.role, "alerts.manage");
  const note = ResolveNote.parse(rawNote);
  await loadInScope(ctx, alertId);
  await withAccountTransaction(ctx.accountId, async (tx) => {
    const res = await tx.alert.updateMany({
      where: { id: alertId, status: { not: "RESOLVED" } },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    if (res.count !== 1) throw new DomainError("alert_resolved");
    await tx.alertNote.create({
      data: { accountId: ctx.accountId, alertId, userId: ctx.userId, action: "resolve", note },
    });
  });
  await recordAudit({
    accountId: ctx.accountId,
    userId: ctx.userId,
    action: "alert.resolve",
    entityType: "Alert",
    entityId: alertId,
    after: { note },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

// ───────────────────────── sweep: order-state alerts ─────────────────────────

/** Order states that get an alert of their own while the order sits in them. */
const STATE_ALERTS: Partial<
  Record<CrmOrderStatus, { kind: string; severity: AlertSeverity; title: string }>
> = {
  BLOCKED: { kind: "order_blocked", severity: "CRITICAL", title: "Order blocked at the warehouse" },
  UNKNOWN: { kind: "order_unknown", severity: "CRITICAL", title: "Order status unknown" },
  SUBMIT_FAILED: {
    kind: "order_submit_failed",
    severity: "WARNING",
    title: "Sending to the warehouse failed",
  },
};

/** Default hours an order may stay in a status before it is "stuck" (override: env ALERT_STUCK_HOURS JSON). */
export const DEFAULT_STUCK_HOURS: Partial<Record<CrmOrderStatus, number>> = {
  CHECKING: 1,
  APPROVED: 24,
  QUEUED: 4,
  SUBMITTING: 1,
  ACCEPTED: 48,
  PROCESSING: 72,
  SHIPPED: 240,
};

export function stuckHours(env: Env = process.env): Partial<Record<CrmOrderStatus, number>> {
  if (!env.ALERT_STUCK_HOURS) return DEFAULT_STUCK_HOURS;
  const parsed = z.record(z.string(), z.number().positive()).safeParse(
    (() => {
      try {
        return JSON.parse(env.ALERT_STUCK_HOURS!);
      } catch {
        return null;
      }
    })(),
  );
  return parsed.success ? { ...DEFAULT_STUCK_HOURS, ...parsed.data } : DEFAULT_STUCK_HOURS;
}

const SWEEP_KINDS = ["order_blocked", "order_unknown", "order_submit_failed", "order_stuck"];

/**
 * Raises one alert per order in BLOCKED / UNKNOWN / SUBMIT_FAILED and per order stuck in a status longer than
 * its threshold (never a second while one is open), and resolves those alerts by itself once the order has
 * moved on (with an auto_resolve note). Runs across accounts (worker).
 */
/**
 * An alert of this kind for this order was resolved after the order last entered its current status. Without
 * an OrderEvent into that status (e.g. imported straight into it), any earlier resolution counts.
 */
async function resolvedSinceEntered(
  o: { id: string; accountId: string; status: CrmOrderStatus },
  kind: string,
  body: string,
) {
  const db = systemDb();
  const entered = await db.orderEvent.findFirst({
    where: { accountId: o.accountId, orderId: o.id, toStatus: o.status },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const resolved = await db.alert.findFirst({
    where: {
      accountId: o.accountId,
      kind,
      entityType: "Order",
      entityId: o.id,
      status: "RESOLVED",
      body,
      ...(entered ? { resolvedAt: { gte: entered.createdAt } } : {}),
    },
    select: { id: true },
  });
  return !!resolved;
}

export async function sweepOrderAlerts(now: Date = new Date(), hours = stuckHours(), take = 500) {
  const db = systemDb();
  let created = 0;
  let resolved = 0;
  const open = await db.alert.findMany({
    where: { kind: { in: SWEEP_KINDS }, entityType: "Order", ...OPEN },
    select: { id: true, accountId: true, kind: true, entityId: true, body: true },
  });
  const openKey = new Set(open.map((a) => `${a.kind}:${a.entityId}`));
  const raise = async (
    o: { id: string; accountId: string; number: string; status: CrmOrderStatus },
    kind: string,
    severity: AlertSeverity,
    title: string,
    body: string,
  ) => {
    if (openKey.has(`${kind}:${o.id}`)) return;
    openKey.add(`${kind}:${o.id}`);
    // Someone resolved this alert (with a note) while the order stayed where it is: do not raise it again
    // (and notify again) until the order has left that status and come back.
    if (await resolvedSinceEntered(o, kind, body)) return;
    await db.alert.create({
      data: {
        accountId: o.accountId,
        kind,
        isTask: true,
        severity,
        title: `${title}: ${o.number}`,
        body,
        entityType: "Order",
        entityId: o.id,
      },
    });
    created++;
  };

  for (const [status, def] of Object.entries(STATE_ALERTS) as [
    CrmOrderStatus,
    NonNullable<(typeof STATE_ALERTS)[CrmOrderStatus]>,
  ][]) {
    const orders = await db.order.findMany({
      where: { status },
      select: { id: true, accountId: true, number: true, status: true },
      take,
    });
    for (const o of orders) await raise(o, def.kind, def.severity, def.title, `status=${status}`);
  }

  for (const [status, h] of Object.entries(hours) as [CrmOrderStatus, number][]) {
    const cutoff = new Date(now.getTime() - h * 3600_000);
    const candidates = await db.order.findMany({
      where: { status, updatedAt: { lt: cutoff } },
      select: { id: true, accountId: true, number: true, status: true },
      take,
    });
    for (const o of candidates) {
      const since = await db.orderEvent.findFirst({
        where: { orderId: o.id, toStatus: status },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (since && since.createdAt >= cutoff) continue;
      await raise(
        o,
        "order_stuck",
        "WARNING",
        `Order stuck in ${status} for over ${h} h`,
        `status=${status}`,
      );
    }
  }

  // Auto-resolve the sweep's own alerts once their order has left the state.
  if (open.length) {
    const orders = await db.order.findMany({
      where: { id: { in: open.map((a) => a.entityId!).filter(Boolean) } },
      select: { id: true, status: true },
    });
    const statusOf = new Map(orders.map((o) => [o.id, o.status]));
    for (const a of open) {
      const current = statusOf.get(a.entityId!);
      const wanted = a.body?.replace(/^status=/, "") ?? null;
      const still =
        a.kind === "order_stuck"
          ? current === wanted
          : current !== undefined && STATE_ALERTS[current]?.kind === a.kind;
      if (still) continue;
      const res = await db.alert.updateMany({
        where: { id: a.id, status: { not: "RESOLVED" } },
        data: { status: "RESOLVED", resolvedAt: now },
      });
      if (res.count === 1) {
        await db.alertNote.create({
          data: {
            accountId: a.accountId,
            alertId: a.id,
            action: "auto_resolve",
            note: `order now ${current ?? "gone"}`,
          },
        });
        resolved++;
      }
    }
  }
  return { created, resolved };
}
