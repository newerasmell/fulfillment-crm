import { createHash } from "node:crypto";

/**
 * Fixture scrubber for euShipments read responses (CLAUDE.md: no real business data in git).
 *
 * Every key of every recorded response must be classified, per endpoint: either `safe` (vendor nomenclature,
 * dates, status texts, flags), `nest` (an object/array to walk into) or a sensitive kind whose value is
 * REPLACED by a deterministic synthetic one. Synthetic values have a recognisable shape, so a checker can
 * prove that a fixture contains only scrubber output (`findUnscrubbed`). A key nobody classified is reported
 * and the recorder refuses to write the file — a new vendor field never slips through unreviewed.
 *
 * Synthetic shapes (the checker accepts exactly these, plus null / ""):
 *   text     SYN-<6 hex>                     names, addresses, descriptions, comments
 *   ref      SYN-REF-<6 hex>                 SKUs / refNumbers, our references, AWBs, client references
 *   phone    +3590000<5 digits>
 *   email    syn-<6 hex>@example.com
 *   ean      200<10 digits>                  (GS1 in-store range)
 *   company  900000–900999                   euShipments company ids
 *   id       800000000–800999999             vendor record ids (products, bookings, payout protocols…)
 *   qty      0–9                             quantities (0 stays 0)
 *   amount   N.11                            money (cents always 11)
 *   message  vendor error text with emails and digit runs masked (scrubText rules)
 */

export const SCRUBBER_VERSION = 1;

export type Kind =
  "text" | "ref" | "phone" | "email" | "ean" | "company" | "id" | "qty" | "amount" | "message";
type Rule = Kind | "safe" | "nest";

const ORDER_STATUS: Record<string, Rule> = {
  ID: "id",
  STATUS: "safe",
  DATE: "safe",
  DATE_CREATED: "safe",
  COMMENT: "text",
  PARTNER_VOUCHER: "ref",
};

/** Endpoint → key → rule. Field names exactly as in docs/integrations/eushipments.md. */
export const RULES: Record<string, Record<string, Rule>> = {
  "get-user-companies": { ID: "company", NAME: "text", BULSTAT: "text", ADDRESS: "text", MOL: "text" },
  couriers: {
    ID: "safe",
    NAME: "safe",
    TO_OFFICE: "safe",
    TO_ADDRESS: "safe",
    COUNTRY: "safe",
    CURRENCY: "safe",
  },
  warehouses: { data: "nest", id: "safe", name: "safe", country: "nest", iso: "safe" },
  "get-countries": { ID: "safe", NAME: "safe", CYRILLIC_NAME: "safe", ISO_CODE: "safe" },
  "get-cities": Object.fromEntries(
    [
      "ID",
      "POSTAL_CODE",
      "CITY_NAME_LOCAL",
      "CITY_NAME_EN",
      "COUNTY",
      "COUNTY_ID",
      "COUNTY_EN",
      "MUNICIPALITY",
      "STATE",
      "STATE_EN",
      "MANUAL_EDIT",
      "RAPIDO_SITEID",
    ].map((k) => [k, "safe" as Rule]),
  ),
  "offices-by-courier": {
    offices: "nest",
    pagination: "nest",
    ...Object.fromEntries(
      [
        "ID",
        "CITY_ID",
        "COURIER_ID",
        "COURIER_OFFICE_ID",
        "OFFICE_NAME",
        "COURIER_OFFICE_CODE",
        "CITY_NAME",
        "ADDRESS",
        "LATITUDE",
        "LONGITUDE",
        "WORK_BEGIN",
        "WORK_END",
        "WORK_BEGIN_SATURDAY",
        "WORK_END_SATURDAY",
        "GROUP_CITY_ID",
        "POST_CODE",
        "REGION",
        "IS_STATION",
        "COD_SUPPORT",
        "current_page",
        "per_page",
        "total",
        "last_page",
        "from",
        "to",
        "has_more_pages",
      ].map((k) => [k, "safe" as Rule]),
    ),
  },
  "get-products": {
    ID: "id",
    NAME: "text",
    DESCRIPTION: "text",
    LENGTH_ITEM: "safe",
    WIDTH: "safe",
    HEIGHT: "safe",
    WEIGHT: "safe",
    REFERENCE_NUMBER: "ref",
  },
  "get-prod-avails": {
    AVAIL_DATE: "safe",
    STORE_NAME: "safe",
    ART_NAME: "text",
    ART_LNG_DESC: "text",
    ART_SH_DESC: "text",
    CUST_NAME: "text",
    REFERENCE_NUMBER: "ref",
    COURIER_ITEM_CODE: "id",
    AVAIL_QTY: "qty",
  },
  "orders-history": {
    refNum: "ref",
    awb: "ref",
    newReturnNumber: "ref",
    error: "message",
    errorCode: "safe",
    statusesHistory: "nest",
    ...ORDER_STATUS,
    items: "nest",
    refNumber: "ref",
    sn: "ref",
    qty: "qty",
  },
  "get-request-status": {
    accepted: "safe",
    date: "safe",
    clientReference: "ref",
    ref1: "text",
    ref2: "text",
    ref3: "text",
  },
  "booking-request-status": {
    bookingId: "id",
    clientReference: "ref",
    ref1: "text",
    ref2: "text",
    ref3: "text",
    statuses: "nest",
    created: "safe",
    received: "safe",
    closed: "safe",
    deleted: "safe",
    products: "nest",
    name: "text",
    referenceNumber: "ref",
    booked: "qty",
    accepted: "qty",
    comment: "text",
  },
  "check-cod-by-order": {
    awbNumber: "ref",
    referenceNumber: "ref",
    COD: "amount",
    payedNumber: "id",
    payedDate: "safe",
  },
};

