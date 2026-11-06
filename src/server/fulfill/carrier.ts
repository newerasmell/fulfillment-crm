import { z } from "zod";
import { carrierKey, knownShopifyCompany, shopifyCompanyNamed } from "@/integrations/shopify/fulfillments";
import { DomainError } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { withAccountTransaction } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import { CARRIER_UNKNOWN, resolveCarrierTasks } from "./writeback";

/**
 * "Изберете куриер за Shopify" (owner request 2026-11-06): a Shopify write-back held because Shopify does not know
 * the shipment's carrier waits for a person to pick one of Shopify's tracking companies. Only for a shipment that
 * has a held row. For a named courier the choice is remembered for the group (ShopifyCarrierAlias, by courier
 * name — never for a name Shopify already knows) and releases the rows held for that name in the person's
 * companies; a shipment with no carrier at all gets the company as its carrier. Audited; a task is resolved once
 * its order has nothing held any more (the sweep re-checks rows held meanwhile).
 */

export const SetShipmentCarrierInput = z.object({
  orderId: z.string().min(1).max(64),
  fulfillmentId: z.string().min(1).max(64),
  company: z.string().trim().min(1).max(64),
});

const held = { status: "AWAITING_CONFIRMATION" as const, lastError: CARRIER_UNKNOWN };

export async function setShipmentCarrier(actor: ScopedActor, raw: z.input<typeof SetShipmentCarrierInput>) {
  assertCan(actor.role, "orders.fulfill");
  const input = SetShipmentCarrierInput.parse(raw);
  const company = shopifyCompanyNamed(input.company);
  if (!company) throw new DomainError("carrier_not_shopify");
  const accountId = actor.accountId;
  const scope = actor.companyScope;
  const result = await withAccountTransaction(accountId, async (tx) => {
    const shipment = await tx.fulfillment.findFirst({
      where: { accountId, id: input.fulfillmentId, orderId: input.orderId },
      select: { id: true, carrier: true, order: { select: { id: true, companyId: true } } },
    });
    if (!shipment || (scope && !scope.includes(shipment.order.companyId ?? "")))
      throw new DomainError("not_found");
    if (
      (await tx.shopifyWriteBack.count({ where: { accountId, fulfillmentId: shipment.id, ...held } })) === 0
    )
      throw new DomainError("not_held");
    const name = shipment.carrier?.trim() || null;
    const key = name ? carrierKey(name) : null;
    // A name Shopify knows is never held (and never re-mapped by hand).
    if (name && knownShopifyCompany(name)) throw new DomainError("not_held");
    let before: string | null = null;
    if (name && key) {
      const prev = await tx.shopifyCarrierAlias.findUnique({
        where: { accountId_carrierKey: { accountId, carrierKey: key } },
        select: { company: true },
      });
      before = prev?.company ?? null;
      await tx.shopifyCarrierAlias.upsert({
        where: { accountId_carrierKey: { accountId, carrierKey: key } },
        create: {
          accountId,
          carrierKey: key,
          carrierName: name.slice(0, 200),
          company,
          updatedById: actor.userId,
        },
        update: { company, carrierName: name.slice(0, 200), updatedById: actor.userId },
      });
    } else {
      // No carrier from the warehouse: this shipment's carrier is the company picked (a later warehouse name wins).
      await tx.fulfillment.update({ where: { id: shipment.id }, data: { carrier: company } });
    }

    // Rows held for this shipment, and for the same courier name in the person's companies (the sweep releases
    // the others within minutes, now that the name has a company).
    const rows = await tx.shopifyWriteBack.findMany({
      where: {
        accountId,
        ...held,
        ...(scope ? { order: { companyId: { in: scope } } } : {}),
      },
      select: { id: true, orderId: true, fulfillmentId: true, fulfillment: { select: { carrier: true } } },
    });
    const release = rows.filter(
      (r) =>
        r.fulfillmentId === shipment.id ||
        (key !== null && !!r.fulfillment.carrier && carrierKey(r.fulfillment.carrier) === key),
    );
    await tx.shopifyWriteBack.updateMany({
      where: { accountId, id: { in: release.map((r) => r.id) }, ...held },
      data: { status: "PENDING", attempts: 0, nextAttemptAt: null, lastError: null },
    });
    await tx.auditLog.create({
      data: {
        accountId,
        userId: actor.userId,
        action: "shipment.shopify_carrier_set",
        entityType: "Fulfillment",
        entityId: shipment.id,
        before: { carrier: name, company: before },
        after: { company, released: release.length, remembered: !!key },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent?.slice(0, 300) ?? null,
      },
    });
    return { company, released: release.length, orders: [...new Set(release.map((r) => r.orderId))] };
  });
  await resolveCarrierTasks(accountId, result.orders);
  return { company: result.company, released: result.released };
}
