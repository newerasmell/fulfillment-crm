/**
 * Calendar days in an IANA time zone (the account's Account.timezone, default Europe/Sofia) without a
 * dependency: Intl gives the zone's wall clock for an instant, from which we derive the UTC offset.
 */

export const DEFAULT_TIMEZONE = "Europe/Sofia";

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A valid IANA zone, or the default one (a bad stored value must never break a board). */
export function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

function wallClock(instant: number, tz: string) {
  const p = Object.fromEntries(
    formatter(tz)
      .formatToParts(new Date(instant))
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  return p;
}

/** Offset of the zone at an instant, in ms (local − UTC). */
function offsetAt(instant: number, tz: string) {
  const p = wallClock(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant of local midnight that starts day YYYY-MM-DD in the zone. */
export function zonedDayStart(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetAt(guess, tz);
  const again = guess - offsetAt(t, tz);
  if (again !== t) t = again;
  return new Date(t);
}

/** The instant that starts the day AFTER YYYY-MM-DD in the zone (exclusive upper bound; DST-safe). */
export function zonedDayEnd(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return zonedDayStart(next, tz);
}

/** YYYY-MM-DD of an instant in the zone. */
export function zonedDay(d: Date, tz: string): string {
  const p = wallClock(d.getTime(), tz);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
