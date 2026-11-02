import type { CrmOrderStatus } from "@/generated/prisma/client";

/**
 * euShipments status mapping (INTEGRATION_NOTES §4.5). Mapping is by the STATUS TEXT — `statusesHistory[].ID`
 * is a record id, not a status id. Texts are normalised first (the spec itself writes "Оn hold" with a
 * Cyrillic О). The seed below is the spec's full list ("current as of July 2026", Orders_History v1.0) with
 * its "final" flags; it is copied into a per-account DB table (EushipmentsStatusMapping) so operators can
 * extend it. Anything unmapped is UNKNOWN + alert, never an exception.
 */

export const EU_STATUS_CATEGORIES = [
  "ACCEPTED",
  "PROCESSING",
  "IN_TRANSIT",
  "DELIVERED",
  "RETURNING",
  "RETURN_RECEIVED",
  "CANCELLED",
  "CANCEL_PENDING",
  "BLOCKED",
  "EXCEPTION",
  "UNKNOWN",
] as const;
export type EuStatusCategory = (typeof EU_STATUS_CATEGORIES)[number];

/**
 * CRM status per category. IN_TRANSIT → SHIPPED (the CRM pipeline has no separate in-transit state).
 * CANCEL_PENDING has no CRM status: the shipment keeps its previous status and polling continues.
 */
export const CRM_STATUS: Record<EuStatusCategory, CrmOrderStatus | null> = {
  ACCEPTED: "ACCEPTED",
  PROCESSING: "PROCESSING",
  IN_TRANSIT: "SHIPPED",
  DELIVERED: "DELIVERED",
  RETURNING: "RETURNING",
  RETURN_RECEIVED: "RETURN_RECEIVED",
  CANCELLED: "CANCELLED",
  CANCEL_PENDING: null,
  BLOCKED: "BLOCKED",
  EXCEPTION: "EXCEPTION",
  UNKNOWN: "UNKNOWN",
};

export type EuAlertKind =
  | "blocked" // immediate, operator task
  | "return_received" // notify support (closes "was the return physically received?")
  | "exception"
  | "unknown_status"
  | "delivery_attempt_failed"; // warn

/** Alert raised when a shipment ENTERS this status (the ACCEPTED time threshold is checked separately). */
export function alertFor(category: EuStatusCategory, key: string): EuAlertKind | null {
  switch (category) {
    case "BLOCKED":
      return "blocked";
    case "RETURN_RECEIVED":
      return "return_received";
    case "EXCEPTION":
      return "exception";
    case "UNKNOWN":
      return "unknown_status";
    case "IN_TRANSIT":
      return key === UNSUCCESSFUL_ATTEMPT ? "delivery_attempt_failed" : null;
    default:
      return null;
  }
}

// ───────────────────────── normalisation ─────────────────────────

