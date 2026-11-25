import { z } from "zod";
import type { AlertSeverity, CrmOrderStatus, Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import type { CompanyScope } from "@/server/companies";
import { accountDb, systemDb, withAccountTransaction } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import { deliveredByCarrier } from "@/server/fhb/courier";

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
  const [orders, fulfillments, requests, stores, connections, stockEntities] = await Promise.all([
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
    stockAlertCompanies(accountId, ids),
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
  for (const [k, companyId] of stockEntities) out.set(k, { companyId });
  return out;
}

/** Stock track (P5-01/P5-02): company of stock and inbound alert entities (variant → store, vendor product /
 * inbound → warehouse connection). */
async function stockAlertCompanies(accountId: string, ids: (t: string) => string[]) {
  const db = accountDb(accountId);
  const [links, vps, inbounds] = await Promise.all([
    db.storeVariantLink.findMany({
      where: { id: { in: ids("StoreVariantLink") } },
      select: { id: true, store: { select: { companyId: true } } },
    }),
    db.vendorProduct.findMany({
      where: { id: { in: ids("VendorProduct") } },
      select: { id: true, connection: { select: { companyId: true } } },
    }),
    db.inboundShipment.findMany({
      where: { id: { in: ids("InboundShipment") } },
      select: { id: true, connection: { select: { companyId: true } } },
    }),
  ]);
  return new Map<string, string | null>([
    ...links.map((l) => [`StoreVariantLink:${l.id}`, l.store.companyId] as const),
    ...vps.map((v) => [`VendorProduct:${v.id}`, v.connection.companyId] as const),
    ...inbounds.map((i) => [`InboundShipment:${i.id}`, i.connection.companyId] as const),
  ]);
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
 * A shipped parcel is not "stuck" while the carrier keeps reporting it (owner 2026-11-23: 130+ shipped orders in
 * "С грешки" hid the real problems — most were moving, at a pick-up point, or on their way back). Only a parcel the
 * carrier has said nothing about for this long is a task.
 */
export const SHIPPED_QUIET_DAYS = 5;
/** Orders looked at per status and sweep at most. */
const STUCK_SCAN_MAX = 20_000;
/** News of the parcel: euShipments statuses, FHB statuses and carrier events, FHB Joy label tracking. */
const CARRIER_OR_WAREHOUSE = {
  OR: [
    { source: "eushipments" },
    // FHB's statuses and carrier events — not the CRM's own writes to FHB (fhb:fhb.order.create …).
    { AND: [{ source: { startsWith: "fhb:" } }, { NOT: { source: { startsWith: "fhb:fhb." } } }] },
    { source: { in: ["joy", "joy.status"] } },
  ],
} satisfies Prisma.FulfillmentEventWhereInput;

/** The orders (of these) whose live shipment had a carrier / warehouse event in the quiet window — one read. */
async function movedRecently(orderIds: string[], now: Date) {
  const out = new Set<string>();
  // In chunks (a long id list stays under PostgreSQL's bind-parameter limit).
  for (let i = 0; i < orderIds.length; i += 1000)
    for (const id of await movedRecentlyChunk(orderIds.slice(i, i + 1000), now)) out.add(id);
  return out;
}

async function movedRecentlyChunk(orderIds: string[], now: Date) {
  if (!orderIds.length) return new Set<string>();
  const rows = await systemDb().fulfillmentEvent.findMany({
    where: {
      ...CARRIER_OR_WAREHOUSE,
      occurredAt: {
        gte: new Date(now.getTime() - SHIPPED_QUIET_DAYS * 86_400_000),
        lte: new Date(now.getTime() + 3_600_000),
      },
      fulfillment: { orderId: { in: orderIds }, status: { notIn: ["CANCELLED", "SUBMIT_FAILED"] } },
    },
    select: { fulfillment: { select: { orderId: true } } },
    distinct: ["fulfillmentId"],
  });
  return new Set(rows.map((r) => r.fulfillment.orderId));
}

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
      // Closed by a person — not by the sweep itself (e.g. a parcel that moved again and later went quiet).
      notes: { none: { action: "auto_resolve" } },
    },
    select: { id: true },
  });
  return !!resolved;
}

