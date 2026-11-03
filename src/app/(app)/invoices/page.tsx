import Link from "next/link";
import { cookies } from "next/headers";
import { getFormatter, getTranslations } from "next-intl/server";
import { isScope, SCOPE_COOKIE, SCOPE_TYPES } from "@/components/shell/scope";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, inputCls, tdCls, thCls } from "@/components/ui/form";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { INVOICE_TABS, listInvoices } from "@/server/directory/invoices";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
/** The ZOE cabinet URL already used on Складове и връзки and Продукти. */
const ZOE_URL = "https://zoe2.fhb.sk";

/**
 * Фактури (P10-05): accounting is a v1 non-goal and no vendor documents an invoice list endpoint, so the
 * warehouses' own invoices stay in their cabinets. This shows where to find them and the per-order invoice
 * fields FHB documents and the CRM already mirrors (FhbOrderMirror.raw). Read-only; never a vendor call.
 */
export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const ctx = await requireAccountContext("invoices.read");
  const t = await getTranslations("invoices");
  const format = await getFormatter();
  const rawScope = (await cookies()).get(SCOPE_COOKIE)?.value;
  const scope = isScope(rawScope) ? rawScope : "all";
  const data = await listInvoices(
    { ...actorFrom(ctx), activeCompanyId: ctx.activeCompanyId, lineCompanyIds: ctx.lineCompanyIds },
    { tab: one(sp.tab), q: one(sp.q), page: one(sp.page) },
    scope === "all" ? undefined : SCOPE_TYPES[scope],
  );
  const f = data.filter;
  const href = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ tab: f.tab, q: f.q, ...over }))
      if (v !== undefined && v !== "") p.set(k, String(v));
    return `/invoices?${p.toString()}`;
  };
  const fhb = data.connections.filter((c) => c.type === "FHB_V3");
  const eu = data.connections.filter((c) => c.type === "EUSHIPMENTS");

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("whereTitle")}</h2>
        <p className="mt-0 text-sm">{t("whereText")}</p>
        {data.connections.length === 0 ? (
          <p className="m-0 text-sm text-muted">{t("noConnections")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="invoice-cabinets">
            {fhb.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-fhb-chip px-2 py-0.5 text-xs text-fhb-text">
                  <span aria-hidden className="size-2 rounded-full bg-fhb" />
                  {c.name}
                </span>
                <span className="text-sm text-muted">{c.company?.name ?? ""}</span>
                <a
                  href={ZOE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-accent hover:underline"
                >
                  {t("openZoe")}
                </a>
              </li>
            ))}
            {eu.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-eu-chip px-2 py-0.5 text-xs text-eu-text">
                  <span aria-hidden className="size-2 rounded-full bg-eu" />
                  {c.name}
                </span>
                <span className="text-sm text-muted">{c.company?.name ?? ""}</span>
                <span className="text-sm">{t("inEu")}</span>
                <span className="text-xs text-muted">{t("euNoUrl")}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mb-0 mt-3 text-xs text-muted">{t("nonGoal")}</p>
      </Card>

      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("perOrderTitle")}</h2>
        <p className="mt-0 text-sm text-muted">{t("perOrderText")}</p>
        <nav aria-label={t("perOrderTitle")} className="mb-3 flex flex-wrap gap-2">
          {INVOICE_TABS.map((k) => (
            <Link
              key={k}
              href={href({ tab: k, page: undefined })}
              data-testid={`invoices-tab-${k}`}
              aria-current={f.tab === k ? "page" : undefined}
              className={`flex min-h-10 items-center gap-2 rounded-full border px-3 no-underline ${
                f.tab === k
                  ? "border-accent bg-accent-soft text-accent-strong"
                  : "border-line bg-surface text-ink"
              }`}
            >
              {t(`tabs.${k}`)}
              <span className="font-mono text-xs">{data.counts[k]}</span>
            </Link>
          ))}
        </nav>
        <form method="get" action="/invoices" className="mb-3 flex flex-wrap items-end gap-2" role="search">
          <input type="hidden" name="tab" value={f.tab} />
          <input
            name="q"
            defaultValue={f.q ?? ""}
            aria-label={t("search")}
            placeholder={t("search")}
            className={`${inputCls} min-w-72`}
          />
          <button type="submit" className={ghostButtonCls}>
            {t("apply")}
          </button>
        </form>
        {data.rows.length === 0 ? (
          <p className="m-0 text-muted">{t(fhb.length ? "empty" : "noFhb")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("perOrderTitle")}>
              <thead>
                <tr>
                  <th className={thCls}>{t("col.order")}</th>
                  <th className={thCls}>{t("col.warehouse")}</th>
                  <th className={thCls}>{t("col.number")}</th>
                  <th className={thCls}>{t("col.date")}</th>
                  <th className={thCls}>{t("col.pdf")}</th>
                  <th className={thCls}>{t("col.status")}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} data-testid={`invoice-${r.externalId}`}>
                    <td className={tdCls}>
                      {r.order ? (
                        <Link
                          href={`/orders/${r.order.id}`}
                          className="font-mono text-accent hover:underline"
                        >
                          {r.order.number}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted">{t("noCrmOrder")}</span>
                      )}
                      <div className="font-mono text-xs text-muted">{r.externalId}</div>
                    </td>
                    <td className={tdCls}>
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-fhb-chip px-2 py-0.5 text-xs text-fhb-text">
                        <span aria-hidden className="size-2 rounded-full bg-fhb" />
                        {r.connection.name}
                      </span>
                      {r.country && <div className="text-xs text-muted">{r.country}</div>}
                    </td>
                    <td className={`${tdCls} font-mono text-[13px]`}>{r.invoiceNumber ?? "—"}</td>
                    <td className={`${tdCls} font-mono text-[13px]`}>{r.invoiceDate ?? "—"}</td>
                    <td className={tdCls}>
                      {r.invoiceUrl ? (
                        <a
                          href={r.invoiceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent hover:underline"
                        >
                          {t("openPdf")}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={`${tdCls} text-sm`}>
                      <span className="font-mono text-xs">{r.rawStatus ?? "—"}</span>
                      <div className="text-xs text-muted">
                        {t("synced")}{" "}
                        {format.dateTime(r.lastSyncAt, { dateStyle: "short", timeStyle: "short" })}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.pages > 1 && (
          <nav aria-label={t("pages")} className="mt-3 flex items-center gap-3 text-sm">
            {data.page > 1 && (
              <Link href={href({ page: data.page - 1 })} className="text-accent hover:underline">
                ← {t("prev")}
              </Link>
            )}
            <span>{t("pageOf", { page: data.page, pages: data.pages })}</span>
            {data.page < data.pages && (
              <Link href={href({ page: data.page + 1 })} className="text-accent hover:underline">
                {t("next")} →
              </Link>
            )}
          </nav>
        )}
        <p className="mb-0 mt-3 text-xs text-muted">{t("euAwbNote")}</p>
      </Card>
    </>
  );
}
