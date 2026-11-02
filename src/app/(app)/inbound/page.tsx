import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { hrefWith, Tabs } from "@/app/(app)/warehouses/fhb/ui";
import { ConnectionChip, monoCls } from "@/app/(app)/products/stock/ui";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { buttonCls, ghostButtonCls, inputCls, tdCls, thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { requireAccountContext } from "@/server/auth/session";
import { StatusText } from "./ui";
import { INBOUND_PAGE_SIZE, INBOUND_TABS, listInbounds, type InboundTab } from "@/server/stock/inbound";

/** "Приемане на стока" (P5-02): FHB stock receipts and euShipments booking requests in one list. */
export default async function InboundPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string; c?: string; page?: string }>;
}) {
  const ctx = await requireAccountContext();
  const t = await getTranslations("stock.inbound");
  const format = await getFormatter();
  const sp = await searchParams;
  const tab: InboundTab = (INBOUND_TABS as readonly string[]).includes(sp.tab ?? "")
    ? (sp.tab as InboundTab)
    : "open";
  const q = (sp.q ?? "").slice(0, 100);
  const page = Math.max(1, Number(sp.page) || 1);
  const data = await listInbounds(ctx, { tab, q, connectionId: sp.c || undefined, page });
  const keep = { tab: tab === "open" ? undefined : tab, q: q || undefined, c: sp.c || undefined };
  const pages = Math.max(1, Math.ceil(data.total / INBOUND_PAGE_SIZE));
  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("intro")}
        actions={
          can(ctx.role, "inbound.manage") && data.connections.length > 0 ? (
            <Link href="/inbound/new" className={`${buttonCls} inline-flex items-center`}>
              {t("new")}
            </Link>
          ) : undefined
        }
      />
      <Card>
        <Tabs
          label={t("tabsLabel")}
          items={INBOUND_TABS.map((x) => ({
            href: hrefWith("/inbound", { q: keep.q, c: keep.c }, { tab: x === "open" ? undefined : x }),
            title: t(`tab.${x}`),
            original: x === "open" ? "Stock receipts / Приемане" : undefined,
            active: tab === x,
            count: data.counts[x],
          }))}
        />
        <form method="get" action="/inbound" className="mt-3 flex flex-wrap items-center gap-2" role="search">
          {keep.tab && <input type="hidden" name="tab" value={keep.tab} />}
          <input
            name="q"
            defaultValue={q}
            aria-label={t("search")}
            placeholder={t("searchPlaceholder")}
            className={`${inputCls} w-72`}
          />
          <select name="c" defaultValue={sp.c ?? ""} aria-label={t("warehouse")} className={inputCls}>
            <option value="">{t("allWarehouses")}</option>
            {data.connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button type="submit" className={ghostButtonCls}>
            {t("search")}
          </button>
        </form>
        {data.connections.length === 0 ? (
          <p className="mb-0 mt-3 text-muted">{t("noConnections")}</p>
        ) : data.rows.length === 0 ? (
          <p className="mb-0 mt-3 text-muted">{t("empty")}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("title")}>
              <thead>
                <tr>
                  <th className={thCls}>{t("ref")}</th>
                  <th className={thCls}>{t("warehouse")}</th>
                  <th className={thCls}>{t("status")}</th>
                  <th className={thCls}>{t("expectedDate")}</th>
                  <th className={`${thCls} text-right`}>{t("expected")}</th>
                  <th className={`${thCls} text-right`}>{t("received")}</th>
                  <th className={thCls}>{t("created")}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} data-testid={`inbound-row-${r.externalRef}`}>
                    <td className={tdCls}>
                      <Link href={`/inbound/${r.id}`} className={`${monoCls} text-accent hover:underline`}>
                        {r.externalRef}
                      </Link>
                      {r.vendorId && r.vendorId !== r.externalRef && (
                        <div className={`${monoCls} text-muted`}>{r.vendorId}</div>
                      )}
                    </td>
                    <td className={tdCls}>
                      <ConnectionChip type={r.connection.type} name={r.connection.name} />
                    </td>
                    <td className={tdCls}>
                      <StatusText status={r.status} t={t} />
                    </td>
                    <td className={tdCls}>
                      {r.expectedAt ? format.dateTime(r.expectedAt, { dateStyle: "medium" }) : "—"}
                    </td>
                    <td className={`${tdCls} ${monoCls} text-right`}>{r.totals.expected}</td>
                    <td
                      className={`${tdCls} ${monoCls} text-right ${r.totals.differing ? "font-semibold text-warn" : ""}`}
                    >
                      {r.totals.received ?? "—"}
                      {r.totals.differing > 0 && (
                        <div className="text-[11px]">{t("differing", { n: r.totals.differing })}</div>
                      )}
                    </td>
                    <td className={tdCls}>
                      {format.dateTime(r.createdAt, { dateStyle: "short", timeStyle: "short" })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <nav className="mt-3 flex gap-3 text-sm" aria-label={t("pager")}>
            {page > 1 && (
              <Link
                href={hrefWith("/inbound", keep, { page: String(page - 1) })}
                className="text-accent hover:underline"
              >
                ←
              </Link>
            )}
            <span className="text-muted">
              {page} / {pages}
            </span>
            {page < pages && (
              <Link
                href={hrefWith("/inbound", keep, { page: String(page + 1) })}
                className="text-accent hover:underline"
              >
                →
              </Link>
            )}
          </nav>
        )}
      </Card>
    </>
  );
}