export async function sweepOrderAlerts(
  now: Date = new Date(),
  hours = stuckHours(),
  take = 500,
  /** One account only (tests: the shared test database holds every other test's orders). */
  scope: { accountId?: string } = {},
) {
  const db = systemDb();
  const inScope = scope.accountId ? { accountId: scope.accountId } : {};
  let created = 0;
  let resolved = 0;
  const open = await db.alert.findMany({
    where: { kind: { in: SWEEP_KINDS }, entityType: "Order", ...OPEN, ...inScope },
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
      where: { status, ...inScope },
      select: { id: true, accountId: true, number: true, status: true },
      take,
    });
    for (const o of orders) await raise(o, def.kind, def.severity, def.title, `status=${status}`);
  }

  for (const [status, h] of Object.entries(hours) as [CrmOrderStatus, number][]) {
    const cutoff = new Date(now.getTime() - h * 3600_000);
    // Every candidate, oldest first, page by page (moving parcels never use up the page of the quiet ones).
    const candidates: { id: string; accountId: string; number: string; status: CrmOrderStatus }[] = [];
    for (let cursor: string | undefined; candidates.length < STUCK_SCAN_MAX;) {
      const page = await db.order.findMany({
        where: { status, updatedAt: { lt: cutoff }, ...inScope, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true, accountId: true, number: true, status: true },
        orderBy: { id: "asc" },
        take,
      });
      candidates.push(...page);
      if (page.length < take) break;
      cursor = page.at(-1)!.id;
    }
    // Moving (news in the quiet window), or handed to the recipient by the carrier while the warehouse still says
    // "sent" (owner 2026-11-24): not stuck.
    const moving =
      status === "SHIPPED"
        ? new Set([
            ...(await movedRecently(
              candidates.map((c) => c.id),
              now,
            )),
            ...(await deliveredByCarrier(
              db,
              candidates.map((c) => c.id),
            )),
          ])
        : new Set<string>();
    for (const o of candidates) {
      if (moving.has(o.id)) continue;
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
        status === "SHIPPED"
          ? `Изпратена преди над ${Math.round(h / 24)} дни, без вест от куриера ${SHIPPED_QUIET_DAYS} дни — проверете проследяването`
          : `Order stuck in ${status} for over ${h} h`,
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
    const shippedStuck = open
      .filter((a) => a.kind === "order_stuck" && statusOf.get(a.entityId!) === "SHIPPED")
      .map((a) => a.entityId!);
    const movingNow = new Set([
      ...(await movedRecently(shippedStuck, now)),
      ...(await deliveredByCarrier(db, shippedStuck)),
    ]);
    for (const a of open) {
      const current = statusOf.get(a.entityId!);
      const wanted = a.body?.replace(/^status=/, "") ?? null;
      let still =
        a.kind === "order_stuck"
          ? current === wanted
          : current !== undefined && STATE_ALERTS[current]?.kind === a.kind;
      // A shipped parcel the carrier reports again is moving: not stuck any more.
      const moving = still && a.kind === "order_stuck" && current === "SHIPPED" && movingNow.has(a.entityId!);
      if (moving) still = false;
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
            note: moving
              ? "the carrier reported the parcel moving, or delivered to the recipient"
              : `order now ${current ?? "gone"}`,
          },
        });
        resolved++;
      }
    }
  }
  resolved += await resolveClosedInShopify(now);
  return { created, resolved };
}

/** Task "blocked in the CRM but still open in Shopify" (review/service.ts BLOCKED_TASK_KIND). */
const OPEN_IN_SHOPIFY_TASK = "blocked_in_crm_open_in_shopify";
/** Shopify financial states that mean the shop side was handled (no money left to take or give back). */
export const SHOPIFY_CLOSED_FINANCIAL = ["VOIDED", "REFUNDED"];

/**
 * "Blocked in the CRM but still open in Shopify — cancel or refund it in the shop": done once Shopify shows the order
 * cancelled, voided or refunded (owner report 2026-11-18: such orders stayed under "С грешки" for good).
 */
async function resolveClosedInShopify(now: Date) {
  const db = systemDb();
  const open = await db.alert.findMany({
    where: { kind: OPEN_IN_SHOPIFY_TASK, entityType: "Order", ...OPEN },
    select: { id: true, accountId: true, entityId: true },
    take: 1000,
  });
  if (!open.length) return 0;
  const closed = new Set(
    (
      await db.order.findMany({
        where: {
          id: { in: open.map((a) => a.entityId!).filter(Boolean) },
          OR: [{ cancelledAt: { not: null } }, { shopifyFinancialStatus: { in: SHOPIFY_CLOSED_FINANCIAL } }],
        },
        select: { id: true },
      })
    ).map((o) => o.id),
  );
  let resolved = 0;
  for (const a of open) {
    if (!a.entityId || !closed.has(a.entityId)) continue;
    const res = await db.alert.updateMany({
      where: { id: a.id, accountId: a.accountId, status: { not: "RESOLVED" } },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    if (res.count !== 1) continue;
    await db.alertNote.create({
      data: {
        accountId: a.accountId,
        alertId: a.id,
        action: "auto_resolve",
        note: "cancelled / refunded in Shopify",
      },
    });
    resolved++;
  }
  return resolved;
}

/** Orders whose tasks one click closes at most. */
export const CLOSE_ORDER_TASKS_MAX = 100;

/**
 * „Затвори задачите“ in „С грешки“ (owner 2026-11-24: 74 orders there and no way to close what a person has
 * checked): every open task of these orders is resolved with the person's note, each as resolveAlert does it
 * (conditional, audited). The sweep does not raise a closed stuck-order task again while the order stays where it is.
 */
export async function resolveOrderTasks(ctx: Ctx, orderIds: string[], rawNote: string) {
  assertCan(ctx.role, "alerts.manage");
  const note = ResolveNote.parse(rawNote);
  const ids = [...new Set(orderIds)];
  if (!ids.length || ids.length > CLOSE_ORDER_TASKS_MAX) throw new DomainError("invalid");
  const open = await accountDb(ctx.accountId).alert.findMany({
    where: { isTask: true, status: { not: "RESOLVED" }, entityType: "Order", entityId: { in: ids } },
    select: { id: true },
  });
  let closed = 0;
  for (const a of open) {
    try {
      await resolveAlert(ctx, a.id, note);
      closed++;
    } catch (err) {
      // Closed meanwhile by someone else, or outside the member's companies: left as it is.
      if (!(err instanceof DomainError)) throw err;
    }
  }
  return { closed };
}
