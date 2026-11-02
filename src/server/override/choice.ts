import { z } from "zod";
import type { CrmOrderStatus, Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { checkOrder } from "@/server/checks";
import { withAccountTransaction } from "@/server/db/client";
import { transition } from "@/server/pipeline";
import type { ScopedActor } from "@/server/stores";
import { eligibleConnections, scopedOrderForChoice } from "./options";
import { assertWarehouseReason } from "./reasons";

/**
 * "Изпрати от" — a person chooses the warehouse that ships an order BEFORE it is sent (P4-09):
 *   setWarehouseChoice()   — store the choice (with a reason), re-run the checks for that warehouse;
 *   clearWarehouseChoice() — back to the routing decision, checks re-run.
 * The choice is stored in OrderWarehouseChoice; the validator engine (src/server/checks/validate.ts) then validates
 * every check for that connection and stores it as OrderCheck.connectionId with routing.via "manual" + who/why.
 * Approval and Fulfill are bound to OrderCheck.connectionId (pipeline approve guard check_connection_mismatch,
 * fulfillOrder): changing the warehouse of an APPROVED order reopens it (→ NEEDS_REVIEW) so it is approved again for
 * the new warehouse, and the stored check is made stale in the same transaction, so nobody can approve or send for
 * the old warehouse in between. Every change: an OrderEvent (timeline), a REROUTE Review (AI training data) and an
 * audit entry. Never talks to a vendor.
 */

type Tx = Prisma.TransactionClient;
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

/** Statuses in which the shipping warehouse may still be chosen: nothing was queued or sent yet. */
export const CHOICE_STATUSES: readonly CrmOrderStatus[] = [
  "IMPORTED",
  "NEEDS_REVIEW",
  "READY",
  "ON_HOLD",
  "APPROVED",
  "SUBMIT_FAILED",
];

export const ChoiceInput = z.object({
  orderId: z.string().min(1).max(64),
  connectionId: z.string().min(1).max(64),
  reasonCode: z.string().trim().max(40).nullable().optional(),
  reasonText: z.string().max(1000).nullable().optional(),
});
export type ChoiceInput = z.input<typeof ChoiceInput>;

/** The stored check no longer counts (approve refuses "check_stale", Fulfill "check_stale") until re-run. */
export async function invalidateCheck(tx: Tx, orderId: string, connectionId: string | null) {
  const check = await tx.orderCheck.findFirst({ where: { orderId }, select: { id: true, normalised: true } });
  if (!check) return null;
  const { orderFingerprint: _drop, ...rest } = (check.normalised ?? {}) as Record<string, unknown>;
  void _drop;
  await tx.orderCheck.update({
    where: { id: check.id },
    data: { connectionId, normalised: json(rest) },
  });
  return check.id;
}

/** APPROVED for another warehouse → back to review (strict: a refused move rolls everything back). */
async function reopenIfApproved(
  tx: Tx,
  orderId: string,
  status: CrmOrderStatus,
  userId: string,
  reason: string,
) {
  if (status !== "APPROVED") return status;
  await transition(tx, {
    orderId,
    to: "NEEDS_REVIEW",
    cause: "reopen",
    actor: { kind: "user", userId },
    source: "override.choice",
    reason,
    mode: "strict",
  });
  return "NEEDS_REVIEW" as const;
}

async function timelineEvent(
  tx: Tx,
  input: {
    accountId: string;
    orderId: string;
    status: CrmOrderStatus;
    cause: string;
    userId: string | null;
    actorType?: string;
    reason: string | null;
    meta: Record<string, unknown>;
    source: string;
  },
) {
  await tx.orderEvent.create({
    data: {
      accountId: input.accountId,
      orderId: input.orderId,
      fromStatus: input.status,
      toStatus: input.status,
      cause: input.cause,
      actorType: input.actorType ?? "user",
      userId: input.userId,
      source: input.source,
      reason: input.reason?.slice(0, 1000) ?? null,
      meta: json(input.meta),
    },
  });
}
export { timelineEvent as recordTimelineEvent };

export async function setWarehouseChoice(actor: ScopedActor, raw: ChoiceInput) {
  assertCan(actor.role, "orders.review");
  const input = ChoiceInput.parse(raw);
  const reason = await assertWarehouseReason(actor.accountId, input.reasonCode, input.reasonText);
  const order = await scopedOrderForChoice(actor, input.orderId);
  const eligible = await eligibleConnections(actor.accountId, {
    companyId: order.companyId,
    lineId: order.company?.lineId ?? null,
  });
  const target = eligible.find((c) => c.id === input.connectionId);
  if (!target) throw new DomainError("connection_not_eligible");
  const reasonLine = [reason.reasonCode, reason.reasonText].filter(Boolean).join(": ");

  await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", order.id);
    const now = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    if (!CHOICE_STATUSES.includes(now.status)) throw new DomainError("choice_not_allowed");
    const [before, check] = await Promise.all([
      tx.orderWarehouseChoice.findFirst({ where: { orderId: order.id } }),
      tx.orderCheck.findFirst({
        where: { orderId: order.id },
        select: { connectionId: true, findings: true },
      }),
    ]);
    const data = {
      connectionId: target.id,
      via: "manual",
      reasonCode: reason.reasonCode,
      reasonText: reason.reasonText,
      chosenById: actor.userId,
      rerouteId: null,
    };
    if (before) await tx.orderWarehouseChoice.update({ where: { id: before.id }, data });
    else
      await tx.orderWarehouseChoice.create({
        data: { accountId: actor.accountId, orderId: order.id, ...data },
      });
    const status = await reopenIfApproved(tx, order.id, now.status, actor.userId, `warehouse: ${reasonLine}`);
    await invalidateCheck(tx, order.id, target.id);
    const meta = {
      connectionId: target.id,
      connectionName: target.name,
      fromConnectionId: check?.connectionId ?? null,
      crossCompany: !!order.companyId && !!target.companyId && order.companyId !== target.companyId,
      reasonCode: reason.reasonCode,
      reasonText: reason.reasonText,
    };
    await timelineEvent(tx, {
      accountId: actor.accountId,
      orderId: order.id,
      status,
      cause: "warehouse_choice",
      userId: actor.userId,
      reason: reasonLine,
      meta,
      source: "override.choice",
    });
    // Every decision teaches the AI (DESIGN principle 7): a decided REROUTE review with the reason.
    await tx.review.create({
      data: {
        accountId: actor.accountId,
        orderId: order.id,
        reviewerId: actor.userId,
        decision: "REROUTE",
        reasonCode: reason.reasonCode,
        reasonText: reason.reasonText,
        findings: json(Array.isArray(check?.findings) ? check.findings : []),
        diff: [],
        decidedAt: new Date(),
      },
    });
    await tx.auditLog.create({
      data: {
        accountId: actor.accountId,
        userId: actor.userId,
        action: "order.warehouse_choice",
        entityType: "Order",
        entityId: order.id,
        before: json(before ? { connectionId: before.connectionId, reasonCode: before.reasonCode } : null),
        after: json({ ...meta, statusBefore: now.status, status }),
        ip: actor.ip ?? null,
        userAgent: actor.userAgent?.slice(0, 300) ?? null,
      },
    });
  });
  return checkOrder(actor.accountId, order.id, { actor: { kind: "user", userId: actor.userId } });
}

