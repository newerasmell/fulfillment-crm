import { z } from "zod";

/**
 * Справки (P10-04): the report period. Days are Europe/Sofia calendar days (the team's day), sent as
 * YYYY-MM-DD; the database stores UTC instants, so a day becomes [Sofia midnight, next Sofia midnight) in UTC.
 * Every report is bounded by this range (at most MAX_RANGE_DAYS).
 */

export const REPORT_TZ = "Europe/Sofia";
export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;
export const RANGE_PRESETS = ["7d", "30d", "90d", "thisMonth", "lastMonth"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

const DAY = 86_400_000;
const IsoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  });

export interface ReportRange {
  /** First day, inclusive (YYYY-MM-DD, Sofia). */
  from: string;
  /** Last day, inclusive (YYYY-MM-DD, Sofia). */
  to: string;
  /** UTC instant of Sofia midnight starting `from`. */
  start: Date;
  /** UTC instant of Sofia midnight after `to` (exclusive). */
  end: Date;
  days: number;
}

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: REPORT_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Pure: offset of Sofia from UTC at `at`, in ms (+2 h in winter, +3 h in summer). */
function offsetAt(at: Date) {
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Pure: the UTC instant at which the Sofia calendar day `day` (YYYY-MM-DD) starts. */
export function sofiaDayStart(day: string): Date {
  const guess = Date.parse(`${day}T00:00:00Z`);
  let t = guess - offsetAt(new Date(guess));
  // Re-check at the result (DST changes at night): the offset there is the one that applies.
  t = guess - offsetAt(new Date(t));
  return new Date(t);
}

/** Pure: Sofia calendar day (YYYY-MM-DD) of an instant. */
export function sofiaDay(at: Date): string {
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Pure: day string `n` days after `day` (calendar arithmetic, no time zone involved). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** Pure: every day of the range, in order. */
export function daysOf(r: Pick<ReportRange, "from" | "to">): string[] {
  const out: string[] = [];
  for (let d = r.from; d <= r.to && out.length <= MAX_RANGE_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}

function build(from: string, to: string): ReportRange {
  const start = sofiaDayStart(from);
  const end = sofiaDayStart(addDays(to, 1));
  return { from, to, start, end, days: daysOf({ from, to }).length };
}

/** Pure: the days of a preset, ending today (Sofia) for the rolling ones. */
export function presetRange(p: RangePreset, now = new Date()): ReportRange {
  const today = sofiaDay(now);
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (p) {
    case "7d":
      return build(addDays(today, -6), today);
    case "90d":
      return build(addDays(today, -89), today);
    case "thisMonth":
      return build(monthStart, today);
    case "lastMonth": {
      const lastEnd = addDays(monthStart, -1);
      return build(`${lastEnd.slice(0, 7)}-01`, lastEnd);
    }
    default:
      return build(addDays(today, -(DEFAULT_RANGE_DAYS - 1)), today);
  }
}

/**
 * Zod boundary for ?from=&to=&preset= of the report pages and CSV routes. Invalid or missing values fall back to
 * the last 30 days; a reversed range is swapped; a range longer than MAX_RANGE_DAYS is cut to its last days.
 */
export function parseRange(
  raw: { from?: unknown; to?: unknown; preset?: unknown },
  now = new Date(),
): ReportRange & { preset: RangePreset | null } {
  const preset = z.enum(RANGE_PRESETS).safeParse(raw.preset);
  const from = IsoDay.safeParse(raw.from);
  const to = IsoDay.safeParse(raw.to);
  if (!from.success || !to.success) {
    const p = preset.success ? preset.data : "30d";
    return { ...presetRange(p, now), preset: p };
  }
  let [a, b] = from.data <= to.data ? [from.data, to.data] : [to.data, from.data];
  if (daysOf({ from: a, to: b }).length > MAX_RANGE_DAYS) a = addDays(b, -(MAX_RANGE_DAYS - 1));
  const today = sofiaDay(now);
  if (b > today && a <= today) b = today;
  const r = build(a, b);
  const match = RANGE_PRESETS.find((p) => {
    const x = presetRange(p, now);
    return x.from === r.from && x.to === r.to;
  });
  return { ...r, preset: match ?? null };
}
