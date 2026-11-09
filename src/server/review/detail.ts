import type { CrmOrderStatus } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/client";
import { lineConnectionsWhere } from "@/server/lines/lines";
import { assertCan, can } from "@/server/auth/rbac";
import { DomainError } from "@/server/accounts";
import { previewVendorPayload, type Finding } from "@/server/checks";
import { companyFilter, type CompanyScope } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import { getOrder } from "@/server/orders";
import { nextSteps, storedFingerprint } from "@/server/pipeline";
import { STOCK_CONNECTION_TYPES, type RoutingDecision } from "@/server/routing";
import type { ScopedActor } from "@/server/stores";
import { editorValues, mergeDiff, parseDiff, type FieldChange } from "./diff";
import { listReasonCodes, type DecisionKind } from "./reasons";
import { cycleStart, EDITABLE_STATUSES, openSessionsWhere } from "./service";

/**
 * Everything the order detail (DESIGN.md screen 3, P4-04) shows, read in one place with the member's scope:
 * the order, its stored check (findings + routing explanation), stock of every line at every stock-holding
 * warehouse, the timeline (pipeline moves, vendor events, review decisions), the reviewer's open session and
 * — for OWNER/ADMIN only — the raw payloads. Reads only.
 */

export type TimelineEntry =
  | {
      kind: "status";
      at: Date;
      from: CrmOrderStatus | null;
      to: CrmOrderStatus;
      cause: string;
      actorType: string;
      who: string | null;
      source: string | null;
      reason: string | null;
    }
  | {
      kind: "vendor";
      at: Date;
      connection: string;
      source: string;
      rawStatus: string | null;
      status: CrmOrderStatus | null;
    }
  | {
      kind: "review";
      at: Date;
      decision: string;
      who: string | null;
      reasonCode: string | null;
      reasonText: string | null;
      changes: number;
    };

export interface StockCell {
  sellable: number;
  free: number;
  physical: number;
  reserved: number;
  snapshotAt: Date;
  source: string;
}

