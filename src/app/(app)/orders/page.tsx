import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, inputCls, tdCls, thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { requireAccountContext } from "@/server/auth/session";
import {
  isOrderTab,
  listOrders,
  ORDER_TABS,
  orderTabCounts,
  type OrderTab,
  orderListQuery,
} from "@/server/orders";
import { listStores } from "@/server/stores";
import { BulkBar, RowCheckbox, SelectAllCheckbox, SelectionProvider } from "./selection";
import { StatusChip } from "./status";
import { LineChip } from "@/components/ui/LineChip";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const ctx = await requireAccountContext();
  const t = await getTranslations("orders");
  const tl = await getTranslations("lines");
  const format = await getFormatter();
  const tabParam = one(sp.tab);
  const tab: OrderTab = isOrderTab(tabParam) ? tabParam : "review";
  const payment = one(sp.payment);
  const filters = {
    q: one(sp.q),
    storeId: one(sp.store),
    country: one(sp.country)?.slice(0, 2),
    payment: payment === "COD" || payment === "PREPAID" ? payment : undefined,
  } as const;
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const [result, counts, stores] = await Promise.all([
    listOrders(ctx, { ...filters, tab, page }),
    orderTabCounts(ctx, filters),
    // Archived stores stay in the filter: their orders are history and remain searchable.
    listStores(ctx, { includeArchived: true }),
  ]);
  const ts = await getTranslations("stores");
  // Carried to the order page: its J / K and "back" stay in this list.
  const listQuery = orderListQuery({ tab, ...filters });
  const href = (patch: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const merged = { tab, ...filters, store: filters.storeId, storeId: undefined, page: undefined, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== "") p.set(k, String(v));
    return `/orders?${p.toString()}`;
  };

  return (
    <>
      <PageHeader title={t("title")} />
      <nav aria-label={t("tabs")} className="flex flex-wrap gap-1 border-b border-line">
        {/* "Чака таг" only while something waits there (stores with "Само поръчки с таг"). */}
        {(Object.keys(ORDER_TABS) as OrderTab[])
          .filter(
            (k) =>
              (k !== "awaitingTag" || counts.awaitingTag > 0 || tab === "awaitingTag") &&
              (k !== "qtyHold" || counts.qtyHold > 0 || tab === "qtyHold"),
          )
          .map((k) => (
            <Link
              key={k}
              href={href({ tab: k })}
              aria-current={k === tab ? "page" : undefined}
              className={`-mb-px flex min-h-11 items-center gap-2 border-b-2 px-3 no-underline ${
                k === tab
                  ? "border-accent font-semibold text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {t(`tab.${k}`)}
              <span className="rounded-full bg-hover px-2 py-0.5 font-mono text-xs">{counts[k]}</span>
            </Link>
          ))}
      </nav>
      <SelectionProvider ids={result.rows.map((o) => o.id)}>
        <Card>
          <form className="mb-4 flex flex-wrap items-end gap-3" role="search">
            <input type="hidden" name="tab" value={tab} />
            <input
              name="q"
              defaultValue={filters.q}
              placeholder={t("search")}
              aria-label={t("search")}
              className={`${inputCls} w-72`}
            />
            <select
              name="store"
              defaultValue={filters.storeId ?? ""}
              aria-label={t("store")}
              className={inputCls}
            >
              <option value="">{t("allStores")}</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.archivedAt ? ` (${ts("archivedTag")})` : ""}
                </option>
              ))}
            </select>
            <input
              name="country"
              defaultValue={filters.country}
              placeholder={t("country")}
              aria-label={t("country")}
              maxLength={2}
              className={`${inputCls} w-24 uppercase`}
            />
            <select
              name="payment"
              defaultValue={filters.payment ?? ""}
              aria-label={t("payment")}
              className={inputCls}
            >
              <option value="">{t("allPayments")}</option>
              <option value="COD">{t("cod")}</option>
              <option value="PREPAID">{t("prepaid")}</option>
            </select>
            <button type="submit" className={ghostButtonCls}>
              {t("apply")}
            </button>
          </form>
          {result.rows.length === 0 ? (
            <p className="m-0 text-muted">{t("empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={`${thCls} w-10`}>
                      <SelectAllCheckbox />
                    </th>
                    <th className={thCls}>{t("number")}</th>
                    <th className={thCls}>{t("placed")}</th>
                    <th className={thCls}>{t("customer")}</th>
                    <th className={thCls}>{t("store")}</th>
                    <th className={thCls}>{tl("companyAndLine")}</th>
                    <th className={thCls}>{tl("warehouse")}</th>
                    <th className={thCls}>{t("country")}</th>
                    <th className={thCls}>{t("items")}</th>
                    <th className={`${thCls} text-right`}>{t("total")}</th>
                    <th className={thCls}>{t("payment")}</th>
                    <th className={thCls}>{t("status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((o) => (
                    <tr
                      key={o.id}
                      // Prepaid orders on a pale green background (owner request 2026-11-13).
                      className={o.paymentMethod === "COD" ? "hover:bg-hover" : "bg-ok-bg/60 hover:bg-hover"}
                      data-prepaid={o.paymentMethod === "COD" ? undefined : "1"}
                    >
                      <td className={tdCls}>
                        <RowCheckbox id={o.id} label={o.number} />
                      </td>
                      <td className={tdCls}>
                        <Link
                          href={`/orders/${o.id}?${listQuery}`}
                          className="font-mono font-medium text-accent hover:underline"
                        >
                          {o.number}
                        </Link>
                        {o.tags.includes("shopify-test") && (
                          <span className="ml-2 rounded-full bg-warn-bg px-2 py-0.5 text-xs text-warn">
                            {t("test")}
                          </span>
                        )}
                      </td>
                      <td className={`${tdCls} text-muted`}>
                        {format.dateTime(o.placedAt, { dateStyle: "short", timeStyle: "short" })}
                      </td>
                      <td className={tdCls}>{o.customerName ?? "—"}</td>
                      <td className={tdCls}>{o.store?.name ?? "—"}</td>
                      <td className={tdCls}>
                        <span className="flex flex-wrap items-center gap-1">
                          {o.company?.line && (
                            <LineChip name={o.company.line.name} color={o.company.line.color} />
                          )}
                          {o.company && (
                            <span className="rounded-full bg-hover px-2 py-0.5 text-xs">
                              {o.company.name}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className={tdCls}>
                        {o.warehouse ? (
                          <span className="flex flex-col gap-0.5">
                            <span className="flex items-center gap-1.5 text-[13px]">
                              <span
                                aria-hidden
                                className={`size-2 rounded-full ${o.warehouse.type === "EUSHIPMENTS" ? "bg-eu" : "bg-fhb"}`}
                              />
                              {o.warehouse.name}
                            </span>
                            {o.warehouse.otherCompany && (
                              <span
                                data-testid="other-company-warehouse"
                                title={tl("otherCompanyHint", { company: o.warehouse.companyName ?? "" })}
                                className="w-fit rounded-full bg-warn-bg px-2 py-0.5 text-xs text-warn"
                              >
                                {tl("otherCompanyWarehouse")}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className={`${tdCls} font-mono`}>{o.countryCode ?? "—"}</td>
                      <td className={tdCls}>{o._count.lines}</td>
                      <td className={`${tdCls} text-right font-mono`}>
                        {format.number(Number(o.total), { style: "currency", currency: o.currency })}
                      </td>
                      <td className={tdCls}>{o.paymentMethod === "COD" ? t("cod") : t("prepaid")}</td>
                      <td className={tdCls}>
                        <StatusChip status={o.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.pages > 1 && (
            <nav aria-label={t("pagination")} className="mt-4 flex items-center gap-3">
              {result.page > 1 && (
                <Link
                  href={href({ page: result.page - 1 })}
                  className={ghostButtonCls + " inline-flex items-center"}
                >
                  ←
                </Link>
              )}
              <span className="text-muted">
                {t("pageOf", { page: result.page, pages: result.pages, total: result.total })}
              </span>
              {result.page < result.pages && (
                <Link
                  href={href({ page: result.page + 1 })}
                  className={ghostButtonCls + " inline-flex items-center"}
                >
                  →
                </Link>
              )}
            </nav>
          )}
        </Card>
        <BulkBar canFulfill={can(ctx.role, "orders.fulfill")} />
      </SelectionProvider>
    </>
  );
}
