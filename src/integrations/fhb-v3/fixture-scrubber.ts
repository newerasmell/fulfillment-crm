/**
 * Fixture scrubber for recorded FHB responses (P2-03). The repo is public: a recorded production response may
 * carry customer data (names, addresses, phones, emails) and business data (SKUs, EANs, product names,
 * quantities, amounts, order/COD numbers, account ids). Every leaf value is replaced by a synthetic one whose
 * SHAPE is kept (string vs number, integer vs decimal, sign, date format, email/URL/phone look), so the
 * fixtures still exercise the schemas and parsers:
 *
 *  - strings → `SYN-<n>`; emails → `syn<n>@example.test`; URLs → `https://example.test/syn/<n>`;
 *    phones (key `phone`) → `+999000<nnnnnn>`; dates/timestamps → the same format in the year 2001;
 *  - numbers → 0 stays 0, everything else becomes ±(900000 + n) (+ .25 when the original was not an integer);
 *  - booleans and null are kept; `page` (a paging counter) is kept;
 *  - documented enum-like values (status, type, carrier codes, country, currency …) are kept when they look
 *    like a code — they are vendor vocabulary, not business data, and the status map needs the real values.
 * The same original value always becomes the same synthetic value within one recording run, so references
 * between files (a product id in a movement, an order id in the COD list) still line up.
 *
 * `findUnscrubbed` is the other half: it lists every leaf of a fixture that the scrubber could not have
 * produced. The fixture test fails on any such value, so a hand-edited or unscrubbed fixture cannot be committed.
 */

/** Keys whose values are vendor vocabulary (kept when they look like a code). */
const CODE_KEYS = new Set([
  "status",
  "type",
  "return_type",
  "action",
  "parcel_service",
  "code",
  "event_code",
  "carrier_event_code",
]);
const CODE_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const COUNTRY_KEYS = new Set(["country", "country_of_origin"]);
const COUNTRY_RE = /^[A-Za-z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
/** Paging counter, not data. */
const KEPT_NUMBER_KEYS = new Set(["page"]);

const DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:([T ])(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\//i;

const SYN_STRING = /^SYN-\d+$/;
const SYN_EMAIL = /^syn\d+@example\.test$/;
const SYN_URL = /^https:\/\/example\.test\/syn\/\d+$/;
const SYN_PHONE = /^\+999000\d{6}$/;
const SYN_NUMBER_MIN = 900_000;
const SYN_NUMBER_MAX = 999_999;

function syntheticDate(original: RegExpMatchArray, n: number): string {
  const [, , , , sep, hh, , ss, frac, tz] = original;
  const d = new Date(Date.UTC(2001, 0, 1) + n * 3_600_000);
  const date = d.toISOString().slice(0, 10);
  if (!hh) return tz ? `${date}${tz}` : date;
  const time = d.toISOString().slice(11, 16) + (ss !== undefined ? ":00" : "") + (frac ? ".000" : "");
  return `${date}${sep}${time}${tz ?? ""}`;
}

export interface FixtureScrubber {
  scrub<T>(value: T): T;
}

export function createFixtureScrubber(): FixtureScrubber {
  const strings = new Map<string, string>();
  const numbers = new Map<number, number>();
  let n = 0;
  const next = () => ++n;

  const scrubString = (key: string, v: string): string => {
    if (v === "") return v;
    if (CODE_KEYS.has(key) && CODE_RE.test(v)) return v;
    if (COUNTRY_KEYS.has(key) && COUNTRY_RE.test(v)) return v;
    if (key === "currency" && CURRENCY_RE.test(v)) return v;
    const cacheKey = `${key === "phone" ? "phone" : ""}|${v}`;
    const hit = strings.get(cacheKey);
    if (hit) return hit;
    const i = next();
    const date = v.match(DATE_RE);
    const out = date
      ? syntheticDate(date, i)
      : key === "phone"
        ? `+999000${String(i % 1_000_000).padStart(6, "0")}`
        : EMAIL_RE.test(v)
          ? `syn${i}@example.test`
          : URL_RE.test(v)
            ? `https://example.test/syn/${i}`
            : `SYN-${i}`;
    strings.set(cacheKey, out);
    return out;
  };

  const scrubNumber = (key: string, v: number): number => {
    if (v === 0 || !Number.isFinite(v)) return 0;
    if (KEPT_NUMBER_KEYS.has(key) && Number.isInteger(v) && v >= 0 && v <= 100_000) return v;
    const hit = numbers.get(v);
    if (hit !== undefined) return hit;
    const base = SYN_NUMBER_MIN + (next() % (SYN_NUMBER_MAX - SYN_NUMBER_MIN));
    const out = (v < 0 ? -1 : 1) * (Number.isInteger(v) ? base : base + 0.25);
    numbers.set(v, out);
    return out;
  };

  const walk = (value: unknown, key: string): unknown => {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return scrubString(key, value);
    if (typeof value === "number") return scrubNumber(key, value);
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (typeof value === "object") {
      return Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, walk(v, k)]));
    }
    return null;
  };

  return { scrub: <T>(value: T) => walk(value, "") as T };
}

/** Could the scrubber have produced this leaf? */
export function isScrubberOutput(key: string, value: unknown): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") {
    if (value === 0) return true;
    if (KEPT_NUMBER_KEYS.has(key)) return Number.isInteger(value) && value >= 0 && value <= 100_000;
    const abs = Math.abs(value);
    const base = Math.floor(abs);
    return base >= SYN_NUMBER_MIN && base <= SYN_NUMBER_MAX && (abs === base || abs - base === 0.25);
  }
  if (typeof value === "string") {
    if (value === "") return true;
    if (CODE_KEYS.has(key) && CODE_RE.test(value)) return true;
    if (COUNTRY_KEYS.has(key) && COUNTRY_RE.test(value)) return true;
    if (key === "currency" && CURRENCY_RE.test(value)) return true;
    if (DATE_RE.test(value)) return value.startsWith("2001-");
    return SYN_STRING.test(value) || SYN_EMAIL.test(value) || SYN_URL.test(value) || SYN_PHONE.test(value);
  }
  return false;
}

/** JSON paths of every leaf the scrubber could not have produced (empty = clean). */
export function findUnscrubbed(value: unknown, path = "$", key = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findUnscrubbed(v, `${path}[${i}]`, key));
  if (value && typeof value === "object") {
    return Object.entries(value as object).flatMap(([k, v]) => findUnscrubbed(v, `${path}.${k}`, k));
  }
  return isScrubberOutput(key, value) ? [] : [path];
}
