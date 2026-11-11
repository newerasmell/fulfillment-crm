/**
 * Speedy office addresses from the Shopify checkout (owner request 2026-11-11). The checkout writes the chosen office
 * into the shipping address line 1 as
 *   `Office Speedy [<speedy id>] <OFFICE NAME>: <address>, <city>, <zip>, BG`
 * In the euShipments cabinet the office is picked by that name (e.g. "ПЛЕВЕН - САН СТЕФАНО (УЛ.)"); through the API
 * it is `recipient.officeId` = the office's ID in euShipments' office list (GET /offices-by-courier), whose
 * COURIER_OFFICE_ID is the courier's own office id. Pure functions only.
 */

export interface ParsedSpeedyOffice {
  speedyId: number;
  officeName: string;
  addressPart: string;
}

const PATTERN = /^\s*office\s+speedy\s*\[\s*(\d+)\s*\]\s*([^:]+?)\s*:\s*(.*)$/iu;

/** `Office Speedy [864] NAME: rest` → its parts; anything else (an ordinary address) → null. */
export function parseSpeedyOffice(raw: string | null | undefined): ParsedSpeedyOffice | null {
  const m = PATTERN.exec(raw ?? "");
  if (!m) return null;
  const speedyId = Number(m[1]);
  const officeName = m[2]!.replace(/\s+/g, " ").trim();
  if (!Number.isSafeInteger(speedyId) || speedyId <= 0 || !officeName) return null;
  return { speedyId, officeName, addressPart: m[3]!.replace(/\s+/g, " ").trim() };
}

/** Latin letters that look like Cyrillic ones, written by mistake in an office name. */
const LOOKALIKE: Readonly<Record<string, string>> = {
  A: "А",
  B: "В",
  C: "С",
  E: "Е",
  H: "Н",
  K: "К",
  M: "М",
  O: "О",
  P: "Р",
  T: "Т",
  X: "Х",
  Y: "У",
};

/** For comparing office names: upper case, one space, one kind of dash, Latin look-alikes as Cyrillic. */
export function normaliseOfficeName(name: string) {
  const upper = name
    .normalize("NFC")
    .toUpperCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
  // Look-alikes only in a name that has Cyrillic in it (a Latin-only name stays Latin).
  if (!/[Ѐ-ӿ]/.test(upper)) return upper;
  return upper.replace(/[ABCEHKMOPTXY]/g, (c) => LOOKALIKE[c] ?? c);
}

export interface OfficeCandidate {
  officeId: number;
  courierOfficeId: number | null;
  name: string;
}

export type OfficeMatch<T extends OfficeCandidate> =
  | { kind: "matched"; office: T; by: "speedy_id" | "name" }
  | { kind: "ambiguous"; offices: T[] }
  | { kind: "none" };

/**
 * The ONE office of the list that is this address: by the courier's own id first, then by the exact name after
 * normalisation. Two or more candidates, or none → never chosen automatically.
 */
export function matchSpeedyOffice<T extends OfficeCandidate>(
  parsed: ParsedSpeedyOffice,
  offices: readonly T[],
): OfficeMatch<T> {
  const byId = offices.filter((o) => o.courierOfficeId === parsed.speedyId);
  if (byId.length === 1) {
    // The id and the name must not contradict each other.
    if (normaliseOfficeName(byId[0]!.name) === normaliseOfficeName(parsed.officeName))
      return { kind: "matched", office: byId[0]!, by: "speedy_id" };
  }
  if (byId.length > 1) return { kind: "ambiguous", offices: byId };
  const want = normaliseOfficeName(parsed.officeName);
  const byName = offices.filter((o) => normaliseOfficeName(o.name) === want);
  if (byName.length === 1) {
    // Found by name, but the courier id says another office: a person decides.
    const other = byId[0];
    if (other && other.officeId !== byName[0]!.officeId)
      return { kind: "ambiguous", offices: [other, byName[0]!] };
    return { kind: "matched", office: byName[0]!, by: "name" };
  }
  if (byName.length > 1) return { kind: "ambiguous", offices: byName };
  return byId.length === 1 ? { kind: "ambiguous", offices: byId } : { kind: "none" };
}
