import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { checkOrder, orderLevelFindings, type Finding } from "@/server/checks";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { transition } from "@/server/pipeline";
import type { RoutingDecision } from "@/server/routing";
import type { ScopedActor } from "@/server/stores";
import {
  AddressEdit,
  applyEdit,
  diffValues,
  editorValues,
  isEditableField,
  mergeDiff,
  parseDiff,
  type FieldChange,
} from "./diff";
import { codesFor, DECISION_KINDS, listReasonCodes, OTHER_REASON, type DecisionKind } from "./reasons";

/**
 * Human review of one order (P4-04 / P4-05):
 *   editOrderAddress()   — correct the shipping address / phone (original kept), then re-check the order;
 *   previewAddress()     — live validation of a draft address with the real order-level rules, nothing stored;
 *   decideOrder()        — Одобри / Задръж / Блокирай: one pipeline transition + one Review record.
 *
 * Every decision stores a Review: the decision, the field-level diff of the operator's corrections in this
 * review session, the reason code (+ free text), the findings the operator saw and the time spent — the
 * training data of the AI reviewer (SPEC §7.1). An edit opens the session as an undecided Review of that
 * reviewer; the decision closes it. Nothing here talks to a vendor: approving only moves the order to
 * APPROVED (sending is the Fulfill action, through the outbox).
 */

type Tx = Prisma.TransactionClient;
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

/** Statuses in which the address may still be corrected: nothing has been approved or queued yet. */
export const EDITABLE_STATUSES = ["IMPORTED", "NEEDS_REVIEW", "READY", "ON_HOLD"] as const;
const isEditable = (s: string) => (EDITABLE_STATUSES as readonly string[]).includes(s);

/** Longest time one review may count (an order left open overnight is not 14 hours of work). */
export const MAX_REVIEW_MS = 2 * 3600_000;

async function scopedOrder(tx: Tx, actor: ScopedActor, orderId: string) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      companyId: true,
      status: true,
      phone: true,
      shippingAddress: true,
      updatedAt: true,
    },
  });
  if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? "")))
    throw new DomainError("not_found");
  return order;
}

const storedFindings = (v: unknown): Finding[] => (Array.isArray(v) ? (v as Finding[]) : []);

/** The open (undecided) review of this reviewer for this order, created with the findings seen now. */
async function openSession(tx: Tx, accountId: string, orderId: string, reviewerId: string) {
  const open = await tx.review.findFirst({
    where: { orderId, reviewerId, decision: null },
    orderBy: { createdAt: "desc" },
  });
  if (open) return open;
  const check = await tx.orderCheck.findUnique({
    where: { accountId_orderId: { accountId, orderId } },
    select: { findings: true },
  });
  return tx.review.create({
    data: { accountId, orderId, reviewerId, findings: json(storedFindings(check?.findings)), diff: [] },
  });
}

export interface EditResult {
  changed: FieldChange[];
  status: string;
  hardCount: number;
  softCount: number;
}

/**
 * Saves a corrected address (`version` = the Order.updatedAt the editor was opened with; a newer order —
 * Shopify re-import, another operator — is refused as "stale" instead of being overwritten). The Shopify
 * original stays in shippingAddressOriginal and the import keeps the correction (src/server/shopify/orders.ts).
 * The order is re-checked right after, so findings and the approve guard see the corrected data.
 */
