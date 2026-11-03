import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ghostButtonCls, inputCls, labelCls } from "@/components/ui/form";
import { RANGE_PRESETS, type ReportRange } from "@/server/reports";

/** Shared pieces of the report pages (Справки, P10-04): period bar, notes, warehouse chip, bar charts. */

export function rangeQuery(range: { from: string; to: string }) {
  return `from=${range.from}&to=${range.to}`;
}

export async function RangeBar({
  report,
  range,
  preset,
  exportable = true,
}: {
  report: string;
  range: ReportRange;
  preset: string | null;
  exportable?: boolean;
}) {
  const t = await getTranslations("reports");
  const base = `/reports/${report}`;
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <form
        method="get"
        action={base}
        aria-label={t("range.label")}
        className="flex flex-wrap items-end gap-2"
      >
        <label className={labelCls}>
          {t("range.from")}
          <input
            type="date"
            name="from"
            defaultValue={range.from}
            className={inputCls}
            data-testid="range-from"
          />
        </label>
        <label className={labelCls}>
          {t("range.to")}
          <input type="date" name="to" defaultValue={range.to} className={inputCls} data-testid="range-to" />
        </label>
        <button type="submit" className={ghostButtonCls}>
          {t("range.apply")}
        </button>
        <span className="self-center text-xs text-muted">{t("range.days", { days: range.days })}</span>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label={t("range.label")} className="flex flex-wrap gap-1.5">
          {RANGE_PRESETS.map((p) => (
            <Link
              key={p}
              href={`${base}?preset=${p}`}
              data-testid={`preset-${p}`}
              aria-current={preset === p ? "page" : undefined}
              className={`flex min-h-10 items-center rounded-full border px-3 text-sm no-underline ${
                preset === p
                  ? "border-accent bg-accent-soft text-accent-strong"
                  : "border-line bg-surface text-ink"
              }`}
            >
              {t(`range.presets.${p}`)}
            </Link>
          ))}
        </nav>
        {exportable && (
          <a
            href={`/api/reports/${report}/export?${rangeQuery(range)}`}
            className={`${ghostButtonCls} inline-flex items-center no-underline`}
            data-testid="report-export"
          >
            {t("export")}
          </a>
        )}
      </div>
    </div>
  );
}

export function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 max-w-4xl text-sm text-muted" data-testid="report-note">
      {children}
    </p>
  );
}

export function WarehouseChip({ name, type }: { name: string; type: string }) {
  const eu = type === "EUSHIPMENTS";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
        eu ? "bg-eu-chip text-eu-text" : "bg-fhb-chip text-fhb-text"
      }`}
    >
      <span aria-hidden className={`size-2 rounded-full ${eu ? "bg-eu" : "bg-fhb"}`} />
      {name}
    </span>
  );
}

export function Kpi({ label, value, testid }: { label: string; value: React.ReactNode; testid?: string }) {
  return (
    <div
      className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3"
      data-testid={testid}
    >
      <div className="text-xs text-label">{label}</div>
      <div className="font-mono text-2xl font-semibold">{value}</div>
    </div>
  );
}

/**
 * Stacked vertical bars per day (inline SVG, no chart library). Each bar has a native tooltip with the exact
 * numbers; the table next to it carries the same data, so nothing is colour-only.
 */
export function DayBars({
  days,
  label,
  series,
}: {
  days: { day: string; values: number[] }[];
  label: string;
  series: { name: string; cls: string }[];
}) {
  const max = Math.max(1, ...days.map((d) => d.values.reduce((s, v) => s + v, 0)));
  const W = 720;
  const H = 160;
  const gap = days.length > 60 ? 0.5 : 2;
  const bw = W / Math.max(1, days.length);
  return (
    <figure className="m-0 flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        className="h-40 w-full"
        data-testid="day-bars"
      >
        <line x1={0} x2={W} y1={H} y2={H} className="stroke-line" vectorEffect="non-scaling-stroke" />
        {days.map((d, i) => {
          let y = H;
          const total = d.values.reduce((s, v) => s + v, 0);
          return (
            <g key={d.day}>
              <title>{`${d.day}: ${total} (${series.map((s, k) => `${s.name} ${d.values[k]}`).join(", ")})`}</title>
              <rect x={i * bw} y={0} width={bw} height={H} className="fill-transparent" />
              {d.values.map((v, k) => {
                const h = (v / max) * (H - 4);
                y -= h;
                return v > 0 ? (
                  <rect
                    key={k}
                    x={i * bw + gap / 2}
                    y={y}
                    width={Math.max(0.5, bw - gap)}
                    height={h}
                    className={series[k]?.cls}
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null;
              })}
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between font-mono text-[11px] text-label" aria-hidden>
        <span>{days[0]?.day}</span>
        <span>max {max}</span>
        <span>{days.at(-1)?.day}</span>
      </div>
      <figcaption className="flex flex-wrap gap-3 text-xs text-muted">
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5">
            <svg aria-hidden viewBox="0 0 10 10" className="size-2.5">
              <rect width={10} height={10} rx={2} className={s.cls} />
            </svg>
            {s.name}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** One horizontal stacked bar (shares of a whole), with the numbers in the title and the table. */
export function StackBar({
  parts,
  label,
}: {
  parts: { value: number; cls: string; name: string }[];
  label: string;
}) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div
      role="img"
      aria-label={`${label}: ${parts.map((p) => `${p.name} ${p.value}`).join(", ")}`}
      className="flex h-3 w-full overflow-hidden rounded-full bg-line-soft"
    >
      {total > 0 &&
        parts.map((p) =>
          p.value > 0 ? (
            <span
              key={p.name}
              title={`${p.name}: ${p.value}`}
              className={`h-full ${p.cls}`}
              style={{ width: `${(p.value / total) * 100}%` }}
            />
          ) : null,
        )}
    </div>
  );
}
