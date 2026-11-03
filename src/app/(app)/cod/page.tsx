import Link from "next/link";
import { cookies } from "next/headers";
import { getFormatter, getTranslations } from "next-intl/server";
import { isScope, SCOPE_COOKIE, SCOPE_TYPES } from "@/components/shell/scope";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, inputCls, tdCls, thCls } from "@/components/ui/form";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { COD_TABS, listCod, type CodTab } from "@/server/cod/board";
import { COD_BUCKETS, type CodBucket } from "@/server/cod/classify";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const AGE_BUCKETS = ["d0_7", "d8_14", "d15_30", "d30_plus"] as const;
const STATE_TONE: Record<string, string> = {
  none: "bg-block-bg text-block",
  waiting: "bg-warn-bg text-warn",
  received: "bg-accent-soft text-accent-strong",
  paid: "bg-ok-bg text-ok",
  unknown: "bg-block-bg text-block",
};

/** Наложен платеж (P6-02): expected vs reported COD per shipment, ageing, totals, mismatches, CSV. */
export default async function CodPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const ctx = await requireAccountContext("cod.read");
  const t = await getTranslations("cod");
  const format = await getFormatter();
  const rawScope = (await cookies()).get(SCOPE_COOKIE)?.value;
  const scope = isScope(rawScope) ? rawScope : "all";
  const tabRaw = one(sp.tab);
  const tab: CodTab = (COD_TABS as readonly string[]).includes(tabRaw ?? "")
    ? (tabRaw as CodTab)
    : "outstanding";
  const b = one(sp.bucket);
  const bucket = (COD_BUCKETS as readonly string[]).includes(b ?? "") ? (b as CodBucket) : undefined;
  const q = one(sp.q)?.slice(0, 80);
  const data = await listCod(
    { ...actorFrom(ctx), activeCompanyId: ctx.activeCompanyId, lineCompanyIds: ctx.lineCompanyIds },
    { tab, bucket, q, connectionTypes: scope === "all" ? undefined : SCOPE_TYPES[scope] },
  );
  const href = (over: Record<string, string | undefined>, base = "/cod") => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ tab, bucket, q, ...over })) if (v) p.set(k, v);
    return `${base}?${p.toString()}`;
  };
  const money = (n: number, currency: string) =>
    currency.length === 3
      ? format.number(n, { style: "currency", currency, maximumFractionDigits: 2 })
      : format.number(n, { maximumFractionDigits: 2 });
  const chip = (key: string, label: string, n: number, active: boolean, to: string, testid: string) => (
    <Link
      key={key}
      href={to}
      data-testid={testid}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-10 items-center gap-2 rounded-full border px-3 no-underline ${
        active ? "border-accent bg-accent-soft text-accent-strong" : "border-line bg-surface text-ink"
      }`}
    >
      {label}
      <span className="font-mono text-xs">{n}</span>
    </Link>
  );

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <a
            href={href({}, "/api/cod/export")}
            className={`${ghostButtonCls} inline-flex items-center no-underline`}
          >
            {t("export")}
          </a>
        }
      />
      <nav aria-label={t("title")} className="flex flex-wrap gap-2">
        {COD_TABS.map((k) =>
          chip(
            k,
            t(`tabs.${k}`),
            data.counts[k],
            tab === k,
            href({ tab: k, bucket: undefined }),
            `cod-tab-${k}`,
          ),
        )}
      </nav>
      {(tab === "outstanding" || tab === "all" || tab === "mismatch") && (
        <nav aria-label={t("bucket.label")} className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted">{t("bucket.label")}:</span>
          {chip(
            "allb",
            t("allBuckets"),
            data.counts[tab],
            !bucket,
            href({ bucket: undefined }),
            "cod-bucket-all",
          )}
          {AGE_BUCKETS.map((k) =>
            chip(k, t(`bucket.${k}`), data.buckets[k], bucket === k, href({ bucket: k }), `cod-bucket-${k}`),
          )}
        </nav>
      )}
      <form method="get" action="/cod" className="flex flex-wrap items-end gap-2" aria-label={t("search")}>
        <input type="hidden" name="tab" value={tab} />
        {bucket && <input type="hidden" name="bucket" value={bucket} />}
        <input
          name="q"
          defaultValue={q ?? ""}
          aria-label={t("search")}
          placeholder={t("search")}
          className={`${inputCls} min-w-72`}
        />
        <button type="submit" className={ghostButtonCls}>
          {t("apply")}
        </button>
      </form>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mt-0 mb-3 text-lg font-semibold">{t("totals")}</h2>
          {data.byCurrency.length === 0 ? (
            <p className="m-0 text-muted">—</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse" aria-label={t("totals")}>
                <thead>
                  <tr>
                    <th className={thCls}>{t("col.currency")}</th>
                    <th className={thCls}>{t("t.expected")}</th>
                    <th className={thCls}>{t("t.received")}</th>
                    <th className={thCls}>{t("t.paid")}</th>
                    <th className={thCls}>{t("t.outstanding")}</th>
                    <th className={thCls}>{t("t.count")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byCurrency.map((c) => (
                    <tr key={c.currency} data-testid={`cod-total-${c.currency}`}>
                      <td className={`${tdCls} font-mono`}>{c.currency}</td>
                      <td className={`${tdCls} font-mono`}>{money(c.expected, c.currency)}</td>
                      <td className={`${tdCls} font-mono`}>{money(c.received, c.currency)}</td>
                      <td className={`${tdCls} font-mono`}>{money(c.paid, c.currency)}</td>
                      <td className={`${tdCls} font-mono font-semibold`}>
                        {money(c.outstanding, c.currency)}
                      </td>
                      <td className={`${tdCls} font-mono`}>{c.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card>
          <h2 className="mt-0 mb-3 text-lg font-semibold">{t("byCompany")}</h2>
          {data.byCompany.length === 0 ? (
            <p className="m-0 text-muted">—</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse" aria-label={t("byCompany")}>
                <thead>
                  <tr>
                    <th className={thCls}>{t("col.company")}</th>
                    <th className={thCls}>{t("t.expected")}</th>
                    <th className={thCls}>{t("t.outstanding")}</th>
                    <th className={thCls}>{t("t.paid")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byCompany.flatMap((c) =>
                    c.totals.map((x) => (
                      <tr
                        key={`${c.companyId}:${x.currency}`}
                        data-testid={`cod-company-${c.company}-${x.currency}`}
                      >
                        <td className={tdCls}>{c.company}</td>
                        <td className={`${tdCls} font-mono`}>{money(x.expected, x.currency)}</td>
                        <td className={`${tdCls} font-mono`}>{money(x.outstanding, x.currency)}</td>
                        <td className={`${tdCls} font-mono`}>{money(x.paid, x.currency)}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card>
        {(data.mismatches.amount > 0 || data.mismatches.missing > 0 || data.mismatches.unexpected > 0) && (
          <p className="mt-0 text-sm text-warn" data-testid="cod-mismatch-summary">
            {t("mismatch.amount")}: {data.mismatches.amount} · {t("mismatch.missing")}:{" "}
            {data.mismatches.missing} · {t("mismatch.unexpected")}: {data.mismatches.unexpected}.{" "}
            <Link href="/alerts" className="text-accent hover:underline">
              {t("mismatchHint")}
            </Link>
          </p>
        )}
        {data.rows.length === 0 ? (
          <p className="m-0 text-muted">{t("empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("title")}>
              <thead>
                <tr>
                  <th className={thCls}>{t("col.order")}</th>
                  <th className={thCls}>{t("col.warehouse")}</th>
                  <th className={thCls}>{t("col.delivered")}</th>
                  <th className={thCls}>{t("col.expected")}</th>
                  <th className={thCls}>{t("col.vendor")}</th>
                  <th className={thCls}>{t("col.paid")}</th>
                  <th className={thCls}>{t("col.mismatch")}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.fulfillmentId} data-testid={`cod-row-${r.orderNumber}`}>
                    <td className={tdCls}>
                      <Link href={`/orders/${r.orderId}`} className="font-mono text-accent hover:underline">
                        {r.orderNumber}
                      </Link>
                      <div className="font-mono text-xs text-muted">{r.externalId}</div>
                      {r.company && <div className="text-xs text-muted">{r.company}</div>}
                    </td>
                    <td className={tdCls}>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
                          r.connection.type === "EUSHIPMENTS"
                            ? "bg-eu-chip text-eu-text"
                            : "bg-fhb-chip text-fhb-text"
                        }`}
                      >
                        <span
                          aria-hidden
                          className={`size-2 rounded-full ${r.connection.type === "EUSHIPMENTS" ? "bg-eu" : "bg-fhb"}`}
                        />
                        {r.connection.name}
                      </span>
                      {r.country && <div className="text-xs text-muted">{r.country}</div>}
                    </td>
                    <td className={`${tdCls} text-sm`}>
                      {r.deliveredAt ? (
                        <>
                          <div>{format.dateTime(r.deliveredAt, { dateStyle: "medium" })}</div>
                          <div className="text-xs text-muted">
                            {t("days", { days: r.ageDays ?? 0 })} · {t(`bucket.${r.bucket}`)}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted">{t("notDelivered")}</span>
                      )}
                    </td>
                    <td className={`${tdCls} font-mono`}>
                      {r.expected ? money(r.expected.amount, r.expected.currency) : "—"}
                    </td>
                    <td className={tdCls}>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${STATE_TONE[r.vendor.state] ?? ""}`}
                      >
                        {t(`state.${r.vendor.state}`)}
                      </span>
                      {r.vendor.raw && r.vendor.raw !== r.vendor.state && (
                        <span className="ml-1 text-xs text-muted">
                          {r.vendor.raw === "registered" ? t("registered") : r.vendor.raw}
                        </span>
                      )}
                      {r.vendor.amount != null && (
                        <div className="font-mono text-sm">
                          {money(r.vendor.amount, r.expected?.currency ?? "")}
                        </div>
                      )}
                    </td>
                    <td className={`${tdCls} text-sm`}>
                      {r.vendor.paidAt ? format.dateTime(r.vendor.paidAt, { dateStyle: "medium" }) : "—"}
                      {r.vendor.protocol && (
                        <div className="text-xs text-muted">
                          {t("protocol", { number: r.vendor.protocol })}
                        </div>
                      )}
                    </td>
                    <td className={tdCls}>
                      {r.mismatch ? (
                        <span className="rounded-full bg-block-bg px-2 py-0.5 text-xs text-block">
                          {t(`mismatch.${r.mismatch}`)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.total > data.rows.length && (
              <p className="mb-0 text-sm text-muted">
                {t("shown", { shown: data.rows.length, total: data.total })}
              </p>
            )}
          </div>
        )}
      </Card>
    </>
  );
}
