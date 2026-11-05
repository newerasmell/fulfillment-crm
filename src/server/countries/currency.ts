/**
 * Local (legal-tender) currency per destination country (owner report 2026-11-05: a COD order to GR stopped with
 * "no setting for GR" although Greece obviously uses EUR). Used when the group has no own setting for the country
 * (Настройки → Държави); a stored setting always wins. COD and declared value go to the vendors in this currency
 * (CLAUDE.md) — nothing here converts amounts.
 */
export const DEFAULT_LOCAL_CURRENCY: Readonly<Record<string, string>> = Object.freeze({
  // Euro area (Bulgaria since 2026-01-01).
  AT: "EUR",
  BE: "EUR",
  BG: "EUR",
  CY: "EUR",
  DE: "EUR",
  EE: "EUR",
  ES: "EUR",
  FI: "EUR",
  FR: "EUR",
  GR: "EUR",
  HR: "EUR",
  IE: "EUR",
  IT: "EUR",
  LT: "EUR",
  LU: "EUR",
  LV: "EUR",
  MT: "EUR",
  NL: "EUR",
  PT: "EUR",
  SI: "EUR",
  SK: "EUR",
  // Own currencies.
  CZ: "CZK",
  DK: "DKK",
  HU: "HUF",
  PL: "PLN",
  RO: "RON",
  SE: "SEK",
});

/** The country's local currency: the group's own setting, else the built-in default, else null (unknown). */
export function localCurrencyFor(
  setting: { currency?: string | null } | null | undefined,
  country: string | null | undefined,
): string | null {
  const own = setting?.currency?.trim().toUpperCase();
  if (own) return own;
  return country ? (DEFAULT_LOCAL_CURRENCY[country.trim().toUpperCase()] ?? null) : null;
}