export async function editOrderAddress(
  actor: ScopedActor,
  orderId: string,
  input: { values: unknown; version: string; via?: string },
): Promise<EditResult> {
  assertCan(actor.role, "orders.review");
  const edit = AddressEdit.parse(input.values);
  const via = input.via && /^(manual|suggested_fix:[a-z0-9_.]{1,80})$/.test(input.via) ? input.via : "manual";
  const changed = await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", orderId);
    const order = await scopedOrder(tx, actor, orderId);
    if (!isEditable(order.status)) throw new DomainError("not_editable");
    if (order.updatedAt.toISOString() !== input.version) throw new DomainError("stale");
    const before = editorValues(order.shippingAddress as Record<string, unknown>, order.phone);
    const changes = diffValues(before, edit, via);
    if (!changes.length) return changes;
    const address = applyEdit(order.shippingAddress as Record<string, unknown>, edit);
    await tx.order.update({
      where: { id: orderId },
      data: {
        shippingAddress: json(address),
        ...(edit.countryCode !== undefined ? { countryCode: edit.countryCode } : {}),
        ...(edit.phone !== undefined ? { phone: edit.phone } : {}),
      },
    });
    const session = await openSession(tx, actor.accountId, orderId, actor.userId);
    await tx.review.update({
      where: { id: session.id },
      data: { diff: json(mergeDiff(parseDiff(session.diff), changes)) },
    });
    await tx.auditLog.create({
      data: {
        accountId: actor.accountId,
        userId: actor.userId,
        action: "order.address_edited",
        entityType: "Order",
        entityId: orderId,
        before: json({ address: order.shippingAddress, phone: order.phone }),
        after: json({ address, phone: edit.phone !== undefined ? edit.phone : order.phone, via }),
        ip: actor.ip ?? null,
        userAgent: actor.userAgent?.slice(0, 300) ?? null,
      },
    });
    return changes;
  });
  if (!changed.length) {
    const o = await accountDb(actor.accountId).order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, check: { select: { hardCount: true, softCount: true } } },
    });
    return {
      changed,
      status: o.status,
      hardCount: o.check?.hardCount ?? 0,
      softCount: o.check?.softCount ?? 0,
    };
  }
  const r = await checkOrder(actor.accountId, orderId, { actor: { kind: "user", userId: actor.userId } });
  return { changed, status: r.status, hardCount: r.hardCount, softCount: r.softCount };
}

/**
 * Live validation for the editor: the order-level address and phone rules (the same function the validator
 * engine runs) on a draft, against the order's last routing decision. Reads only; stores nothing.
 */
export async function previewAddress(actor: ScopedActor, orderId: string, values: unknown) {
  assertCan(actor.role, "orders.review");
  const edit = AddressEdit.parse(values);
  const db = accountDb(actor.accountId);
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { lines: { select: { title: true, sku: true, productId: true, quantity: true } }, check: true },
  });
  if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? "")))
    throw new DomainError("not_found");
  const address = applyEdit(order.shippingAddress as Record<string, unknown>, edit);
  const country = (address.countryCode ?? order.countryCode)?.toUpperCase() ?? null;
  const setting = country
    ? await db.countrySetting.findUnique({
        where: { accountId_country: { accountId: actor.accountId, country } },
      })
    : null;
  const routing = (order.check?.routing ?? null) as RoutingDecision | null;
  const out = orderLevelFindings(
    {
      number: order.number,
      customerName: order.customerName,
      email: order.email,
      phone: edit.phone !== undefined ? edit.phone : order.phone,
      shippingAddress: address,
      countryCode: country,
      currency: order.currency,
      total: Number(order.total),
      paymentMethod: order.paymentMethod,
      codAmount: order.codAmount == null ? null : Number(order.codAmount),
      codLocalAmount: order.codLocalAmount == null ? null : Number(order.codLocalAmount),
      codLocalCurrency: order.codLocalCurrency,
      tags: order.tags,
      lines: order.lines,
    },
    {
      localCurrency: setting?.currency ?? null,
      routing: routing ?? {
        connectionId: "preview",
        connectionName: null,
        connectionType: null,
        via: "none",
        ruleId: null,
        ruleNumber: null,
        ruleName: null,
        crossCompany: false,
        carrier: null,
        stock: null,
        explanation: { bg: "", en: "" },
        steps: [],
      },
      stock: null,
      duplicates: [],
    },
  );
  return {
    findings: out.findings.filter((f) => isEditableField(f.field)),
    normalisedPhone: out.normalised.phone,
  };
}

