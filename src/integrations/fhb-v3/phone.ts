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

/** National trunk prefix dropped before the calling code. Countries absent here have none (IT keeps its 0). */
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
  LT: "8",
  NL: "0",
  RO: "0",
  RS: "0",
  SE: "0",
  SI: "0",
  SK: "0",
  UA: "0",
});

export const callingCodeOf = (country: string | null | undefined) =>
  country ? (CALLING_CODES[country.toUpperCase()] ?? null) : null;

/**
 * Returns the E.164 form (`+` and 8–15 digits), or null when the number cannot be made international with
 * confidence. Never adds a second prefix: a number that already carries the country code keeps it.
 */
export function normalisePhoneE164(raw: string | null | undefined, country: string | null | undefined) {
  if (!raw) return null;
  let s = raw.trim().replace(/[\s\-()./]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  const cc = callingCodeOf(country);
  const trunk = country ? TRUNK[country.toUpperCase()] : undefined;
  let digits: string;
  if (s.startsWith("+")) {
    digits = s.slice(1);
    if (!/^\d+$/.test(digits)) return null;
    // "+359 0888…": a trunk 0 kept after the country code by mistake.
    if (cc && trunk === "0" && digits.startsWith(`${cc}0`)) digits = cc + digits.slice(cc.length + 1);
  } else {
    if (!/^\d+$/.test(s) || !cc) return null;
    if (trunk && s.startsWith(trunk)) digits = cc + s.slice(trunk.length);
    else if (s.startsWith(cc) && s.length - cc.length >= 8) digits = s;
    else digits = cc + s;
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}
