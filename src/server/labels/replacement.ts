import { DomainError } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { accountDb } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import type { REPLACEMENT_REASONS } from "./manual";

/**
 * „Изпрати замяна“ (owner request 2026-11-19): a parcel arrived broken, an item was missing or wrong, the parcel was
 * lost — the customer gets a new one for free. It is an ordinary manual shipment („Ръчни пратки“, M1001 …) that goes
 * through the same checks, approval and Fulfill as every order; this file only:
 *  - fills the form from the original order (company, recipient, products at price 0, no COD), every field still
 *    editable (e.g. only the broken item);
 *  - links the two orders both ways (ManualShipment.params.replacement.sourceOrderId).
 */

export type ReplacementReason = (typeof REPLACEMENT_REASONS)[number];

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The form's starting values from an order of the actor's companies. */
export async function replacementDraft(actor: ScopedActor, orderId: string) {
  assertCan(actor.role, "orders.fulfill");
  const order = await accountDb(actor.accountId).order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      number: true,
      companyId: true,
      customerName: true,
      email: true,
      phone: true,
      currency: true,
      countryCode: true,
      shippingAddress: true,
      lines: { select: { productId: true, quantity: true, sku: true, title: true } },
    },
  });
  if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? "")))
    throw new DomainError("not_found");
  const a = (order.shippingAddress ?? {}) as Record<string, unknown>;
  const country = (str(a.countryCode) || order.countryCode || "BG").toUpperCase();
  return {
    sourceOrderId: order.id,
    sourceNumber: order.number,
    companyId: order.companyId,
    currency: order.currency,
    recipient: {
      name: str(a.name) || order.customerName || "",
      email: order.email ?? "",
      phone: str(a.phone) || order.phone || "",
      address1: str(a.address1),
      buildingNumber: "",
      address2: str(a.address2),
      city: str(a.city),
      zip: str(a.zip),
      region: str(a.province),
      countryCode: country,
    },
    // Free: price 0, no COD. A line without a product (not matched) cannot be sent from stock: left out, named.
    lines: order.lines
      .filter((l): l is typeof l & { productId: string } => !!l.productId)
      .map((l) => ({ productId: l.productId, quantity: l.quantity })),
    unmatched: order.lines.filter((l) => !l.productId).map((l) => l.sku ?? l.title),
  };
}

export type ReplacementDraft = Awaited<ReturnType<typeof replacementDraft>>;

/** The replacements sent for an order, and the order a replacement was sent for (only orders the viewer may see). */
export async function replacementLinks(
  actor: Pick<ScopedActor, "accountId" | "companyScope">,
  orderId: string,
) {
  const accountId = actor.accountId;
  const db = accountDb(accountId);
  const visible = actor.companyScope ? { companyId: { in: actor.companyScope } } : {};
  const [sent, own] = await Promise.all([
    db.manualShipment.findMany({
      where: { params: { path: ["replacement", "sourceOrderId"], equals: orderId }, order: visible },
      select: { params: true, order: { select: { id: true, number: true, status: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.manualShipment.findUnique({
      where: { accountId_orderId: { accountId, orderId } },
      select: { params: true },
    }),
  ]);
  const reasonOf = (params: unknown) => {
    const r = (params as { replacement?: { reason?: string; reasonText?: string | null } } | null)
      ?.replacement;
    return { reason: (r?.reason ?? "other") as ReplacementReason, reasonText: r?.reasonText ?? null };
  };
  const srcId = (own?.params as { replacement?: { sourceOrderId?: string } } | null)?.replacement
    ?.sourceOrderId;
  const source = srcId
    ? await db.order.findFirst({ where: { id: srcId, ...visible }, select: { id: true, number: true } })
    : null;
  return {
    replacements: sent.map((m) => ({ ...m.order, ...reasonOf(m.params) })),
    replacementOf: source ? { ...source, ...reasonOf(own?.params) } : null,
  };
}
