import { z } from "zod";
import {
  customPhoneRule,
  hasBuiltinPhoneRule,
  normalisePhone,
  PHONE_RULES,
  PhoneRuleSchema,
  type PhoneResult,
  type PhoneRule,
} from "@/integrations/eushipments/phone";
import { callingCodeOf, normalisePhoneE164 } from "@/integrations/fhb-v3/phone";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import {
  ordersToCountry,
  recheckOpenOrders,
  type EnqueueCheck,
  type RecheckResult,
} from "@/server/checks/recheck";
import { accountDb } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";

/**
 * Per-country settings of the group (Настройки → Държави): local currency and the group's OWN phone rule.
 * The euShipments guideline documents phone formats for eight countries (INTEGRATION_NOTES §4.4) — those
 * built-in rules always win and are shown read-only. A custom rule only fills a country the guideline does not
 * document (e.g. CY); it must be confirmed with the warehouse, because nothing in the vendor docs backs it.
 * Saving a rule re-runs the checks of every open order of the group to that country.
 */

const Country = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/);
const Currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/);

export const CountrySettingInput = z.object({
  country: Country,
  /** Required only when the country has no setting yet (CountrySetting.currency is mandatory). */
  currency: Currency.optional(),
  /** null = remove the custom rule. */
  rule: PhoneRuleSchema.nullable(),
});

export interface CountryRow {
  country: string;
  currency: string | null;
  builtin: PhoneRule | null;
  custom: PhoneRule | null;
  /** True when a custom rule is stored but a built-in rule exists (it is ignored). */
  customIgnored: boolean;
}

/** Every country with a setting or a built-in rule, sorted. */
export async function listCountries(actor: ScopedActor): Promise<CountryRow[]> {
  assertCan(actor.role, "account.read");
  const rows = await accountDb(actor.accountId).countrySetting.findMany({ orderBy: { country: "asc" } });
  const byCountry = new Map(rows.map((r) => [r.country.toUpperCase(), r]));
  const all = new Set([...Object.keys(PHONE_RULES), ...byCountry.keys()]);
  return [...all].sort().map((country) => {
    const s = byCountry.get(country);
    const custom = customPhoneRule(s?.phoneRules);
    const builtin = PHONE_RULES[country] ?? null;
    return { country, currency: s?.currency ?? null, builtin, custom, customIgnored: !!builtin && !!custom };
  });
}

/**
 * A starting point for the form from an order's phone (+357 99 123456 → international, cc 357, 8 digits). The
 * calling code comes from the public ITU table; without a recognisable prefix the national digits are counted.
 */
export function suggestPhoneRule(rawPhone: string | null | undefined, country: string): PhoneRule | null {
  const cc = callingCodeOf(country);
  if (!cc) return null;
  const compact = (rawPhone ?? "").replace(/[\s\u00A0().\-/]/g, "");
  if (!/^\+?\d+$/.test(compact)) return { style: "international", cc, trunk: "", lengths: [8] };
  let nsn = compact;
  if (nsn.startsWith("+")) nsn = nsn.slice(1);
  else if (nsn.startsWith("00")) nsn = nsn.slice(2);
  if (nsn.startsWith(cc) && nsn.length - cc.length >= 6) nsn = nsn.slice(cc.length);
  const length = Math.min(13, Math.max(4, nsn.length));
  return { style: "international", cc, trunk: "", lengths: [length] };
}

export interface PhonePreview {
  euShipments: PhoneResult;
  /** E.164 as FHB / Joy would get it. */
  fhb: string | null;
}

/** How a phone would be sent with this rule (both vendors), without saving anything. */
export function previewPhoneRule(
  rule: PhoneRule | null,
  rawPhone: string | null | undefined,
  country: string,
): PhonePreview {
  return {
    euShipments: normalisePhone(rawPhone, country, rule),
    fhb: normalisePhoneE164(rawPhone, country, rule),
  };
}

export interface SaveCountryResult {
  country: string;
  rule: PhoneRule | null;
  recheck: RecheckResult;
}

export async function saveCountrySetting(
  actor: ScopedActor,
  raw: z.input<typeof CountrySettingInput>,
  deps: { enqueue?: EnqueueCheck } = {},
): Promise<SaveCountryResult> {
  assertCan(actor.role, "countries.manage");
  const input = CountrySettingInput.parse(raw);
  if (input.rule && hasBuiltinPhoneRule(input.country)) throw new DomainError("builtin_phone_rule");
  const rule = input.rule ? customPhoneRule(input.rule) : null;
  const db = accountDb(actor.accountId);
  const before = await db.countrySetting.findUnique({
    where: { accountId_country: { accountId: actor.accountId, country: input.country } },
  });
  if (!before && !input.currency) throw new DomainError("currency_required");
  const data = {
    phoneRules: (rule ?? {}) as object,
    ...(input.currency ? { currency: input.currency } : {}),
  };
  const after = before
    ? await db.countrySetting.update({ where: { id: before.id }, data })
    : await db.countrySetting.create({
        data: {
          accountId: actor.accountId,
          country: input.country,
          currency: input.currency!,
          phoneRules: data.phoneRules,
        },
      });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "country.settings",
    entityType: "CountrySetting",
    entityId: after.id,
    before: before ? { currency: before.currency, phoneRules: before.phoneRules } : null,
    after: { country: input.country, currency: after.currency, phoneRules: after.phoneRules },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  const recheck = await recheckOpenOrders(actor.accountId, ordersToCountry(input.country), {
    actor: { kind: "user", userId: actor.userId },
    enqueue: deps.enqueue,
  });
  return { country: input.country, rule, recheck };
}