export const DecisionInput = z.object({
  orderId: z.string().min(1),
  decision: z.enum(DECISION_KINDS),
  reasonCode: z
    .string()
    .trim()
    .max(40)
    .transform((v) => v || null)
    .nullable()
    .optional(),
  reasonText: z
    .string()
    .max(1000)
    .transform((v) => v.trim() || null)
    .nullable()
    .optional(),
  /** When the reviewer opened the order (ISO); used for time spent only, clamped. */
  openedAt: z.string().datetime().nullable().optional(),
});
export type DecisionInput = z.input<typeof DecisionInput>;

const TARGET: Record<
  DecisionKind,
  { to: "APPROVED" | "ON_HOLD" | "CANCELLED"; cause: "approve" | "hold" | "cancel" }
> = {
  approve: { to: "APPROVED", cause: "approve" },
  hold: { to: "ON_HOLD", cause: "hold" },
  // Блокирай: the order is never sent — cancelled in the CRM only (Shopify is not touched; refunds and
  // Shopify cancellations stay with the shop). The pipeline refuses it once a shipment is active.
  block: { to: "CANCELLED", cause: "cancel" },
};

export function timeSpentMs(openedAt: string | null | undefined, now: Date): number | null {
  if (!openedAt) return null;
  const ms = now.getTime() - new Date(openedAt).getTime();
  if (!Number.isFinite(ms) || ms < -60_000) return null; // a clock from the future is not trusted
  return Math.min(Math.max(ms, 0), MAX_REVIEW_MS);
}

/**
 * One review decision. In one transaction, with the Order row locked: the reason is checked against the
 * group's codes, approve is refused while the stored check has a hard finding (and by the pipeline's own
 * approve guard: stale check, missing check), the order moves (strict — a refused move rolls back the Review
 * too) and the Review is closed with decision, diff, reason, findings and time spent.
 */
export async function decideOrder(actor: ScopedActor, raw: DecisionInput, now = new Date()) {
  assertCan(actor.role, "orders.review");
  const input = DecisionInput.parse(raw);
  const codes = codesFor(await listReasonCodes(actor.accountId), input.decision);
  if (input.reasonCode && !codes.some((c) => c.code === input.reasonCode))
    throw new DomainError("reason_invalid");
  if (input.decision !== "approve" && !input.reasonCode) throw new DomainError("reason_required");
  if (input.reasonCode === OTHER_REASON && !input.reasonText) throw new DomainError("reason_text_required");

  const target = TARGET[input.decision];
  return withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", input.orderId);
    const order = await scopedOrder(tx, actor, input.orderId);
    const check = await tx.orderCheck.findUnique({
      where: { accountId_orderId: { accountId: actor.accountId, orderId: order.id } },
      select: { findings: true, hardCount: true, connectionId: true },
    });
    if (input.decision === "approve") {
      if (!check) throw new DomainError("no_check");
      if (check.hardCount > 0) throw new DomainError("hard_findings");
    }
    const session = await openSession(tx, actor.accountId, order.id, actor.userId);
    const diff = parseDiff(session.diff);
    const decision =
      input.decision === "approve"
        ? diff.length
          ? "EDIT_AND_APPROVE"
          : "APPROVE"
        : input.decision === "hold"
          ? "HOLD"
          : "CANCEL";
    const reason = [input.reasonCode, input.reasonText].filter(Boolean).join(": ") || null;
    const moved = await transition(tx, {
      orderId: order.id,
      to: target.to,
      cause: target.cause,
      actor: { kind: "user", userId: actor.userId },
      source: "review",
      reason,
      mode: "strict",
      meta: { reviewId: session.id, ...(check?.connectionId ? { connectionId: check.connectionId } : {}) },
    });
    if (!moved.changed) throw new DomainError("already_decided");
    const review = await tx.review.update({
      where: { id: session.id },
      data: {
        decision,
        reasonCode: input.reasonCode ?? null,
        reasonText: input.reasonText ?? null,
        timeSpentMs: timeSpentMs(input.openedAt, now),
        decidedAt: now,
        // The findings the operator decided on: those seen when the session opened (before any correction).
        ...(diff.length ? {} : { findings: json(storedFindings(check?.findings)) }),
      },
    });
    return { reviewId: review.id, decision, status: target.to, from: moved.from };
  });
}
