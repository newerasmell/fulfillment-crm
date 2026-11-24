import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";

/**
 * Comments on an order (owner request 2026-11-24): a person writes what the problem is and what was done, with date,
 * time and author, outside the status history — so management sees at a glance what happens with an order, above all
 * one a colleague could not act on. Comments are never edited or deleted (a correction is a new comment).
 */

export const COMMENT_MAX = 2000;
const Body = z.string().trim().min(2).max(COMMENT_MAX);

async function orderInScope(actor: ScopedActor, orderId: string) {
  const order = await accountDb(actor.accountId).order.findFirst({
    where: {
      id: orderId,
      ...(actor.companyScope ? { companyId: { in: actor.companyScope } } : {}),
    },
    select: { id: true },
  });
  if (!order) throw new DomainError("not_found");
  return order;
}

export async function listOrderComments(actor: ScopedActor, orderId: string) {
  assertCan(actor.role, "account.read");
  await orderInScope(actor, orderId);
  // The newest 500, shown oldest first.
  const rows = await accountDb(actor.accountId).orderComment.findMany({
    where: { orderId },
    select: { id: true, author: true, body: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 500,
  });
  return rows.reverse();
}

export async function addOrderComment(
  actor: ScopedActor & { author: string },
  orderId: string,
  rawBody: string,
) {
  assertCan(actor.role, "alerts.manage");
  const body = Body.parse(rawBody);
  await orderInScope(actor, orderId);
  const comment = await accountDb(actor.accountId).orderComment.create({
    data: {
      accountId: actor.accountId,
      orderId,
      userId: actor.userId,
      author: actor.author.slice(0, 200),
      body,
    },
    select: { id: true, author: true, body: true, createdAt: true },
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "order.comment",
    entityType: "Order",
    entityId: orderId,
    after: { commentId: comment.id },
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  });
  return comment;
}

/** The latest comment of each of these orders (for the orders list): one row per order. */
export async function latestCommentOf(accountId: string, orderIds: string[]) {
  const out = new Map<string, { author: string; body: string; createdAt: Date }>();
  if (!orderIds.length) return out;
  const db = accountDb(accountId);
  const latest = await db.orderComment.groupBy({
    by: ["orderId"],
    where: { orderId: { in: orderIds } },
    _max: { createdAt: true },
  });
  if (!latest.length) return out;
  const rows = await db.orderComment.findMany({
    where: {
      OR: latest.map((l) => ({ orderId: l.orderId, createdAt: l._max.createdAt! })),
    },
    select: { orderId: true, author: true, body: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  for (const r of rows) if (!out.has(r.orderId)) out.set(r.orderId, { ...r, body: r.body.slice(0, 300) });
  return out;
}
