/**
 * Recipient phone normaliser per destination country — euShipments "Shipment creation guidelines → Phone
 * format requirements" (INTEGRATION_NOTES §4.4):
 *   RO, BG, GR, PL — national number WITHOUT the country prefix;
 *   CZ +420, HU +36, SK +421, HR +385 — country prefix + 9-digit mobile number;
 *   never two prefixes (HU: strip the national "06" first: 06 30 123 4567 → +36301234567).
 * We store the original and send the normalised value; both are shown in the UI.
 *
 * National formats used for the "without prefix" countries: BG and RO keep their trunk "0" (the spec's own BG
 * example is "0889000000"); GR and PL have no trunk prefix (10 and 9 digits).
 */

import { z } from "zod";

export type PhoneRule =
  | { style: "national"; cc: string; trunk: string; lengths: number[] }
  | { style: "international"; cc: string; trunk: string; lengths: number[] };
type Rule = PhoneRule;

/**
 * A group's own rule for a country the euShipments guideline does not document (CountrySetting.phoneRules,
 * Настройки → Държави). Same shape as the built-in rules. Built-in rules ALWAYS win for their countries.
 */
export const PhoneRuleSchema = z
  .object({
    style: z.enum(["national", "international"]),
    cc: z.string().regex(/^[1-9]\d{0,3}$/),
    trunk: z.string().regex(/^\d{0,2}$/),
    lengths: z.array(z.number().int().min(4).max(13)).min(1).max(4),
  })
  .strict();

/** The custom rule stored on a CountrySetting (`{}` = none; anything malformed is ignored, never thrown). */
export function customPhoneRule(json: unknown): PhoneRule | null {
  if (!json || typeof json !== "object" || Object.keys(json).length === 0) return null;
  const r = PhoneRuleSchema.safeParse(json);
  return r.success ? { ...r.data, lengths: [...new Set(r.data.lengths)].sort((a, b) => a - b) } : null;
}

/**
 * The rule normalisePhone uses for a country: the group's own rule when it set one (owner decision 2026-11-06: ACS
 * Greece confirmed through euShipments that numbers with +30 are accepted and passed on unchanged, so a group may
 * replace the guideline's format), else the built-in one from the vendor guideline.
 */
export function effectivePhoneRule(
  country: string | null | undefined,
  custom?: PhoneRule | null,
): { rule: PhoneRule; source: "builtin" | "custom" } | null {
  const cc = (country ?? "").toUpperCase();
  if (custom) return { rule: custom, source: "custom" };
  const builtin = PHONE_RULES[cc];
  return builtin ? { rule: builtin, source: "builtin" } : null;
}

export const hasBuiltinPhoneRule = (country: string | null | undefined) =>
  !!PHONE_RULES[(country ?? "").toUpperCase()];

export const PHONE_RULES: Readonly<Record<string, Rule>> = {
  BG: { style: "national", cc: "359", trunk: "0", lengths: [8, 9] },
  RO: { style: "national", cc: "40", trunk: "0", lengths: [9] },
  GR: { style: "national", cc: "30", trunk: "", lengths: [10] },
  PL: { style: "national", cc: "48", trunk: "", lengths: [9] },
  CZ: { style: "international", cc: "420", trunk: "", lengths: [9] },
  HU: { style: "international", cc: "36", trunk: "06", lengths: [9] },
  SK: { style: "international", cc: "421", trunk: "0", lengths: [9] },
  HR: { style: "international", cc: "385", trunk: "0", lengths: [9] },
};

/** Country calling codes we recognise as "some other country" (to refuse a foreign number). */
const OTHER_CODES = [
  "359",
  "40",
  "30",
  "48",
  "420",
  "36",
  "421",
  "385",
  "43",
  "49",
  "386",
  "381",
  "90",
  "380",
];

export type PhoneResult =
  | { ok: true; value: string; original: string; changed: boolean }
  | {
      ok: false;
      original: string;
      reason: "empty" | "invalid_characters" | "foreign_number" | "wrong_length" | "no_rule";
    };

/**
 * `custom`: the group's own rule for this country (CountrySetting.phoneRules). It only applies to a country
 * without a built-in rule — the vendor guideline's eight countries can never be changed by a setting.
 */
export function normalisePhone(
  raw: string | null | undefined,
  country: string | null | undefined,
  custom?: PhoneRule | null,
): PhoneResult {
  const original = (raw ?? "").trim();
  if (!original) return { ok: false, original, reason: "empty" };
  const rule = effectivePhoneRule(country, custom)?.rule;
  if (!rule) return { ok: false, original, reason: "no_rule" };

  // Visual separators only; anything else (letters, extensions) is not a phone we can send.
  const compact = original.replace(/[\s\u00A0().\-/]/g, "");
  if (!/^\+?\d+$/.test(compact)) return { ok: false, original, reason: "invalid_characters" };

  let intl: string | null = null; // digits after the country calling code, if one was given
  if (compact.startsWith("+")) intl = compact.slice(1);
  else if (compact.startsWith("00")) intl = compact.slice(2);

  let nsn: string;
  if (intl !== null) {
    if (!intl.startsWith(rule.cc)) {
      return {
        ok: false,
        original,
        reason: OTHER_CODES.some((c) => c !== rule.cc && intl.startsWith(c))
          ? "foreign_number"
          : "wrong_length",
      };
    }
    nsn = intl.slice(rule.cc.length);
  } else if (
    compact.startsWith(rule.cc) &&
    // A national number that merely begins with the code's digits stays national (owner report 2026-11-11:
    // the Italian mobile 3927838955 begins with "39").
    !rule.lengths.includes(compact.length) &&
    rule.lengths.some(
      (l) =>
        compact.length === rule.cc.length + l || compact.length === rule.cc.length + rule.trunk.length + l,
    )
  ) {
    // Country code typed without "+"/"00" (e.g. 359888123456).
    nsn = compact.slice(rule.cc.length);
  } else {
    nsn = compact;
  }
  // A national trunk prefix (national form, or doubled after the country code: +36 06…, +359 0…). No
  // national significant number of these countries starts with its trunk prefix, so stripping is safe.
  if (rule.trunk && nsn.startsWith(rule.trunk)) {
    nsn = nsn.slice(rule.trunk.length);
  }
  if (!rule.lengths.includes(nsn.length)) return { ok: false, original, reason: "wrong_length" };

  const value = rule.style === "national" ? `${rule.trunk}${nsn}` : `+${rule.cc}${nsn}`;
  return { ok: true, value, original, changed: value !== original };
}