export type Endpoint = keyof typeof RULES;
export const ENDPOINTS = Object.keys(RULES) as Endpoint[];

const hex = (kind: string, v: unknown) =>
  createHash("sha256")
    .update(`${kind}:${String(v)}`)
    .digest("hex");
const digits = (kind: string, v: unknown, n: number) =>
  BigInt(`0x${hex(kind, v).slice(0, 15)}`)
    .toString()
    .padStart(n, "0")
    .slice(-n);
const num = (kind: string, v: unknown) => parseInt(hex(kind, v).slice(0, 8), 16);
const empty = (v: unknown) => v === null || v === undefined || v === "";

const SHAPES: Record<Kind, (v: unknown) => boolean> = {
  text: (v) => typeof v === "string" && /^SYN-[0-9a-f]{6}$/.test(v),
  ref: (v) => typeof v === "string" && /^SYN-REF-[0-9a-f]{6}$/.test(v),
  phone: (v) => typeof v === "string" && /^\+3590000\d{5}$/.test(v),
  email: (v) => typeof v === "string" && /^syn-[0-9a-f]{6}@example\.com$/.test(v),
  ean: (v) => typeof v === "string" && /^200\d{10}$/.test(v),
  company: (v) => Number.isInteger(Number(v)) && Number(v) >= 900000 && Number(v) <= 900999,
  id: (v) => Number.isInteger(Number(v)) && Number(v) >= 800000000 && Number(v) <= 800999999,
  qty: (v) => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 9,
  amount: (v) => Number.isFinite(Number(v)) && Math.round(Number(v) * 100) % 100 === 11,
  message: (v) =>
    typeof v === "boolean" ||
    (typeof v === "string" &&
      !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(v) &&
      !/\d[\d\s-]{6,}\d/.test(v)),
};

/** True when `v` is already scrubber output for `kind` (or empty). */
export function isSynthetic(kind: Kind, v: unknown): boolean {
  return empty(v) || SHAPES[kind](v);
}

const keepType = (orig: unknown, n: number | string) => (typeof orig === "string" ? String(n) : n);

/** Deterministic synthetic value for one sensitive value (idempotent: synthetic input is kept). */
export function synth(kind: Kind, v: unknown): unknown {
  if (isSynthetic(kind, v)) return v;
  switch (kind) {
    case "text":
      return `SYN-${hex(kind, v).slice(0, 6)}`;
    case "ref":
      return `SYN-REF-${hex(kind, v).slice(0, 6)}`;
    case "phone":
      return `+3590000${digits(kind, v, 5)}`;
    case "email":
      return `syn-${hex(kind, v).slice(0, 6)}@example.com`;
    case "ean":
      return `200${digits(kind, v, 10)}`;
    case "company":
      return keepType(v, 900000 + (num(kind, v) % 1000));
    case "id":
      return keepType(v, 800000000 + (num(kind, v) % 1_000_000));
    case "qty":
      return keepType(v, 1 + (num(kind, v) % 9));
    case "amount": {
      const a = (num(kind, v) % 900) + 10 + 0.11;
      return typeof v === "string" ? a.toFixed(2) : a;
    }
    case "message":
      return String(v)
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
        .replace(/\d[\d\s-]{6,}\d/g, "[number]")
        .slice(0, 300);
  }
}

interface Walk {
  data: unknown;
  /** Paths of keys no rule covers (the response has a field the scrubber does not know). */
  unclassified: string[];
  /** Paths of sensitive values that are not synthetic (checker mode). */
  unscrubbed: string[];
}

function walk(endpoint: string, value: unknown, path: string, out: Walk, replace: boolean): unknown {
  const rules = RULES[endpoint];
  if (!rules) throw new Error(`no scrub rules for endpoint ${endpoint}`);
  if (Array.isArray(value)) return value.map((v, i) => walk(endpoint, v, `${path}[${i}]`, out, replace));
  if (!value || typeof value !== "object") return value;
  const res: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    const rule = rules[k];
    if (!rule) {
      out.unclassified.push(p);
      res[k] = replace ? null : v;
    } else if (rule === "nest") {
      res[k] = walk(endpoint, v, p, out, replace);
    } else if (rule === "safe") {
      // A safe key must hold a plain value: an object there would carry unclassified content.
      if (v && typeof v === "object") {
        out.unclassified.push(p);
        res[k] = replace ? null : v;
      } else res[k] = v;
    } else if (v && typeof v === "object") {
      out.unclassified.push(p);
      res[k] = replace ? null : v;
    } else {
      if (!isSynthetic(rule, v)) out.unscrubbed.push(p);
      res[k] = replace ? synth(rule, v) : v;
    }
  }
  return res;
}

/** Replaces every sensitive value. `unclassified` non-empty = do NOT store this fixture. */
export function scrubResponse(endpoint: Endpoint, data: unknown) {
  const out: Walk = { data: null, unclassified: [], unscrubbed: [] };
  out.data = walk(endpoint, data, "", out, true);
  return { data: out.data, unclassified: out.unclassified };
}

/** Checker: every path whose value the scrubber did not produce (or whose key it does not know). */
export function findUnscrubbed(endpoint: Endpoint, data: unknown): string[] {
  const out: Walk = { data: null, unclassified: [], unscrubbed: [] };
  walk(endpoint, data, "", out, false);
  return [...out.unclassified.map((p) => `${p} (unclassified)`), ...out.unscrubbed];
}

/** What a recorded fixture file holds. */
export interface RecordedFixture {
  endpoint: Endpoint;
  scrubberVersion: number;
  recordedAt: string;
  response: unknown;
}
