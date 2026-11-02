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

type Rule =
  | { style: "national"; cc: string; trunk: string; lengths: number[] }
  | { style: "international"; cc: string; trunk: string; lengths: number[] };

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

export function normalisePhone(
  raw: string | null | undefined,
  country: string | null | undefined,
): PhoneResult {
  const original = (raw ?? "").trim();
  if (!original) return { ok: false, original, reason: "empty" };
  const cc = (country ?? "").toUpperCase();
  const rule = PHONE_RULES[cc];
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
        reason: OTHER_CODES.some((c) => intl.startsWith(c)) ? "foreign_number" : "wrong_length",
      };
    }
    nsn = intl.slice(rule.cc.length);
  } else if (
    compact.startsWith(rule.cc) &&
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
