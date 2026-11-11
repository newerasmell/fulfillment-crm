import { z } from "zod";
import { carrierKey, knownShopifyCompany, shopifyCompanyNamed } from "@/integrations/shopify/fulfillments";
import { DomainError } from "@/server/accounts";
import { assertCan, can } from "@/server/auth/rbac";
import { withAccountTransaction } from "@/server/db/client";
import { noCarrierKey } from "@/server/shopify/carrier-company";
import { TrackingTemplate } from "@/server/shopify/tracking-links";
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
  // Shown to customers: no control characters.
  company: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine((v) => !/\p{Cc}/u.test(v), "control_characters"),
  /**
   * A courier Shopify does not list (owner request 2026-11-11: Express One): its name goes to Shopify as is, with our
   * tracking link (a {tracking} template, required unless one is already saved for that name).
   */
  custom: z.boolean().optional().default(false),
  urlTemplate: z
    .string()
    .trim()
    .max(500)
    .refine((v) => !/\p{Cc}/u.test(v), "control_characters")
    .nullish(),
});

const held = { status: "AWAITING_CONFIRMATION" as const, lastError: CARRIER_UNKNOWN };

export async function setShipmentCarrier(actor: ScopedActor, raw: z.input<typeof SetShipmentCarrierInput>) {
  assertCan(actor.role, "orders.fulfill");
  const input = SetShipmentCarrierInput.parse(raw);
  // A name Shopify knows (also by its carrier word, e.g. "DPD Express" → DPD) is never made a custom courier.
  const company = input.custom
    ? (shopifyCompanyNamed(input.company) ?? knownShopifyCompany(input.company) ?? input.company)
    : shopifyCompanyNamed(input.company);
  if (!company) throw new DomainError("carrier_not_shopify");
  const template = input.urlTemplate ? TrackingTemplate.safeParse(input.urlTemplate) : null;
  if (template && !template.success) throw new DomainError("tracking_template_invalid");
  const accountId = actor.accountId;
  const scope = actor.companyScope;
  const result = await withAccountTransaction(accountId, async (tx) => {
    const shipment = await tx.fulfillment.findFirst({
      where: { accountId, id: input.fulfillmentId, orderId: input.orderId },
      select: {
        id: true,
        carrier: true,
        connectionId: true,
        order: { select: { id: true, companyId: true, countryCode: true } },
      },
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
    // A courier Shopify does not know is sent with our tracking link: saved for the name the write-back looks up
    // (the warehouse's, else the typed one) and for the typed name. A link or name already set for the group is
    // changed only by OWNER / ADMIN (Настройки → Линкове за проследяване); here it can only be added.
    const custom = !shopifyCompanyNamed(company);
    const canManage = can(actor.role, "stores.manage");
    let overwritten: { links: Record<string, string>; alias: string | null } = { links: {}, alias: null };
    if (custom) {
      const lookupKey = key ?? carrierKey(company);
      const keys = [...new Set([lookupKey, carrierKey(company)])];
      const existing = await tx.carrierTrackingLink.findMany({
        where: { accountId, carrierKey: { in: keys } },
        select: { carrierKey: true, urlTemplate: true },
      });
      const have = new Map(existing.map((e) => [e.carrierKey, e.urlTemplate]));
      const use = template?.success ? template.data : (have.get(lookupKey) ?? have.get(carrierKey(company)));
      if (!use) throw new DomainError("tracking_template_required");
      for (const k of keys) {
        const prev = have.get(k);
        if (prev === use) continue;
        if (prev !== undefined && !canManage) throw new DomainError("tracking_link_exists");
        if (prev !== undefined) overwritten.links[k] = prev;
        await tx.carrierTrackingLink.upsert({
          where: { accountId_carrierKey: { accountId, carrierKey: k } },
          create: {
            accountId,
            carrierKey: k,
            carrierName: (k === key && name ? name : company).slice(0, 200),
            urlTemplate: use,
            updatedById: actor.userId,
          },
          update: { urlTemplate: use, updatedById: actor.userId },
        });
      }
      // The typed name stands for itself from now on (a later shipment whose carrier is this name passes).
      const own = await tx.shopifyCarrierAlias.findUnique({
        where: { accountId_carrierKey: { accountId, carrierKey: carrierKey(company) } },
        select: { company: true },
      });
      if (own && own.company !== company && !canManage) throw new DomainError("carrier_alias_exists");
      overwritten = { ...overwritten, alias: own && own.company !== company ? own.company : null };
      if (!own || own.company !== company)
        await tx.shopifyCarrierAlias.upsert({
          where: { accountId_carrierKey: { accountId, carrierKey: carrierKey(company) } },
          create: {
            accountId,
            carrierKey: carrierKey(company),
            carrierName: company,
            company,
            updatedById: actor.userId,
          },
          update: { company, updatedById: actor.userId },
        });
    }
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
      // No carrier from the warehouse: this shipment's carrier is the company picked (a later warehouse name wins),
      // and the choice is remembered for this warehouse + destination country (owner request 2026-11-11: set once,
      // every shipment without a courier from there gets it — the ones waiting now and the next ones).
      await tx.fulfillment.updateMany({ where: { id: shipment.id, accountId }, data: { carrier: company } });
      // Per company too: a member of one company never sets the courier of another company's shipments.
      const ruleKey = noCarrierKey(
        shipment.connectionId,
        shipment.order.countryCode,
        shipment.order.companyId,
      );
      const rule = await tx.shopifyCarrierAlias.findUnique({
        where: { accountId_carrierKey: { accountId, carrierKey: ruleKey } },
        select: { company: true },
      });
      if (rule && rule.company !== company && !canManage) throw new DomainError("carrier_alias_exists");
      if (!rule || rule.company !== company)
        await tx.shopifyCarrierAlias.upsert({
          where: { accountId_carrierKey: { accountId, carrierKey: ruleKey } },
          create: {
            accountId,
            carrierKey: ruleKey,
            // Not shown as is (the settings page names warehouse, country and company).
            carrierName: `NOCARRIER ${shipment.order.countryCode ?? "-"}`,
            company,
            updatedById: actor.userId,
          },
          update: { company, updatedById: actor.userId },
        });
      before = rule?.company ?? null;
      if (rule && rule.company !== company) overwritten = { ...overwritten, alias: rule.company };
    }

    // Rows held for this shipment, and for the same courier name in the person's companies (the sweep releases
    // the others within minutes, now that the name has a company).
    const rows = await tx.shopifyWriteBack.findMany({
      where: {
        accountId,
        ...held,
        ...(scope ? { order: { companyId: { in: scope } } } : {}),
      },
      select: {
        id: true,
        orderId: true,
        fulfillmentId: true,
        order: { select: { countryCode: true, companyId: true } },
        fulfillment: { select: { carrier: true, connectionId: true } },
      },
    });
    const sameNoCarrier = (r: (typeof rows)[number]) =>
      !name &&
      !r.fulfillment.carrier?.trim() &&
      r.fulfillment.connectionId === shipment.connectionId &&
      r.order.companyId === shipment.order.companyId &&
      (r.order.countryCode ?? "").toUpperCase() === (shipment.order.countryCode ?? "").toUpperCase();
    const release = rows.filter(
      (r) =>
        r.fulfillmentId === shipment.id ||
        (key !== null && !!r.fulfillment.carrier && carrierKey(r.fulfillment.carrier) === key) ||
        sameNoCarrier(r),
    );
    // The other shipments without a courier from the same warehouse and country take the courier now too.
    const others = release.filter((r) => r.fulfillmentId !== shipment.id && sameNoCarrier(r));
    if (others.length)
      await tx.fulfillment.updateMany({
        where: {
          accountId,
          id: { in: others.map((r) => r.fulfillmentId) },
          // Blank as read (null, "" or spaces): a name the warehouse sent meanwhile is kept.
          OR: [
            { carrier: null },
            { carrier: { in: [...new Set(others.map((r) => r.fulfillment.carrier ?? ""))] } },
          ],
        },
        data: { carrier: company },
      });
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
        after: {
          company,
          released: release.length,
          remembered: !!key || !name,
          custom,
          urlTemplate: template?.success ? template.data : null,
          overwritten,
        },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent?.slice(0, 300) ?? null,
      },
    });
    return { company, released: release.length, orders: [...new Set(release.map((r) => r.orderId))] };
  });
  await resolveCarrierTasks(accountId, result.orders);
  return { company: result.company, released: result.released };
}
