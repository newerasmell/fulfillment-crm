import type { CrmOrderStatus } from "@/generated/prisma/client";
import { can } from "@/server/auth/rbac";
import type { Finding } from "@/server/checks";
import { companyFilter, type CompanyScope } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import { getOrder } from "@/server/orders";
import { nextSteps, storedFingerprint } from "@/server/pipeline";
import { STOCK_CONNECTION_TYPES, type RoutingDecision } from "@/server/routing";
import type { ScopedActor } from "@/server/stores";
import { editorValues, parseDiff, type FieldChange } from "./diff";
import { listReasonCodes, type DecisionKind } from "./reasons";
import { EDITABLE_STATUSES } from "./service";

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
          ...(canRaw
            ? {
                outboundRequests: {
                  orderBy: { createdAt: "asc" as const },
                  select: {
                    id: true,
                    operation: true,
                    status: true,
                    payload: true,
                    lastResponse: true,
                    lastError: true,
                    createdAt: true,
                  },
                },
              }
            : {}),
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
      db.review.findFirst({
        where: { orderId, reviewerId: actor.userId, decision: null },
        orderBy: { createdAt: "desc" },
        select: { id: true, diff: true, createdAt: true },
      }),
      db.fulfillmentConnection.findMany({
        where: { type: { in: [...STOCK_CONNECTION_TYPES] } },
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
      outbound:
        "outboundRequests" in f
          ? (f.outboundRequests as {
              id: string;
              operation: string;
              status: string;
              payload: unknown;
              lastResponse: unknown;
              lastError: string | null;
              createdAt: Date;
            }[])
          : [],
    })),
    timeline,
    session: session ? { id: session.id, diff: parseDiff(session.diff) as FieldChange[] } : null,
    reasonCodes,
    canReview: can(actor.role, "orders.review"),
    canRaw,
    raw: canRaw
      ? {
          shopify: order.raw,
          shippingAddressOriginal: order.shippingAddressOriginal,
          routing: check?.routing ?? null,
        }
      : null,
  };
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

type ListCtx = { accountId: string; companyScope: CompanyScope; activeCompanyId: string | null };

/** Decided reviews, newest first, limited to orders of the companies the member may see. */
export async function listReviews(ctx: ListCtx, f: ReviewFilters) {
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
