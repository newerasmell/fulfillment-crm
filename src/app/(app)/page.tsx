import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { requireAccountContext } from "@/server/auth/session";
import { dashboardSummary } from "@/server/orders";
import { StatusChip } from "./orders/status";

/** Phase 1: order-based numbers. Returns, tickets, stock-outs and warehouse splits arrive with phases 2–4. */
const ATTENTION = [
  { key: "review", href: "/orders?tab=review" },
  { key: "blocked", href: "/orders?tab=blocked" },
  { key: "errors", href: "/orders?tab=blocked" },
  { key: "returns", href: "/returns" },
  { key: "tickets", href: "/tickets" },
  { key: "stockouts", href: "/products" },
] as const;

export default async function HomePage() {
  const ctx = await requireAccountContext();
  const t = await getTranslations();
  const format = await getFormatter();
  const today = format.dateTime(new Date(), { weekday: "long", day: "numeric", month: "long" });
  const scopeName = ctx.companies.find((c) => c.id === ctx.activeCompanyId)?.name ?? t("nav.allCompanies");
  const summary = await dashboardSummary(ctx);
  const value = (k: string) => (summary.attention as Record<string, number>)[k];
  const delta = (a: number, b: number) => (a === b ? "=" : a > b ? `+${a - b}` : `−${b - a}`);
  const kpis = [
    { key: "orders", now: summary.today.orders, before: summary.yesterday.orders },
    { key: "items", now: summary.today.items, before: summary.yesterday.items },
    { key: "countries", now: summary.today.countries, before: summary.yesterday.countries },
  ];
  return (
    <>
      <PageHeader title={t("pages.home.title")} subtitle={`${today} · ${scopeName}`} />
      <section aria-labelledby="attention" className="flex flex-col gap-3">
        <h2 id="attention" className="m-0 text-base font-semibold">
          {t("pages.home.attention")}
        </h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {ATTENTION.map(({ key, href }) => (
            <Link
              key={key}
              href={href}
              className="flex min-h-24 flex-col justify-between rounded-[var(--radius-card)] border border-line bg-surface p-4 text-ink no-underline hover:border-[#C9CFEA]"
            >
              <span className="text-[13px] text-muted">{t(`attention.${key}`)}</span>
              <span className="font-mono text-3xl font-semibold">{value(key) ?? "—"}</span>
            </Link>
          ))}
        </div>
      </section>
      <section aria-labelledby="today" className="flex flex-col gap-3">
        <h2 id="today" className="m-0 text-base font-semibold">
          {t("pages.home.today")}
        </h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {kpis.map((k) => (
            <div
              key={k.key}
              className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-line bg-surface p-4"
            >
              <span className="text-[13px] text-muted">{t(`pages.home.kpi.${k.key}`)}</span>
              <span className="font-mono text-3xl font-semibold">{k.now}</span>
              <span className="text-xs text-muted">
                {t("pages.home.vsYesterday", { delta: delta(k.now, k.before) })}
              </span>
            </div>
          ))}
          <div className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-line bg-surface p-4">
            <span className="text-[13px] text-muted">{t("pages.home.kpi.cod")}</span>
            {summary.today.cod.length === 0 ? (
              <span className="font-mono text-3xl font-semibold">0</span>
            ) : (
              summary.today.cod.map((c) => (
                <span key={c.currency} className="font-mono text-lg font-semibold">
                  {format.number(c.amount, { style: "currency", currency: c.currency })}
                </span>
              ))
            )}
          </div>
        </div>
      </section>
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("pages.home.recent")}</h2>
        {summary.recent.length === 0 ? (
          <p className="m-0 text-muted">{t("pages.home.empty")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {summary.recent.map((o) => (
              <li key={o.id} className="flex min-h-11 flex-wrap items-center gap-3 border-b border-line-soft">
                <Link href={`/orders/${o.id}`} className="font-mono font-medium text-accent hover:underline">
                  {o.number}
                </Link>
                <span>{o.customerName ?? "—"}</span>
                <span className="text-muted">{o.store?.name}</span>
                <span className="ml-auto flex items-center gap-3">
                  <StatusChip status={o.status} />
                  <span className="text-xs text-muted">
                    {format.dateTime(o.createdAt, { dateStyle: "short", timeStyle: "short" })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
