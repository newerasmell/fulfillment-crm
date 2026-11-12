/**
 * Phone → E.164 for FHB (`recipient.contact.phone`: "INTERNATIONAL format", max 20; INTEGRATION_NOTES §2.3).
 * The country calling codes and national trunk prefixes are public ITU numbering facts, not vendor data.
 * euShipments has different per-country rules (§4.4) and its own normaliser.
 */

const CALLING_CODES: Readonly<Record<string, string>> = Object.freeze({
  AT: "43",
  BE: "32",
  BG: "359",
  CH: "41",
  CY: "357",
  CZ: "420",
  DE: "49",
  DK: "45",
  EE: "372",
  ES: "34",
  FI: "358",
  FR: "33",
  GB: "44",
  GR: "30",
  HR: "385",
  HU: "36",
  IE: "353",
  IT: "39",
  LT: "370",
  LU: "352",
  LV: "371",
  MT: "356",
  NL: "31",
  NO: "47",
  PL: "48",
  PT: "351",
  RO: "40",
  RS: "381",
  SE: "46",
  SI: "386",
  SK: "421",
  UA: "380",
});

/**
 * National trunk prefix(es) dropped before the calling code ("0,8": several, the longest match first). Countries
 * absent here have none (IT keeps its 0).
 */
const TRUNK: Readonly<Record<string, string>> = Object.freeze({
  AT: "0",
  BE: "0",
  BG: "0",
  CH: "0",
  DE: "0",
  FI: "0",
  FR: "0",
  GB: "0",
  HR: "0",
  HU: "06",
  IE: "0",
  // Lithuania changed its national prefix from 8 to 0 in 2025; numbers come written both ways (owner report
  // 2026-11-12).
  LT: "0,8",
  NL: "0",
  RO: "0",
  RS: "0",
  SE: "0",
  SI: "0",
  SK: "0",
  UA: "0",
});

/**
 * Countries WITHOUT a trunk prefix: the longest national number, as people write it (owner report 2026-11-11: the
 * Italian mobile 392 783 8955 begins with "39", Italy's code, and went out as +392 783 8955). In these countries a
 * national number is written without a leading 0, so it can begin with the code's digits; a number of at most this
 * length is national, a longer one already carries the code. Countries with a trunk prefix (DE, AT, BG…) write
 * national numbers with it ("0…"), so there a number beginning with the code is international.
 */
const NATIONAL_MAX: Readonly<Record<string, number>> = Object.freeze({
  CY: 8,
  CZ: 9,
  DK: 8,
  EE: 8,
  ES: 9,
  GR: 10,
  IT: 10,
  // LU landlines can reach 11 digits; 9 (mobiles 6xx…) is a deliberate heuristic, not the ITU maximum.
  LU: 9,
  LV: 8,
  MT: 8,
  NO: 8,
  PL: 9,
  PT: 9,
});

/**
 * National number length of countries with several national prefixes (LT: 8 until 2025, 0 since — owner report
 * 2026-11-12): a prefix written after "+370" is dropped, and a number of another length is refused (a typo is never
 * sent as an impossible number).
 */
const NSN_LENGTH: Readonly<Record<string, number>> = Object.freeze({ LT: 8 });

/** A group's own rule without a trunk prefix: national numbers of up to 10 digits stay national. */
const DEFAULT_NATIONAL_MAX = 10;

/** Countries with a known calling code, and those without a trunk prefix (for tests). */
export const KNOWN_PHONE_COUNTRIES = Object.keys(CALLING_CODES);
export const NO_TRUNK_COUNTRIES = Object.keys(NATIONAL_MAX);
export const nationalMaxOf = (country: string) => NATIONAL_MAX[country.toUpperCase()] ?? DEFAULT_NATIONAL_MAX;

export const callingCodeOf = (country: string | null | undefined) =>
  country ? (CALLING_CODES[country.toUpperCase()] ?? null) : null;

/**
 * Returns the E.164 form (`+` and 8–15 digits), or null when the number cannot be made international with
 * confidence. Never adds a second prefix: a number that already carries the country code keeps it.
 */
export function normalisePhoneE164(
  raw: string | null | undefined,
  country: string | null | undefined,
  /** The group's own phone rule for the country (CountrySetting.phoneRules): used only for a country this
   *  table does not know — its calling code and trunk prefix. The ITU table above always wins. */
  custom?: { cc: string; trunk: string } | null,
) {
  if (!raw) return null;
  let s = raw.trim().replace(/[\s\-()./]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  const known = callingCodeOf(country);
  const cc = known ?? custom?.cc ?? null;
  const trunk = known ? (country ? TRUNK[country.toUpperCase()] : undefined) : custom?.trunk || undefined;
  // Same parsing as the euShipments rule's trunksOf (kept here so this adapter does not import from euShipments).
  const trunks = (trunk ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  let digits: string;
  if (s.startsWith("+")) {
    digits = s.slice(1);
    if (!/^\d+$/.test(digits)) return null;
    // "+359 0888…": a trunk 0 kept after the country code by mistake.
    if (cc && trunks.includes("0") && digits.startsWith(`${cc}0`)) digits = cc + digits.slice(cc.length + 1);
  } else {
    if (!/^\d+$/.test(s) || !cc) return null;
    const lead = [...trunks].sort((a, b) => b.length - a.length).find((t) => s.startsWith(t));
    if (lead) digits = cc + s.slice(lead.length);
    else if (
      s.startsWith(cc) &&
      s.length - cc.length >= 8 &&
      // Without a trunk prefix, a national number may begin with the code's digits: it stays national.
      !(!trunks.length && s.length <= (known && country ? nationalMaxOf(country) : DEFAULT_NATIONAL_MAX))
    )
      digits = s;
    else digits = cc + s;
  }
  const nsnLength = known && country ? NSN_LENGTH[country.toUpperCase()] : undefined;
  if (nsnLength && cc && digits.startsWith(cc)) {
    let rest = digits.slice(cc.length);
    const lead = trunks.find((t) => rest.startsWith(t) && rest.length - t.length === nsnLength);
    if (lead) rest = rest.slice(lead.length);
    if (rest.length !== nsnLength) return null;
    digits = cc + rest;
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}