/** Cyrillic (and Greek) letters that look like Latin ones. */
const LOOKALIKES: Record<string, string> = {
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", У: "Y", І: "I", Ј: "J", Ѕ: "S",
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", к: "k", м: "m", т: "t", н: "h",
  Α: "A", Β: "B", Ε: "E", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Χ: "X", Υ: "Y", ο: "o",
}; // prettier-ignore
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKES).join("")}]`, "g");
/** Hyphen-like characters: hyphen, non-breaking hyphen, figure dash, en/em dash, bar, minus, small/fullwidth. */
const DASHES_RE = /[‐‑‒–—―−﹘﹣－]/g;

/** Matching key for a STATUS text: look-alikes → Latin, dashes unified, whitespace collapsed, lowercase. */
export function normaliseStatusText(text: string): string {
  return text
    .normalize("NFC")
    .replace(LOOKALIKE_RE, (c) => LOOKALIKES[c] ?? c)
    .replace(DASHES_RE, "-")
    .replace(/[\s\u00A0]+/g, " ")
    .replace(/\s*-\s*/g, " - ")
    .trim()
    .toLowerCase();
}

const UNSUCCESSFUL_ATTEMPT = normaliseStatusText("Unsuccessful delivery attempt");

// ───────────────────────── seed ─────────────────────────

export interface SeedStatus {
  id: number;
  text: string;
  final: boolean;
  category: EuStatusCategory;
}

const s = (id: number, text: string, final: boolean, category: EuStatusCategory): SeedStatus => ({
  id,
  text,
  final,
  category,
});

/** Spec list with "Final Status" flags; categories from INTEGRATION_NOTES §4.5. */
export const SEED_STATUSES: readonly SeedStatus[] = [
  s(1, "On delivery", false, "IN_TRANSIT"),
  s(2, "In transit", false, "IN_TRANSIT"),
  s(3, "Delivered", true, "DELIVERED"),
  s(4, "Returned", true, "RETURNING"),
  s(5, "In the office", false, "IN_TRANSIT"),
  s(6, "COD paid", true, "DELIVERED"),
  s(7, "New", false, "ACCEPTED"),
  s(8, "Cancelled", true, "CANCELLED"),
  s(11, "Stockout", false, "BLOCKED"),
  s(13, "Lost shipment", true, "EXCEPTION"),
  s(14, "Redirected", false, "IN_TRANSIT"),
  s(15, "Deleted", true, "CANCELLED"),
  s(16, "Warehouse Ruse", false, "IN_TRANSIT"),
  s(17, "Returning", false, "RETURNING"),
  s(18, "Scanned Waybill", false, "PROCESSING"),
  s(19, "Packed", false, "PROCESSING"),
  s(20, "Information received", false, "ACCEPTED"),
  s(21, "Awaiting pickup", false, "ACCEPTED"),
  s(22, "Insufficient data - AWB not created", false, "BLOCKED"),
  s(23, "Information sent to warehouse", false, "ACCEPTED"),
  s(24, "Compensation paid", true, "EXCEPTION"),
  s(25, "Claim opened", true, "EXCEPTION"),
  s(26, "Warehouse", false, "IN_TRANSIT"),
  s(27, "Damaged shipment", true, "EXCEPTION"),
  s(28, "PreAlert", false, "ACCEPTED"),
  s(29, "Destroyed", true, "EXCEPTION"),
  s(30, "Warehouse Budapest", false, "IN_TRANSIT"),
  s(31, "Lastmile Accept", false, "PROCESSING"),
  s(32, "Warehouse Sofia", false, "IN_TRANSIT"),
  s(33, "Warehouse Zagreb", false, "IN_TRANSIT"),
  s(34, "Returned to Warehouse", true, "RETURN_RECEIVED"),
  s(35, "Rejected by courier", true, "EXCEPTION"),
  s(36, "Returned to Client", true, "RETURN_RECEIVED"),
  s(37, "Оn hold", false, "BLOCKED"), // Cyrillic О, exactly as in the spec
  s(38, "Cancel", false, "CANCEL_PENDING"),
  s(39, "Warehouse Oradea", false, "IN_TRANSIT"),
  s(40, "Wrong recipient data", false, "BLOCKED"),
  s(41, "Linhaul transit", false, "IN_TRANSIT"),
  s(42, "Product returned to stock", true, "RETURN_RECEIVED"),
  s(43, "Insufficient data", false, "BLOCKED"),
  s(44, "Unsuccessful delivery attempt", false, "IN_TRANSIT"),
  s(45, "Warehouse Senec", false, "IN_TRANSIT"),
  s(46, "Warehouse Budapest E", false, "IN_TRANSIT"),
  s(47, "Warehouse Pickup", false, "PROCESSING"),
  s(48, "Warehouse Webshippy", false, "IN_TRANSIT"),
  s(49, "Linehaul loading", false, "IN_TRANSIT"),
  s(50, "Warehouse Ljubljana", false, "IN_TRANSIT"),
  s(51, "Picked up", false, "IN_TRANSIT"),
  s(52, "Search cancelled", false, "EXCEPTION"),
  s(53, "Underaudit", false, "EXCEPTION"),
  s(54, "COD Blocked by Authorities", false, "EXCEPTION"),
  s(55, "Loaded hub Ruse (BG)", false, "IN_TRANSIT"),
  s(56, "Loaded hub Sofia (BG)", false, "IN_TRANSIT"),
  s(57, "Loaded hub Oradea (RO)", false, "IN_TRANSIT"),
  s(58, "Loaded hub Zagreb (HR)", false, "IN_TRANSIT"),
  s(59, "Loaded hub Senec (SK)", false, "IN_TRANSIT"),
  s(60, "Unloaded hub Ruse (BG)", false, "IN_TRANSIT"),
  s(61, "Unloaded hub Sofia (BG)", false, "IN_TRANSIT"),
  s(62, "Unloaded hub Oradea (RO)", false, "IN_TRANSIT"),
  s(63, "Unloaded hub Zagreb (HR)", false, "IN_TRANSIT"),
  s(64, "Unloaded hub Senec (SK)", false, "IN_TRANSIT"),
  s(65, "Loaded hub Ljubljana (SI)", false, "IN_TRANSIT"),
  s(66, "Unloaded hub Ljubljana (SI)", false, "IN_TRANSIT"),
  s(67, "Under investigation", false, "EXCEPTION"),
  s(68, "Warehouse Bolzano", false, "IN_TRANSIT"),
  s(69, "Loaded hub Bolzano (IT)", false, "IN_TRANSIT"),
  s(70, "Unloaded hub Bolzano (IT)", false, "IN_TRANSIT"),
  s(71, "Warehouse Castellbisbal", false, "IN_TRANSIT"),
  s(72, "Loaded hub Castellbisbal (ES)", false, "IN_TRANSIT"),
  s(73, "Unloaded hub Castellbisbal (ES)", false, "IN_TRANSIT"),
  s(74, "Repackaged", false, "PROCESSING"),
  s(75, "Warehouse Burgas", false, "IN_TRANSIT"),
  s(76, "Loaded hub Burgas (BG)", false, "IN_TRANSIT"),
  s(77, "Unloaded hub Burgas (BG)", false, "IN_TRANSIT"),
  s(78, "Loaded hub Buda (HU)", false, "IN_TRANSIT"),
  s(79, "Unloaded hub Buda (HU)", false, "IN_TRANSIT"),
  s(80, "Warehouse Vienna", false, "IN_TRANSIT"),
  s(81, "Loaded hub Vienna (AT)", false, "IN_TRANSIT"),
  s(82, "Unloaded hub Vienna (AT)", false, "IN_TRANSIT"),
  s(86, "Warehouse Montana", false, "IN_TRANSIT"),
  s(87, "Loaded hub Montana (BG)", false, "IN_TRANSIT"),
  s(88, "Unloaded hub Montana (BG)", false, "IN_TRANSIT"),
  s(89, "Warehouse Istanbul", false, "IN_TRANSIT"),
  s(90, "Loaded hub Istanbul (TR)", false, "IN_TRANSIT"),
  s(91, "Unloaded hub Istanbul (TR)", false, "IN_TRANSIT"),
  s(92, "Loaded hub Budapest (HU)", false, "IN_TRANSIT"),
  s(93, "Unloaded hub Budapest (HU)", false, "IN_TRANSIT"),
];

/** `GET /get-status/{awb}` special value (INTEGRATION_NOTES §4.5). */
export const CANCELED_DELETED: SeedStatus = s(0, "canceled/deleted", true, "CANCELLED");

export interface StatusRule {
  category: EuStatusCategory;
  final: boolean;
}

/**
 * Category for a text: exact (normalised) entry first; then the notes' family rule for new warehouses/hubs
 * ("any Warehouse …", "Loaded hub …", "Unloaded hub …" → IN_TRANSIT); otherwise UNKNOWN.
 * `matched: false` means "not in the table": the caller records it and raises the unknown-status alert.
 */
export function resolveStatus(
  text: string,
  table: ReadonlyMap<string, StatusRule>,
): StatusRule & { key: string; matched: boolean; family: boolean } {
  const key = normaliseStatusText(text);
  const hit = table.get(key);
  if (hit) return { ...hit, key, matched: true, family: false };
  if (/^(warehouse|loaded hub|unloaded hub) \S/.test(key))
    return { category: "IN_TRANSIT", final: false, key, matched: false, family: true };
  return { category: "UNKNOWN", final: false, key, matched: false, family: false };
}

/** The seed as a lookup table (for pure use and tests; production reads the DB copy). */
export function seedTable(): Map<string, StatusRule> {
  return new Map(
    [...SEED_STATUSES, CANCELED_DELETED].map((x) => [
      normaliseStatusText(x.text),
      { category: x.category, final: x.final },
    ]),
  );
}

/**
 * Statuses that are final in the spec but still have a money outcome to come: "Claim opened" is followed by
 * "Compensation paid", so it is polled on until that (or another status) arrives.
 */
const POLL_PAST_FINAL = new Set(["claim opened"]);

/**
 * Whether polling can stop. Final statuses stop it, except returns (polled until the return is received),
 * Cancel (spec: not final) and an open claim (until the compensation is paid). UNKNOWN never stops polling.
 */
export function stopsPolling(rule: StatusRule & { key?: string }): boolean {
  if (rule.category === "RETURNING" || rule.category === "CANCEL_PENDING" || rule.category === "UNKNOWN")
    return false;
  if (rule.key && POLL_PAST_FINAL.has(rule.key)) return false;
  if (rule.category === "RETURN_RECEIVED" || rule.category === "CANCELLED") return true;
  return rule.final;
}

// ───────────────────────── "stuck in Information received" ─────────────────────────

/**
 * Vendor dates look like "2026-03-06 10:47:18" without a zone. The spec does not say which zone; we read them
 * as Europe/Sofia local time (the vendor is in Bulgaria) — an open question recorded in PROGRESS.
 */
export function parseVendorDate(value: string | null | undefined, timeZone = "Europe/Sofia"): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m.map(Number) as number[];
  const asUtc = Date.UTC(y!, mo! - 1, d!, h!, mi!, sec ?? 0);
  // Offset of the zone at that instant (two passes handle DST edges well enough for alerting).
  const offsetAt = (t: number) => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const local = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    return local - t;
  };
  let t = asUtc - offsetAt(asUtc);
  t = asUtc - offsetAt(t);
  return new Date(t);
}

const DAY = 24 * 3600_000;

/** Milliseconds between two instants, skipping Saturdays and Sundays (UTC days) when `workingDaysOnly`. */
export function elapsedMs(from: Date, to: Date, workingDaysOnly: boolean): number {
  if (to <= from) return 0;
  if (!workingDaysOnly) return to.getTime() - from.getTime();
  let total = 0;
  let t = from.getTime();
  const end = to.getTime();
  while (t < end) {
    const dayEnd = Math.floor(t / DAY) * DAY + DAY;
    const segEnd = Math.min(dayEnd, end);
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) total += segEnd - t;
    t = segEnd;
  }
  return total;
}

/**
 * True when a shipment has stayed in the ACCEPTED group (New / Information received / …) longer than the
 * configured threshold (default 24 h on working days, INTEGRATION_NOTES §4.5).
 */
export function isStuckAccepted(
  since: Date,
  now: Date,
  opts: { hours: number; workingDaysOnly: boolean } = { hours: 24, workingDaysOnly: true },
): boolean {
  return elapsedMs(since, now, opts.workingDaysOnly) >= opts.hours * 3600_000;
}