export async function clearWarehouseChoice(actor: ScopedActor, orderId: string) {
  assertCan(actor.role, "orders.review");
  const order = await scopedOrderForChoice(actor, orderId);
  await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", order.id);
    const now = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    if (!CHOICE_STATUSES.includes(now.status)) throw new DomainError("choice_not_allowed");
    const before = await tx.orderWarehouseChoice.findFirst({ where: { orderId: order.id } });
    if (!before) throw new DomainError("no_choice");
    await tx.orderWarehouseChoice.delete({ where: { id: before.id } });
    const status = await reopenIfApproved(tx, order.id, now.status, actor.userId, "warehouse: routing");
    await invalidateCheck(tx, order.id, null);
    await timelineEvent(tx, {
      accountId: actor.accountId,
      orderId: order.id,
      status,
      cause: "warehouse_choice_cleared",
      userId: actor.userId,
      reason: null,
      meta: { fromConnectionId: before.connectionId },
      source: "override.choice",
    });
    await tx.auditLog.create({
      data: {
        accountId: actor.accountId,
        userId: actor.userId,
        action: "order.warehouse_choice_cleared",
        entityType: "Order",
        entityId: order.id,
        before: json({ connectionId: before.connectionId, reasonCode: before.reasonCode, via: before.via }),
        after: json({ statusBefore: now.status, status }),
        ip: actor.ip ?? null,
        userAgent: actor.userAgent?.slice(0, 300) ?? null,
      },
    });
  });
  return checkOrder(actor.accountId, order.id, { actor: { kind: "user", userId: actor.userId } });
}
