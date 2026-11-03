import Link from "next/link";
import { cookies } from "next/headers";
import { getFormatter, getTranslations } from "next-intl/server";
import { isScope, SCOPE_COOKIE, SCOPE_TYPES } from "@/components/shell/scope";
import { LineChip } from "@/components/ui/LineChip";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, inputCls, tdCls, thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { listTickets, TICKET_TABS, type TicketTab } from "@/server/tickets";
import { TicketReview } from "./ui";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
/** The plain ZOE address already used on Складове и връзки (FHB documents no deep link to a ticket). */
const ZOE_URL = "https://zoe2.fhb.sk";
const STATE_TONE: Record<string, string> = {
  OPEN: "bg-warn-bg text-warn",
  UPDATED: "bg-accent-soft text-accent-strong",
  CLOSED: "bg-ok-bg text-ok",
};

/** Тикети от склада (P10-02): FHB ticket notifications per shipment; text and replies stay in ZOE. */
export default async function TicketsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const ctx = await requireAccountContext();
  const t = await getTranslations("tickets");
  const format = await getFormatter();
  const rawScope = (await cookies()).get(SCOPE_COOKIE)?.value;
  const scope = isScope(rawScope) ? rawScope : "all";
  const tabRaw = one(sp.tab);
  const tab: TicketTab = (TICKET_TABS as readonly string[]).includes(tabRaw ?? "")
    ? (tabRaw as TicketTab)
    : "open";
  const q = one(sp.q)?.slice(0, 80);
  const rawPage = Number(one(sp.page));
  const data = await listTickets(
    { ...actorFrom(ctx), activeCompanyId: ctx.activeCompanyId, lineCompanyIds: ctx.lineCompanyIds },
    {
      tab,
      q,
      page: Number.isInteger(rawPage) && rawPage > 1 && rawPage < 10_000 ? rawPage : 1,
      connectionTypes: scope === "all" ? undefined : SCOPE_TYPES[scope],
    },
  );
  const review = can(ctx.role, "tickets.review");
  const href = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ tab, q, ...over })) {
      const sv = v == null ? "" : String(v);
      if (sv && !(k === "page" && sv === "1")) p.set(k, sv);
    }
    return `/tickets?${p.toString()}`;
  };
  const dt = (d: Date) => format.dateTime(d, { dateStyle: "short", timeStyle: "short" });

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <a
            href={ZOE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`${ghostButtonCls} inline-flex items-center no-underline`}
          >
            {t("openZoe")}
          </a>
        }
      />
      <Card className="flex flex-col gap-1 text-sm">
        <p className="m-0">{t("about.fhb")}</p>
        <p className="m-0 text-muted" data-testid="tickets-eu-note">
          {t("about.eu")}
        </p>
      </Card>
      <nav aria-label={t("tabsLabel")} className="flex flex-wrap gap-2">
        {TICKET_TABS.map((k) => (
          <Link
            key={k}
            href={href({ tab: k })}
            aria-current={tab === k ? "page" : undefined}
            data-testid={`tickets-tab-${k}`}
            className={`flex min-h-10 items-center gap-2 rounded-full border px-3 no-underline ${
              tab === k
                ? "border-accent bg-accent-soft text-accent-strong"
                : "border-line bg-surface text-ink"
            }`}
          >
            {t(`tabs.${k}`)}
            <span className="font-mono text-xs">{data.counts[k]}</span>
          </Link>
        ))}
      </nav>
      <form
        method="get"
        action="/tickets"
        className="flex flex-wrap items-end gap-2"
        aria-label={t("search")}
      >
        <input type="hidden" name="tab" value={tab} />
        <input
          name="q"
          type="search"
          defaultValue={q ?? ""}
          aria-label={t("search")}
          placeholder={t("search")}
          className={`${inputCls} min-w-72`}
        />
        <button type="submit" className={ghostButtonCls}>
          {t("apply")}
        </button>
      </form>
      <Card>
        {data.rows.length === 0 ? (
          <p className="m-0 text-muted">{t("empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("title")}>
              <thead>
                <tr>
                  <th className={thCls}>{t("col.state")}</th>
                  <th className={thCls}>{t("col.shipment")}</th>
                  <th className={thCls}>{t("col.warehouse")}</th>
                  <th className={thCls}>{t("col.company")}</th>
                  <th className={thCls}>{t("col.events")}</th>
                  <th className={thCls}>{t("col.age")}</th>
                  <th className={thCls}>{t("col.review")}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} data-testid={`ticket-${r.shipment.externalId}`} className="align-top">
                    <td className={tdCls}>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${STATE_TONE[r.state] ?? "bg-hover"}`}
                      >
                        {t(`state.${r.state}`)}
                      </span>
                      <div className="mt-1 font-mono text-xs text-muted" title={t("vendorEvent")}>
                        {r.lastEvent}
                      </div>
                    </td>
                    <td className={tdCls}>
                      <Link
                        href={`/orders/${r.order.id}`}
                        className="font-mono font-medium text-accent hover:underline"
                      >
                        {r.order.number}
                      </Link>
                      <div>
                        <Link
                          href={`/shipments?id=${r.shipment.id}`}
                          className="font-mono text-xs text-accent hover:underline"
                        >
                          {r.shipment.externalId} ›
                        </Link>
                      </div>
                      {r.shipment.trackingNumbers.length > 0 && (
                        <div className="font-mono text-xs text-muted">
                          {r.shipment.trackingNumbers.join(", ")}
                        </div>
                      )}
                    </td>
                    <td className={tdCls}>
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-fhb-chip px-2 py-0.5 text-xs text-fhb-text">
                        <span aria-hidden className="size-2 rounded-full bg-fhb" />
                        FHB
                      </span>
                      <div className="text-xs text-muted">{r.connection.name}</div>
                    </td>
                    <td className={tdCls}>
                      <span className="flex flex-col items-start gap-1">
                        {r.company?.line && (
                          <LineChip name={r.company.line.name} color={r.company.line.color} />
                        )}
                        {r.company ? (
                          <span className="rounded-full bg-hover px-2 py-0.5 text-xs">{r.company.name}</span>
                        ) : (
                          "—"
                        )}
                      </span>
                    </td>
                    <td className={`${tdCls} text-xs`}>
                      <div>{t("eventCount", { count: r.eventCount })}</div>
                      <div className="text-muted">{t("first", { date: dt(r.firstEventAt) })}</div>
                      <div className="text-muted">{t("last", { date: dt(r.lastEventAt) })}</div>
                    </td>
                    <td className={`${tdCls} font-mono text-sm`}>{t("days", { n: r.ageDays })}</td>
                    <td className={tdCls}>
                      <a
                        href={ZOE_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-accent hover:underline"
                      >
                        {t("openZoe")}
                      </a>
                      {r.reviewedAt && (
                        <div className="mt-1 text-xs" data-testid="ticket-reviewed">
                          <span className={r.reviewed ? "text-ok" : "text-warn"}>
                            {r.reviewed ? "✓ " : ""}
                            {t(r.reviewed ? "reviewedBy" : "reviewedBefore", {
                              name: r.reviewedBy ?? "—",
                              date: dt(r.reviewedAt),
                            })}
                          </span>
                          {r.reviewNote && (
                            <div className="text-muted">{t("note", { note: r.reviewNote })}</div>
                          )}
                        </div>
                      )}
                      {review && !r.reviewed && <TicketReview ticketId={r.id} reference={r.order.number} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.pages > 1 && (
          <nav aria-label={t("pagination")} className="mt-4 flex items-center gap-3">
            {data.page > 1 && (
              <Link
                href={href({ page: data.page - 1 })}
                className={`${ghostButtonCls} inline-flex items-center`}
              >
                ← {t("prev")}
              </Link>
            )}
            <span className="text-sm text-muted" data-testid="tickets-page">
              {t("pageOf", { page: data.page, pages: data.pages, total: data.total })}
            </span>
            {data.page < data.pages && (
              <Link
                href={href({ page: data.page + 1 })}
                className={`${ghostButtonCls} inline-flex items-center`}
              >
                {t("next")} →
              </Link>
            )}
          </nav>
        )}
      </Card>
    </>
  );
}
