import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/PageHeader";
import { tdCls, thCls } from "@/components/ui/form";
import {
  codReport,
  ordersReport,
  rate,
  reviewReport,
  shipmentsReport,
  STAGES,
  stockReport,
  timingReport,
  type ReportCtx,
  type ReportRange,
} from "@/server/reports";
import { AGE_BUCKETS } from "@/server/reports/cod";
import { DayBars, Kpi, Note, StackBar, WarehouseChip } from "../ui";

type Props = { ctx: ReportCtx; range: ReportRange };
type Fmt = Awaited<ReturnType<typeof getFormatter>>;

const moneyOf = (format: Fmt) => (amount: number, currency: string) =>
  /^[A-Z]{3}$/.test(currency)
    ? format.number(amount, { style: "currency", currency, maximumFractionDigits: 2 })
    : format.number(amount, { maximumFractionDigits: 2 });
const pctOf = (format: Fmt) => (v: number | null) =>
  v == null ? "—" : format.number(v, { style: "percent", maximumFractionDigits: 1 });

function Table({
  label,
  head,
  children,
}: {
  label: string;
  head: React.ReactNode[];
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse" aria-label={label}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className={thCls}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const mono = `${tdCls} font-mono`;

// ───────────────────────── 1. orders ─────────────────────────

export async function OrdersView({ ctx, range }: Props) {
  const t = await getTranslations("reports");
  const format = await getFormatter();
  const money = moneyOf(format);
  const pct = pctOf(format);
  const r = await ordersReport(ctx, range);
  const groups = (title: string, rows: typeof r.byStore, none: string, testid: string) => (
    <Card>
      <h2 className="mt-0 mb-3 text-lg font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="m-0 text-muted">{t("empty")}</p>
      ) : (
        <Table
          label={title}
          head={[
            t("orders.col.name"),
            t("orders.col.currency"),
            t("orders.col.orders"),
            t("orders.col.codShare"),
            t("orders.col.total"),
          ]}
        >
          {rows.flatMap((g) =>
            g.totals.map((x, i) => (
              <tr
                key={`${g.id}:${x.currency}`}
                data-testid={`${testid}-${g.id ? g.name : "none"}-${x.currency}`}
              >
                <td className={tdCls}>{i === 0 ? (g.id ? g.name : none) : ""}</td>
                <td className={mono}>{x.currency}</td>
                <td className={mono}>{x.count}</td>
                <td className={mono}>{pct(rate(x.cod, x.count))}</td>
                <td className={mono}>{money(x.totalCents / 100, x.currency)}</td>
              </tr>
            )),
          )}
        </Table>
      )}
    </Card>
  );
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label={t("orders.kpi.orders")} value={r.orders} testid="kpi-orders" />
        <Kpi
          label={t("orders.kpi.cod")}
          value={`${r.cod} · ${pct(rate(r.cod, r.orders))}`}
          testid="kpi-cod"
        />
        <Kpi
          label={t("orders.kpi.prepaid")}
          value={`${r.orders - r.cod} · ${pct(rate(r.orders - r.cod, r.orders))}`}
          testid="kpi-prepaid"
        />
        <Kpi label={t("orders.kpi.cancelled")} value={r.cancelled} testid="kpi-cancelled" />
      </div>
      <Card>
        <h2 className="mt-0 mb-3 text-lg font-semibold">{t("orders.chart")}</h2>
        <DayBars
          label={t("orders.chart")}
          days={r.days.map((d) => ({ day: d.day, values: [d.cod, d.prepaid] }))}
          series={[
            { name: t("orders.legendCod"), cls: "fill-accent" },
            { name: t("orders.legendPrepaid"), cls: "fill-accent-soft stroke-accent" },
          ]}
        />
      </Card>
      <Card>
        <h2 className="mt-0 mb-3 text-lg font-semibold">{t("orders.totals")}</h2>
        {r.totals.length === 0 ? (
          <p className="m-0 text-muted">{t("empty")}</p>
        ) : (
          <Table
            label={t("orders.totals")}
            head={[
              t("orders.col.currency"),
              t("orders.col.orders"),
              t("orders.col.codShare"),
              t("orders.col.total"),
              t("orders.col.codTotal"),
            ]}
          >
            {r.totals.map((x) => (
              <tr key={x.currency} data-testid={`orders-total-${x.currency}`}>
                <td className={mono}>{x.currency}</td>
                <td className={mono}>{x.count}</td>
                <td className={mono}>{pct(rate(x.cod, x.count))}</td>
                <td className={`${mono} font-semibold`}>{money(x.totalCents / 100, x.currency)}</td>
                <td className={mono}>{money(x.codCents / 100, x.currency)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {r.codAmounts.length > 0 && (
        <Card>
          <h2 className="mt-0 mb-3 text-lg font-semibold">{t("orders.codAmounts")}</h2>
          <Table
            label={t("orders.codAmounts")}
            head={[t("orders.col.currency"), t("orders.col.orders"), t("orders.col.codAmount")]}
          >
            {r.codAmounts.map((x) => (
              <tr key={x.currency} data-testid={`orders-cod-${x.currency}`}>
                <td className={mono}>{x.currency}</td>
                <td className={mono}>{x.count}</td>
                <td className={`${mono} font-semibold`}>{money(x.amountCents / 100, x.currency)}</td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 mb-0 text-xs text-muted">{t("orders.codAmountsNote")}</p>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {groups(t("orders.byStore"), r.byStore, t("orders.manual"), "orders-store")}
        {groups(t("orders.byCompany"), r.byCompany, t("orders.noCompany"), "orders-company")}
      </div>
      <Card>
        <details>
          <summary className="cursor-pointer text-sm font-semibold">{t("orders.chart")}</summary>
          <Table
            label={t("orders.chart")}
            head={[
              t("orders.col.day"),
              t("orders.col.orders"),
              t("orders.kpi.cod"),
              t("orders.kpi.prepaid"),
              t("orders.kpi.cancelled"),
            ]}
          >
            {r.days.map((d) => (
              <tr key={d.day}>
                <td className={mono}>{d.day}</td>
                <td className={mono}>{d.orders}</td>
                <td className={mono}>{d.cod}</td>
                <td className={mono}>{d.prepaid}</td>
                <td className={mono}>{d.cancelled}</td>
              </tr>
            ))}
          </Table>
        </details>
      </Card>
      <Note>{t("orders.note")}</Note>
    </>
  );
}

// ───────────────────────── 2. shipments ─────────────────────────

export async function ShipmentsView({ ctx, range }: Props) {
  const t = await getTranslations("reports");
  const format = await getFormatter();
  const pct = pctOf(format);
  const r = await shipmentsReport(ctx, range);
  const parts = (c: { delivered: number; returned: number; inTransit: number }) => [
    { value: c.delivered, cls: "bg-ok", name: t("shipments.legend.delivered") },
    { value: c.returned, cls: "bg-block", name: t("shipments.legend.returned") },
    { value: c.inTransit, cls: "bg-label", name: t("shipments.legend.inTransit") },
  ];
  const cols = [
    t("shipments.col.warehouse"),
    t("shipments.col.carrier"),
    t("shipments.col.created"),
    t("shipments.col.sent"),
    t("shipments.col.delivered"),
    t("shipments.col.returned"),
    t("shipments.col.inTransit"),
    t("shipments.col.cancelled"),
    t("shipments.col.cancelledAfterShip"),
    t("shipments.col.failed"),
    t("shipments.col.deliveryRate"),
    t("shipments.col.returnRate"),
  ];
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label={t("shipments.col.sent")} value={r.total.sent} testid="kpi-sent" />
        <Kpi
          label={t("shipments.col.deliveryRate")}
          value={pct(rate(r.total.delivered, r.total.sent))}
          testid="kpi-delivery-rate"
        />
        <Kpi
          label={t("shipments.col.returnRate")}
          value={pct(rate(r.total.returned, r.total.sent))}
          testid="kpi-return-rate"
        />
        <Kpi label={t("shipments.col.cancelled")} value={r.total.cancelled} testid="kpi-cancelled" />
      </div>
      <Card>
        <h2 className="mt-0 mb-3 text-lg font-semibold">{t("shipments.chart")}</h2>
        {r.warehouses.length === 0 ? (
          <p className="m-0 text-muted">{t("empty")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {r.warehouses.map((w) => (
              <div key={w.connectionId} className="grid items-center gap-2 md:grid-cols-[220px_1fr_160px]">
                <WarehouseChip name={w.name} type={w.type} />
                <StackBar label={w.name} parts={parts(w)} />
                <span className="font-mono text-sm">
                  {pct(rate(w.delivered, w.sent))} / {pct(rate(w.returned, w.sent))}
                </span>
              </div>
            ))}
            <div className="flex flex-wrap gap-3 text-xs text-muted">
              {parts({ delivered: 0, returned: 0, inTransit: 0 }).map((p) => (
                <span key={p.name} className="inline-flex items-center gap-1.5">
                  <span aria-hidden className={`size-2.5 rounded-sm ${p.cls}`} />
                  {p.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>
      {r.warehouses.length > 0 && (
        <Card>
          <Table label={t("cards.shipments.title")} head={cols}>
            {r.warehouses.flatMap((w) => [
              <tr key={w.connectionId} data-testid={`ship-${w.name}`} className="font-semibold">
                <td className={tdCls}>
                  <WarehouseChip name={w.name} type={w.type} />
                </td>
                <td className={tdCls}>{t("shipments.allCarriers")}</td>
                <td className={mono}>{w.created}</td>
                <td className={mono}>{w.sent}</td>
                <td className={mono}>{w.delivered}</td>
                <td className={mono}>{w.returned}</td>
                <td className={mono}>{w.inTransit}</td>
                <td className={mono}>{w.cancelled}</td>
                <td className={mono}>{w.cancelledAfterShip}</td>
                <td className={mono}>{w.failed}</td>
                <td className={mono}>{pct(rate(w.delivered, w.sent))}</td>
                <td className={mono}>{pct(rate(w.returned, w.sent))}</td>
              </tr>,
              ...w.carriers.map((c) => (
                <tr
                  key={`${w.connectionId}:${c.carrier}`}
                  data-testid={`ship-${w.name}-${c.carrier ?? "none"}`}
                >
                  <td className={tdCls} />
                  <td className={tdCls}>
                    {c.carrierName ?? c.carrier ?? (
                      <span className="text-muted">{t("shipments.noCarrier")}</span>
                    )}
                    {c.carrierName && <span className="ml-1 font-mono text-xs text-muted">{c.carrier}</span>}
                  </td>
                  <td className={mono}>{c.created}</td>
                  <td className={mono}>{c.sent}</td>
                  <td className={mono}>{c.delivered}</td>
                  <td className={mono}>{c.returned}</td>
                  <td className={mono}>{c.inTransit}</td>
                  <td className={mono}>{c.cancelled}</td>
                  <td className={mono}>{c.cancelledAfterShip}</td>
                  <td className={mono}>{c.failed}</td>
                  <td className={mono}>{pct(rate(c.delivered, c.sent))}</td>
                  <td className={mono}>{pct(rate(c.returned, c.sent))}</td>
                </tr>
              )),
            ])}
          </Table>
        </Card>
      )}
      <Note>{t("shipments.note")}</Note>
    </>
  );
}

// ───────────────────────── 3. timing ─────────────────────────

export async function TimingView({ ctx, range }: Props) {
  const t = await getTranslations("reports");
  const format = await getFormatter();
  const r = await timingReport(ctx, range);
  const dur = (s: number | null) => {
    if (s == null) return "—";
    if (s < 3600) return t("timing.minutes", { value: format.number(s / 60, { maximumFractionDigits: 0 }) });
    if (s < 48 * 3600)
      return t("timing.hours", { value: format.number(s / 3600, { maximumFractionDigits: 1 }) });
    return t("timing.days", { value: format.number(s / 86400, { maximumFractionDigits: 1 }) });
  };
  if (!r.overall)
    return (
      <>
        <Card>
          <p className="m-0 text-muted">{t("empty")}</p>
        </Card>
        <Note>{t("timing.note")}</Note>
      </>
    );
  const o = r.overall;
  const max = Math.max(1, ...STAGES.map((s) => o.stages[s].p90 ?? 0));
  return (
    <>
      <Card>
        <h2 className="mt-0 mb-3 text-lg font-semibold">{t("timing.chart")}</h2>
        <div className="flex flex-col gap-3">
          {STAGES.map((s) => {
            const st = o.stages[s];
            return (
              <div
                key={s}
                className="grid items-center gap-2 md:grid-cols-[260px_1fr_200px]"
                data-testid={`timing-${s}`}
              >
                <span className="text-sm">{t(`timing.stages.${s}`)}</span>
                <div
                  className="relative h-4 w-full rounded-full bg-line-soft"
                  role="img"
                  aria-label={`${t(`timing.stages.${s}`)}: ${dur(st.median)} / ${dur(st.p90)}`}
                >
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-accent-soft"
                    style={{ width: `${((st.p90 ?? 0) / max) * 100}%` }}
                  />
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-accent"
                    style={{ width: `${((st.median ?? 0) / max) * 100}%` }}
                  />
                </div>
                <span className="font-mono text-sm">
                  {dur(st.median)} · p90 {dur(st.p90)} <span className="text-xs text-muted">({st.n})</span>
                </span>
              </div>
            );
          })}
          <div className="flex gap-3 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-sm bg-accent" /> {t("timing.legendMedian")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-sm bg-accent-soft" /> {t("timing.legendP90")}
            </span>
          </div>
        </div>
      </Card>
      <Card>
        <Table
          label={t("cards.timing.title")}
          head={[
            t("timing.col.warehouse"),
            t("timing.col.orders"),
            ...STAGES.map((s) => t(`timing.stages.${s}`)),
          ]}
        >
          {[{ ...o, all: true }, ...r.warehouses.map((w) => ({ ...w, all: false }))].map((w) => (
            <tr
              key={w.all ? "all" : (w.connectionId ?? "none")}
              data-testid={`timing-row-${w.all ? "all" : (w.name ?? "none")}`}
            >
              <td className={tdCls}>
                {w.all ? (
                  <strong>{t("timing.all")}</strong>
                ) : w.name ? (
                  <WarehouseChip name={w.name} type={w.type ?? ""} />
                ) : (
                  <span className="text-muted">{t("timing.noShipment")}</span>
                )}
              </td>
              <td className={mono}>{w.orders}</td>
              {STAGES.map((s) => (
                <td key={s} className={`${tdCls} text-sm`}>
                  <div className="font-mono">{dur(w.stages[s].median)}</div>
                  <div className="font-mono text-xs text-muted">
                    p90 {dur(w.stages[s].p90)} · {w.stages[s].n}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </Table>
      </Card>
      <Note>{t("timing.note")}</Note>
    </>
  );
}

// ───────────────────────── 4. COD ─────────────────────────

export async function CodView({ ctx, range }: Props) {
  const t = await getTranslations("reports");
  const tc = await getTranslations("cod");
  const format = await getFormatter();
  const money = moneyOf(format);
  const r = await codReport(ctx, range);
  const head = [
    t("cod.col.shipments"),
    t("cod.col.expected"),
    t("cod.col.received"),
    t("cod.col.paid"),
    t("cod.col.outstanding"),
  ];
  const cells = (x: (typeof r.byCurrency)[number]) => (
    <>
      <td className={mono}>{x.count}</td>
      <td className={mono}>{money(x.expected, x.currency)}</td>
      <td className={mono}>{money(x.received, x.currency)}</td>
      <td className={mono}>{money(x.paid, x.currency)}</td>
      <td className={`${mono} font-semibold`}>{money(x.outstanding, x.currency)}</td>
    </>
  );
  return (
    <>
      {r.truncated && (
        <p className="m-0 text-sm text-warn" data-testid="codr-truncated">
          {t("cod.truncated")}
        </p>
      )}
      <Card>
        <h2 className="mt-0 mb-3 text-lg font-semibold">{t("cod.totals")}</h2>
        {r.byCurrency.length === 0 ? (
          <p className="m-0 text-muted">{t("empty")}</p>
        ) : (
          <Table label={t("cod.totals")} head={[t("cod.col.currency"), ...head]}>
            {r.byCurrency.map((x) => (
              <tr key={x.currency} data-testid={`codr-total-${x.currency}`}>
                <td className={mono}>{x.currency}</td>
                {cells(x)}
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {r.byWarehouse.length > 0 && (
        <Card>
          <h2 className="mt-0 mb-3 text-lg font-semibold">{t("cod.byWarehouse")}</h2>
          <Table label={t("cod.byWarehouse")} head={[t("cod.col.warehouse"), t("cod.col.currency"), ...head]}>
            {r.byWarehouse.flatMap((w) =>
              w.totals.map((x, i) => (
                <tr key={`${w.connectionId}:${x.currency}`} data-testid={`codr-wh-${w.name}-${x.currency}`}>
                  <td className={tdCls}>{i === 0 && <WarehouseChip name={w.name} type={w.type} />}</td>
                  <td className={mono}>{x.currency}</td>
                  {cells(x)}
                </tr>
              )),
            )}
          </Table>
        </Card>
      )}
      {r.ageing.length > 0 && (
        <Card>
          <h2 className="mt-0 mb-3 text-lg font-semibold">{t("cod.ageing")}</h2>
          <Table
            label={t("cod.ageing")}
            head={[t("cod.col.currency"), ...AGE_BUCKETS.map((b) => tc(`bucket.${b}`))]}
          >
            {r.ageing.map((a) => (
              <tr key={a.currency} data-testid={`codr-age-${a.currency}`}>
                <td className={mono}>{a.currency}</td>
                {AGE_BUCKETS.map((b) => (
                  <td
                    key={b}
                    className={`${tdCls} ${b === "d30_plus" && a.buckets[b].count ? "text-block" : ""}`}
                  >
                    <div className="font-mono">{money(a.buckets[b].amount, a.currency)}</div>
                    <div className="font-mono text-xs text-muted">{a.buckets[b].count}</div>
                  </td>
                ))}
              </tr>
            ))}
          </Table>
        </Card>
      )}
      <p className="m-0 text-sm" data-testid="codr-mismatches">
        {t("cod.mismatches", r.mismatches)}{" "}
        <Link href="/cod?tab=mismatch" className="text-accent hover:underline">
          {t("cod.board")}
        </Link>
      </p>
      <Note>{t("cod.note")}</Note>
    </>
  );
}

// ───────────────────────── 5. review ─────────────────────────

export async function ReviewView({ ctx, range }: Props) {
  const t = await getTranslations("reports");
  const format = await getFormatter();
  const pct = pctOf(format);
  const r = await reviewReport(ctx, range);
  const sec = (ms: number | null) =>
    ms == null ? "—" : `${format.number(ms / 1000, { maximumFractionDigits: 0 })} s`;
  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        {(["NEEDS_REVIEW", "ON_HOLD", "BLOCKED"] as const).map((s) => (
          <Link
            key={s}
            href={`/orders?tab=${s === "NEEDS_REVIEW" ? "review" : "blocked"}`}
            className="no-underline text-ink"
          >
            <Kpi
              label={`${t("review.open")}: ${t(`review.openStates.${s}`)}`}
              value={r.open[s]}
              testid={`kpi-${s}`}
            />
          </Link>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mt-0 mb-3 text-lg font-semibold">{t("review.findings")}</h2>
          {r.findings.length === 0 ? (
            <p className="m-0 text-muted">{t("empty")}</p>
          ) : (
            <Table
              label={t("review.findings")}
              head={[t("review.col.code"), t("review.col.severity"), t("review.col.orders")]}
            >
              {r.findings.map((f) => (
                <tr key={`${f.code}:${f.severity}`} data-testid={`finding-${f.code}`}>
                  <td className={tdCls}>
                    <div className="font-mono text-sm">{f.code}</div>
                  </td>
                  <td className={tdCls}>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${f.severity === "hard" ? "bg-block-bg text-block" : "bg-warn-bg text-warn"}`}
                    >
                      {f.severity === "hard" || f.severity === "soft"
                        ? t(`review.severity.${f.severity}`)
                        : (f.severity ?? "—")}
                    </span>
                  </td>
                  <td className={mono}>{f.n}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card>
          <h2 className="mt-0 mb-3 text-lg font-semibold">{t("review.decisions")}</h2>
          {r.decisions.length === 0 ? (
            <p className="m-0 text-muted">{t("empty")}</p>
          ) : (
            <Table
              label={t("review.decisions")}
              head={[t("review.col.decision"), t("review.col.count"), t("review.col.avg")]}
            >
              {r.decisions.map((d) => (
                <tr key={d.decision} data-testid={`decision-${d.decision}`}>
                  <td className={tdCls}>{t(`review.decision.${d.decision}`)}</td>
                  <td className={mono}>
                    {d.count} <span className="text-xs text-muted">{pct(rate(d.count, r.decided))}</span>
                  </td>
                  <td className={mono}>{sec(d.avgMs)}</td>
                </tr>
              ))}
            </Table>
          )}
          <h3 className="mt-4 mb-2 text-base font-semibold">{t("review.reasons")}</h3>
          {r.reasons.length === 0 ? (
            <p className="m-0 text-muted">{t("empty")}</p>
          ) : (
            <Table label={t("review.reasons")} head={[t("review.col.reason"), t("review.col.count")]}>
              {r.reasons.map((x) => (
                <tr key={x.code} data-testid={`reason-${x.code}`}>
                  <td className={tdCls}>
                    {x.labelBg ?? x.code}
                    <span className="ml-1 font-mono text-xs text-muted">{x.code}</span>
                  </td>
                  <td className={mono}>{x.count}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
      <Card>
        <h2 className="mt-0 mb-3 text-lg font-semibold">{t("review.ai.title")}</h2>
        {!r.ai ? (
          <p className="m-0 text-muted" data-testid="ai-none">
            {t("review.ai.none")}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="ai-stats">
            <Kpi label={t("review.ai.suggestions")} value={r.ai.suggestions} />
            <Kpi
              label={`${t("review.ai.agreement")} · ${t("review.ai.target", { value: pct(r.ai.target) })}`}
              value={
                <>
                  {pct(r.ai.agreement)}{" "}
                  <span className="text-xs text-muted">
                    {t("review.ai.evaluated", { agreed: r.ai.agreed, evaluated: r.ai.evaluated })}
                  </span>
                </>
              }
              testid="ai-agreement"
            />
            <Kpi label={t("review.ai.fixes")} value={pct(r.ai.fixesAgreement)} />
            <Kpi label={t("review.ai.critical")} value={r.ai.criticalMisses} />
            <Kpi label={t("review.ai.autopilot")} value={r.ai.autopilot} />
          </div>
        )}
      </Card>
      <Note>{t("review.note")}</Note>
    </>
  );
}

// ───────────────────────── 6. stock ─────────────────────────

export async function StockView({ ctx }: Props) {
  const t = await getTranslations("reports");
  const format = await getFormatter();
  const r = await stockReport(ctx);
  const list = (title: string, rows: typeof r.runningOut, total: number, testid: string, filter: string) => (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-lg font-semibold">
          {title} <span className="font-mono text-sm text-muted">{total}</span>
        </h2>
        <Link href={`/products/stock?filter=${filter}`} className="text-sm text-accent hover:underline">
          {t("stock.board")}
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 text-muted">{t("empty")}</p>
      ) : (
        <Table
          label={title}
          head={[
            t("stock.col.product"),
            t("stock.col.sellable"),
            t("stock.col.physical"),
            t("stock.col.sold", { days: r.salesWindowDays }),
            t("stock.col.daysLeft"),
            t("stock.col.open"),
            t("stock.col.lines"),
          ]}
        >
          {rows.map((p) => (
            <tr key={p.id} data-testid={`${testid}-${p.sku}`}>
              <td className={tdCls}>
                <Link href={`/products/stock?p=${p.id}`} className="text-accent hover:underline">
                  {p.name}
                </Link>
                {p.isTester && (
                  <span className="ml-1 rounded-full bg-warn-bg px-1.5 text-[11px] text-warn">
                    {t("stock.tester")}
                  </span>
                )}
                <div className="font-mono text-xs text-muted">
                  {p.sku}
                  {p.stale && ` · ${t("stock.stale")}`}
                </div>
              </td>
              <td className={mono}>{p.sellable}</td>
              <td className={mono}>{p.physical}</td>
              <td className={mono}>{p.sold}</td>
              <td className={mono}>
                {p.daysLeft == null ? "—" : format.number(p.daysLeft, { maximumFractionDigits: 1 })}
              </td>
              <td className={mono}>{p.open?.units ?? 0}</td>
              <td className={mono}>{p.open?.lines ?? 0}</td>
            </tr>
          ))}
        </Table>
      )}
      {total > rows.length && (
        <p className="mb-0 text-sm text-muted">{t("stock.shown", { shown: rows.length, total })}</p>
      )}
    </Card>
  );
  return (
    <>
      {list(
        t("stock.runningOut", { days: r.runOutDays }),
        r.runningOut,
        r.runningOutTotal,
        "runout",
        "runningOut",
      )}
      {list(t("stock.zeroOpen"), r.zeroOpen, r.zeroOpenTotal, "zeroopen", "zero")}
      {r.truncated && <p className="m-0 text-sm text-warn">{t("stock.truncated")}</p>}
      <Note>{t("stock.note", { window: r.salesWindowDays })}</Note>
    </>
  );
}