export async function getOrderReview(actor: ScopedActor, orderId: string) {
  const order = await getOrder(actor, orderId);
  const db = accountDb(actor.accountId);
  const productIds = [...new Set(order.lines.map((l) => l.productId).filter((p): p is string => !!p))];
  const canRaw = can(actor.role, "orders.rawPayloads");
  // Warehouse columns of the order's product line only (+ any warehouse the order already uses).
  const [orderLine, used] = await Promise.all([
    order.companyId
      ? db.company.findUnique({ where: { id: order.companyId }, select: { lineId: true } })
      : Promise.resolve(null),
    db.fulfillment.findMany({ where: { orderId }, select: { connectionId: true } }),
  ]);

  const [check, events, fulfillments, reviews, session, connections, vendorProducts, reasonCodes] =
    await Promise.all([
      db.orderCheck.findUnique({ where: { accountId_orderId: { accountId: actor.accountId, orderId } } }),
      db.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: "asc" }, take: 500 }),
      db.fulfillment.findMany({
        where: { orderId },
        orderBy: { createdAt: "asc" },
        include: {
          connection: { select: { name: true, type: true } },
          events: { orderBy: { occurredAt: "asc" }, take: 200 },
        },
      }),
      db.review.findMany({
        where: { orderId, decision: { not: null } },
        orderBy: { decidedAt: "asc" },
        select: {
          id: true,
          decision: true,
          reasonCode: true,
          reasonText: true,
          reviewerId: true,
          decidedAt: true,
          createdAt: true,
          diff: true,
        },
      }),
      // The undecided corrections of this review cycle (every reviewer's): the next decision carries them.
      cycleStart(db, orderId).then((since) =>
        db.review.findMany({
          where: openSessionsWhere(orderId, since),
          orderBy: { createdAt: "asc" },
          select: { id: true, diff: true, createdAt: true },
        }),
      ),
      db.fulfillmentConnection.findMany({
        where: {
          type: { in: [...STOCK_CONNECTION_TYPES] },
          ...lineConnectionsWhere(
            orderLine?.lineId,
            used.map((f) => f.connectionId),
          ),
        },
        select: { id: true, name: true, type: true, enabled: true },
        orderBy: { name: "asc" },
      }),
      productIds.length
        ? db.vendorProduct.findMany({
            where: { productId: { in: productIds }, archived: false },
            select: {
              connectionId: true,
              productId: true,
              vendorId: true,
              stockLevel: {
                select: {
                  sellable: true,
                  free: true,
                  physical: true,
                  reserved: true,
                  snapshotAt: true,
                  source: true,
                },
              },
            },
            orderBy: { id: "asc" },
          })
        : Promise.resolve([]),
      listReasonCodes(actor.accountId),
    ]);

  // The exact body the routed warehouse would get (DESIGN principle 4), while nothing has been sent yet.
  const payloadConnection =
    check?.connectionId && PAYLOAD_PREVIEW_STATUSES.includes(order.status)
      ? await db.fulfillmentConnection.findUnique({
          where: { id: check.connectionId },
          select: { id: true, name: true, type: true },
        })
      : null;
  const payload = payloadConnection
    ? {
        connection: payloadConnection.name,
        connectionType: payloadConnection.type,
        body: redactSecrets(
          await previewVendorPayload(
            actor.accountId,
            orderId,
            payloadConnection,
            check!.routing as unknown as RoutingDecision,
          ),
        ),
      }
    : null;

  // Names of the people in the timeline (members of this group only).
  const userIds = [
    ...new Set(
      [...events.map((e) => e.userId), ...reviews.map((r) => r.reviewerId)].filter((u): u is string => !!u),
    ),
  ];
  const members = userIds.length
    ? await db.membership.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, user: { select: { name: true, email: true } } },
      })
    : [];
  const who = (id: string | null) => {
    if (!id) return null;
    const m = members.find((x) => x.userId === id);
    return m ? (m.user.name ?? m.user.email) : null;
  };

  // Stock: line × warehouse (the first non-archived vendor product per product and connection, as routing does).
  const stock = new Map<string, Map<string, StockCell | null>>();
  for (const vp of vendorProducts) {
    if (!vp.productId) continue;
    const row = stock.get(vp.productId) ?? new Map<string, StockCell | null>();
    if (!row.has(vp.connectionId)) row.set(vp.connectionId, vp.stockLevel ?? null);
    stock.set(vp.productId, row);
  }

  const timeline: TimelineEntry[] = [
    ...events.map((e): TimelineEntry => ({
      kind: "status",
      at: e.createdAt,
      from: e.fromStatus,
      to: e.toStatus,
      cause: e.cause,
      actorType: e.actorType,
      who: who(e.userId),
      source: e.source,
      reason: e.reason,
    })),
    ...fulfillments.flatMap((f) =>
      f.events.map((e): TimelineEntry => ({
        kind: "vendor",
        at: e.occurredAt,
        connection: f.connection.name,
        source: e.source,
        rawStatus: e.rawStatus,
        status: e.status,
      })),
    ),
    ...reviews.map((r): TimelineEntry => ({
      kind: "review",
      at: r.decidedAt ?? r.createdAt,
      decision: r.decision!,
      who: who(r.reviewerId),
      reasonCode: r.reasonCode,
      reasonText: r.reasonText,
      changes: parseDiff(r.diff).length,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  const decisions = new Set(
    nextSteps(order.status, "user")
      .map((s) => ({ approve: "approve", hold: "hold", cancel: "block" })[s.cause as string])
      .filter((k): k is DecisionKind => !!k),
  );

  return {
    order,
    version: order.updatedAt.toISOString(),
    check: check
      ? {
          findings: (Array.isArray(check.findings) ? check.findings : []) as unknown as Finding[],
          hardCount: check.hardCount,
          softCount: check.softCount,
          routing: check.routing as unknown as RoutingDecision,
          normalised: check.normalised as { phone?: string | null; country?: string | null },
          checkedAt: check.checkedAt,
          connectionId: check.connectionId,
          hasFingerprint: !!storedFingerprint(check.normalised),
        }
      : null,
    editor: editorValues(order.shippingAddress as Record<string, unknown>, order.phone),
    editable: (EDITABLE_STATUSES as readonly string[]).includes(order.status),
    decisions: [...decisions],
    connections,
    stock,
    fulfillments: fulfillments.map((f) => ({
      id: f.id,
      externalId: f.externalId,
      connection: f.connection.name,
      connectionType: f.connection.type,
      status: f.status,
      rawStatus: f.rawStatus,
      trackingNumbers: f.trackingNumbers,
    })),
    timeline,
    session: session.length
      ? {
          ids: session.map((x) => x.id),
          diff: session.reduce<FieldChange[]>((acc, x) => mergeDiff(acc, parseDiff(x.diff)), []),
        }
      : null,
    reasonCodes,
    canReview: can(actor.role, "orders.review"),
    canRaw,
    payload,
  };
}

/** Statuses in which nothing has been sent yet: the detail previews the body the warehouse would get. */
export const PAYLOAD_PREVIEW_STATUSES: readonly CrmOrderStatus[] = [
  "IMPORTED",
  "NEEDS_REVIEW",
  "READY",
  "ON_HOLD",
  "APPROVED",
  "SUBMIT_FAILED",
];

/** Callback URLs carry HMAC tokens in their path: everything after /api/webhooks/ is cut before display. */
export function redactSecrets(v: unknown): unknown {
  if (typeof v === "string") return v.replace(/(\/api\/webhooks\/)[^\s"'<>]*/g, "$1[redacted]");
  if (Array.isArray(v)) return v.map(redactSecrets);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactSecrets(x)]));
  return v;
}

export const RAW_SECTIONS = ["shopify", "original", "routing", "outbox"] as const;
export type RawSection = (typeof RAW_SECTIONS)[number];

/**
 * One raw payload section of the order detail, loaded only when an OWNER/ADMIN opens it (never part of the
 * page itself). Scoped like the detail; tokens in callback URLs are redacted.
 */
export async function getOrderRawPayload(actor: ScopedActor, orderId: string, section: RawSection) {
  assertCan(actor.role, "orders.rawPayloads");
  if (!(RAW_SECTIONS as readonly string[]).includes(section)) throw new DomainError("invalid");
  const order = await getOrder(actor, orderId); // company scope: not_found outside it
  const db = accountDb(actor.accountId);
  if (section === "shopify") return redactSecrets(order.raw ?? null);
  if (section === "original") return redactSecrets(order.shippingAddressOriginal ?? null);
  if (section === "routing") {
    const check = await db.orderCheck.findUnique({
      where: { accountId_orderId: { accountId: actor.accountId, orderId } },
      select: { routing: true },
    });
    return redactSecrets(check?.routing ?? null);
  }
  const rows = await db.outboundRequest.findMany({
    where: { fulfillment: { orderId } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      operation: true,
      status: true,
      payload: true,
      lastResponse: true,
      lastError: true,
      createdAt: true,
      fulfillment: { select: { connection: { select: { name: true } } } },
    },
  });
  return rows.map((o) =>
    redactSecrets({
      id: o.id,
      connection: o.fulfillment?.connection.name ?? null,
      operation: o.operation,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
      payload: o.payload,
      lastResponse: o.lastResponse,
      lastError: o.lastError,
    }),
  );
}

export type OrderReview = Awaited<ReturnType<typeof getOrderReview>>;

// ───────────── review list (P4-05) ─────────────

export interface ReviewFilters {
  decision?: string;
  reasonCode?: string;
  reviewerId?: string;
  q?: string;
  from?: Date;
  to?: Date;
  page?: number;
}

export const REVIEWS_PAGE_SIZE = 50;
const DECISIONS = ["APPROVE", "EDIT_AND_APPROVE", "HOLD", "CANCEL", "REROUTE"] as const;
type Decision = (typeof DECISIONS)[number];
const isDecision = (v: string | undefined): v is Decision =>
  !!v && (DECISIONS as readonly string[]).includes(v);

type ListCtx = {
  accountId: string;
  role: Role;
  companyScope: CompanyScope;
  activeCompanyId: string | null;
};

/**
 * Decided reviews, newest first, limited to orders of the companies the member may see. Needs reviews.read
 * (the diffs hold customer phones and addresses).
 */
export async function listReviews(ctx: ListCtx, f: ReviewFilters) {
  assertCan(ctx.role, "reviews.read");
  const db = accountDb(ctx.accountId);
  const q = f.q?.trim().replace(/^#/, "");
  const where = {
    decision: isDecision(f.decision) ? f.decision : { not: null },
    ...(f.reasonCode ? { reasonCode: f.reasonCode } : {}),
    ...(f.reviewerId ? { reviewerId: f.reviewerId } : {}),
    ...(f.from || f.to
      ? { decidedAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } }
      : {}),
    order: { ...companyFilter(ctx), ...(q ? { number: { contains: q, mode: "insensitive" as const } } : {}) },
  };
  const page = Math.max(1, f.page ?? 1);
  const [rows, total, byDecision, avg] = await Promise.all([
    db.review.findMany({
      where,
      orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * REVIEWS_PAGE_SIZE,
      take: REVIEWS_PAGE_SIZE,
      select: {
        id: true,
        decision: true,
        reasonCode: true,
        reasonText: true,
        reviewerId: true,
        timeSpentMs: true,
        decidedAt: true,
        diff: true,
        findings: true,
        order: { select: { id: true, number: true, status: true, countryCode: true } },
      },
    }),
    db.review.count({ where }),
    db.review.groupBy({ by: ["decision"], where, _count: { _all: true } }),
    db.review.aggregate({ where, _avg: { timeSpentMs: true } }),
  ]);
  const reviewers = await db.membership.findMany({
    select: { userId: true, user: { select: { name: true, email: true } } },
    orderBy: { user: { email: "asc" } },
  });
  const name = new Map(reviewers.map((m) => [m.userId, m.user.name ?? m.user.email]));
  return {
    rows: rows.map((r) => {
      const findings = Array.isArray(r.findings) ? (r.findings as unknown as Finding[]) : [];
      return {
        ...r,
        reviewer: r.reviewerId ? (name.get(r.reviewerId) ?? null) : null,
        changes: parseDiff(r.diff),
        hard: findings.filter((x) => x.severity === "hard").length,
        soft: findings.filter((x) => x.severity === "soft").length,
      };
    }),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / REVIEWS_PAGE_SIZE)),
    byDecision: Object.fromEntries(byDecision.map((g) => [g.decision ?? "", g._count._all])),
    avgTimeMs: avg._avg.timeSpentMs,
    reviewers: reviewers.map((m) => ({ id: m.userId, label: m.user.name ?? m.user.email })),
  };
}
