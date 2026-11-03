import { customPhoneRule, hasBuiltinPhoneRule, type PhoneRule } from "@/integrations/eushipments/phone";
import { can } from "@/server/auth/rbac";
import type { Finding } from "@/server/checks/findings";
import { accountDb } from "@/server/db/client";
import { weightSuggestions, type WeightSuggestion } from "@/server/products/weights";
import type { ScopedActor } from "@/server/stores";
import { suggestPhoneRule } from "./phone-rules";

/**
 * What the order screen needs to fix a finding AT THE SOURCE (2026-11-03): a phone finding of a country without
 * a rule in the euShipments guideline → "Добави правило за <CC>" (OWNER/ADMIN); weight_missing → "Въведи тегло"
 * per product. Reads only.
 */

export const PHONE_FINDING_CODES = new Set([
  "eushipments.phone_invalid",
  "order.phone_invalid",
  "fhb.contact.phone_invalid",
]);
export const WEIGHT_FINDING_CODE = "eushipments.weight_missing";

/** `product:<id>.weightGrams` → the product id (null for an unlinked line). */
export function productOfWeightFinding(f: Pick<Finding, "code" | "field">): string | null {
  if (f.code !== WEIGHT_FINDING_CODE || !f.field) return null;
  return /^product:([^.]+)\.weightGrams$/.exec(f.field)?.[1] ?? null;
}

export interface PhoneFix {
  country: string;
  initial: PhoneRule;
  samplePhone: string | null;
  needsCurrency: boolean;
  defaultCurrency: string | null;
  hasCustom: boolean;
}

export interface WeightFix {
  productId: string;
  label: string;
  current: number | null;
  suggestions: WeightSuggestion[];
  shopifyAllowed: boolean;
}

export async function orderSourceFixes(
  actor: ScopedActor,
  order: {
    phone: string | null;
    currency: string;
    countryCode: string | null;
    shippingAddress: unknown;
  },
  findings: readonly Finding[],
): Promise<{ phone: PhoneFix | null; weights: Map<string, WeightFix> }> {
  const db = accountDb(actor.accountId);
  const addr = (order.shippingAddress ?? {}) as { countryCode?: string | null; phone?: string | null };
  const country = (addr.countryCode ?? order.countryCode ?? "").toUpperCase();
  let phone: PhoneFix | null = null;
  if (
    can(actor.role, "countries.manage") &&
    /^[A-Z]{2}$/.test(country) &&
    !hasBuiltinPhoneRule(country) &&
    findings.some((f) => PHONE_FINDING_CODES.has(f.code))
  ) {
    const setting = await db.countrySetting.findUnique({
      where: { accountId_country: { accountId: actor.accountId, country } },
    });
    const custom = customPhoneRule(setting?.phoneRules);
    const sample = order.phone ?? addr.phone ?? null;
    phone = {
      country,
      initial: custom ??
        suggestPhoneRule(sample, country) ?? { style: "international", cc: "", trunk: "", lengths: [8] },
      samplePhone: sample,
      needsCurrency: !setting,
      defaultCurrency: setting?.currency ?? order.currency,
      hasCustom: !!custom,
    };
  }

  const weights = new Map<string, WeightFix>();
  const ids = [...new Set(findings.map(productOfWeightFinding).filter((x): x is string => !!x))];
  if (ids.length && can(actor.role, "products.weight")) {
    const [products, sugg, links] = await Promise.all([
      db.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, sku: true, name: true, weightGrams: true },
      }),
      weightSuggestions(actor.accountId, ids),
      db.storeVariantLink.findMany({
        where: {
          productId: { in: ids },
          ...(actor.companyScope ? { store: { companyId: { in: actor.companyScope } } } : {}),
        },
        select: { productId: true, store: { select: { weightWriteMode: true } } },
      }),
    ]);
    for (const p of products)
      weights.set(p.id, {
        productId: p.id,
        label: `${p.sku} · ${p.name}`,
        current: p.weightGrams,
        suggestions: sugg.get(p.id) ?? [],
        shopifyAllowed: links.some((l) => l.productId === p.id && l.store.weightWriteMode !== "DISABLED"),
      });
  }
  return { phone, weights };
}
