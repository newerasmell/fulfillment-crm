import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { LinkVendorProductForm } from "@/app/(app)/warehouses/fhb/forms";
import { FhbChip, Pager, Tabs, hrefWith, monoCls } from "@/app/(app)/warehouses/fhb/ui";
import { Card } from "@/components/ui/PageHeader";
import { ghostButtonCls, inputCls, tdCls, thCls } from "@/components/ui/form";
import {
  STOCK_FILTERS,
  fhbMovements,
  fhbStockBoard,
  fhbVendorProductDetail,
  type StockFilter,
} from "@/server/fhb/mirror";

/**
 * "Продукти и наличности" modelled on ZOE Stock (docs/DESIGN.md screen 4): tabs, search by name / SKU / FHB
 * codes / EAN, quick filters with counts, our SKU + EAN next to FHB's (with "реален, от FHB" when FHB corrected
 * it), FHB internal and external code, physical / free, state; 50 per page; right panel with codes, EANs,
 * stock and last movements. Reads the local mirror only.
 */

export type BoardParams = { view?: string; q?: string; filter?: string; page?: string; vp?: string };

export async function StockBoard({
  accountId,
  connectionIds,
  base,
  params,
  extra = {},
  canLink,
}: {
  accountId: string;
  connectionIds: string[];
  base: string;
  params: BoardParams;
  /** Params of the hosting page to keep in every link (e.g. tab=products). */
  extra?: Record<string, string>;
  canLink: boolean;
}) {
  const t = await getTranslations("fhb");
  const format = await getFormatter();
  const view = params.view === "movements" ? "movements" : "stock";
  const filter = (STOCK_FILTERS as string[]).includes(params.filter ?? "")
    ? (params.filter as StockFilter)
    : "all";
  const page = Math.max(1, Number(params.page) || 1);
  const q = params.q ?? "";
  const keep = {
    ...extra,
    view: view === "stock" ? undefined : view,
    q: q || undefined,
    filter: filter === "all" ? undefined : filter,
  };

  const tabs = (
    <Tabs
      label={t("stock.views")}
      items={[
        {
          href: hrefWith(base, { ...extra }, {}),
          title: t("stock.tabStock"),
          original: "Stock",
          active: view === "stock" && filter !== "bundles" && filter !== "archived",
        },
        {
          href: hrefWith(base, { ...extra }, { view: "movements" }),
          title: t("stock.tabMovements"),
          original: "Stock movements",
          active: view === "movements",
        },
        {
          href: hrefWith(base, { ...extra }, { filter: "bundles" }),
          title: t("stock.tabBundles"),
          original: "Multi-products",
          active: view === "stock" && filter === "bundles",
        },
        {
          href: hrefWith(base, { ...extra }, { filter: "archived" }),
          title: t("stock.tabArchive"),
          original: "Archive",
          active: view === "stock" && filter === "archived",
        },
      ]}
    />
  );
  const search = (
    <form method="get" action={base} className="flex flex-wrap items-center gap-2" role="search">
      {Object.entries({ ...extra, view: keep.view, filter: keep.filter }).map(
        ([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />,
      )}
      <input
        name="q"
        defaultValue={q}
        placeholder={t("stock.searchPlaceholder")}
        aria-label={t("stock.search")}
        className={`${inputCls} w-80`}
      />
      <button type="submit" className={ghostButtonCls}>
        {t("stock.search")}
      </button>
    </form>
  );

  if (view === "movements") {
    const { rows, total } = await fhbMovements(accountId, connectionIds, { q, page });
    return (
      <Card>
        {tabs}
        <div className="mt-3">{search}</div>
        {rows.length === 0 ? (
          <p className="mb-0 text-muted">{t("stock.noMovements")}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>{t("stock.date")}</th>
                  <th className={thCls}>{t("stock.fhbId")}</th>
                  <th className={thCls}>{t("stock.product")}</th>
                  <th className={thCls}>{t("stock.direction")}</th>
                  <th className={`${thCls} text-right`}>{t("stock.change")}</th>
                  <th className={`${thCls} text-right`}>{t("stock.after")}</th>
                  <th className={thCls}>{t("stock.reason")}</th>
                  <th className={thCls}>{t("stock.reference")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const raw = (m.raw ?? {}) as {
                    product?: string;
                    quantity?: number;
                    reason?: string;
                    order?: string | null;
                    stock_receipt?: string | null;
                  };
                  return (
                    <tr key={m.id}>
                      <td className={`${tdCls} whitespace-nowrap`}>
                        {format.dateTime(m.occurredAt, { dateStyle: "short", timeStyle: "short" })}
                      </td>
                      <td className={`${tdCls} ${monoCls}`}>
                        {m.vendorProduct?.vendorId ?? raw.product ?? "—"}
                      </td>
                      <td className={tdCls}>{m.vendorProduct?.product?.name ?? "—"}</td>
                      <td className={tdCls}>
                        {m.kind === "in" ? t("stock.in") : m.kind === "out" ? t("stock.out") : m.kind}
                        <span className="ml-1 text-xs text-label">{m.kind}</span>
                      </td>
                      <td
                        className={`${tdCls} ${monoCls} text-right ${m.quantity < 0 ? "text-block" : "text-ok"}`}
                      >
                        {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                      </td>
                      <td className={`${tdCls} ${monoCls} text-right`}>{raw.quantity ?? "—"}</td>
                      <td className={tdCls}>{raw.reason ?? "—"}</td>
                      <td className={`${tdCls} ${monoCls}`}>{raw.order ?? raw.stock_receipt ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pager
          base={base}
          params={{ ...extra, view: "movements", q: q || undefined }}
          page={page}
          total={total}
        />
      </Card>
    );
  }

  const { rows, total, counts } = await fhbStockBoard(accountId, connectionIds, { q, filter, page });
  const detail = params.vp ? await fhbVendorProductDetail(accountId, connectionIds, params.vp) : null;
  const quick: StockFilter[] = ["all", "inStock", "zero", "testers", "unmatched"];

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <Card>
        {tabs}
        <div className="mt-3 flex flex-col gap-3">
          {search}
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label={t("stock.quickFilters")}>
            {quick.map((f) => (
              <li key={f}>
                <Link
                  href={hrefWith(
                    base,
                    { ...extra, q: q || undefined },
                    { filter: f === "all" ? undefined : f },
                  )}
                  aria-current={filter === f ? "true" : undefined}
                  className={`inline-flex min-h-10 items-center gap-1 rounded-full border px-3 text-[13px] ${
                    filter === f
                      ? "border-accent bg-accent-soft font-semibold text-accent-strong"
                      : "border-line"
                  }`}
                >
                  {t(`stock.filter.${f}`)}
                  <span className="font-mono text-[12px] text-muted">{counts[f]}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        {rows.length === 0 ? (
          <p className="mb-0 mt-3 text-muted">{t("stock.empty")}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>{t("stock.product")}</th>
                  <th className={thCls}>{t("stock.ourSku")}</th>
                  <th className={thCls}>{t("stock.fhbCodes")}</th>
                  <th className={`${thCls} text-right`}>{t("stock.physical")}</th>
                  <th className={`${thCls} text-right`}>{t("stock.free")}</th>
                  <th className={thCls}>{t("stock.state")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const raw = (r.raw ?? {}) as { name?: string; type?: string };
                  const ourEans = r.product?.eans.map((e) => e.ean) ?? [];
                  const corrected = !!r.vendorEan && ourEans.length > 0 && !ourEans.includes(r.vendorEan);
                  return (
                    <tr key={r.id} className={params.vp === r.id ? "bg-accent-soft" : undefined}>
                      <td className={tdCls}>
                        <Link
                          href={hrefWith(base, { ...keep, page: String(page) }, { vp: r.id })}
                          className="font-medium text-accent hover:underline"
                        >
                          {r.product?.name ?? raw.name ?? r.vendorId}
                        </Link>
                        {r.product?.isTester && (
                          <span className="ml-2 rounded-full bg-warn-bg px-2 py-0.5 text-[11px] font-semibold text-warn">
                            TESTER
                          </span>
                        )}
                        {raw.type === "multi" && (
                          <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-strong">
                            {t("stock.bundle")}
                          </span>
                        )}
                        {connectionIds.length > 1 && (
                          <div className="text-xs text-muted">{r.connection.name}</div>
                        )}
                      </td>
                      <td className={tdCls}>
                        <div className={monoCls}>
                          {r.product?.sku ?? <span className="text-warn">{t("stock.unlinked")}</span>}
                        </div>
                        <div className="text-xs text-muted">
                          {r.vendorEan ? (
                            <>
                              <span className="font-mono">{r.vendorEan}</span>{" "}
                              {corrected ? t("stock.eanReal") : t("stock.eanAtWarehouse")}
                            </>
                          ) : (
                            "—"
                          )}
                        </div>
                      </td>
                      <td className={tdCls}>
                        <div className={monoCls}>{r.vendorId}</div>
                        <div className={`${monoCls} text-muted`}>{r.vendorCode ?? "—"}</div>
                      </td>
                      <td className={`${tdCls} ${monoCls} text-right`}>{r.stockLevel?.physical ?? "—"}</td>
                      <td className={`${tdCls} ${monoCls} text-right font-semibold`}>
                        {r.stockLevel?.free ?? "—"}
                      </td>
                      <td className={tdCls}>
                        {r.archived ? (
                          <span className="text-muted">{t("stock.archived")}</span>
                        ) : (r.stockLevel?.free ?? 0) > 0 ? (
                          <span className="text-ok">{t("stock.available")}</span>
                        ) : (
                          <span className="text-block">{t("stock.out0")}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pager base={base} params={keep} page={page} total={total} />
      </Card>
      <aside aria-label={t("stock.panel")}>
        <Card>
          {!detail ? (
            <p className="m-0 text-sm text-muted">{t("stock.panelEmpty")}</p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <FhbChip />
                <h2 className="m-0 text-base font-semibold">
                  {detail.product?.name ?? ((detail.raw ?? {}) as { name?: string }).name ?? detail.vendorId}
                </h2>
              </div>
              <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted">{t("stock.ourSku")}</dt>
                <dd className={`m-0 ${monoCls}`}>{detail.product?.sku ?? "—"}</dd>
                <dt className="text-muted">{t("stock.fhbId")}</dt>
                <dd className={`m-0 ${monoCls}`}>{detail.vendorId}</dd>
                <dt className="text-muted">{t("stock.fhbInternal")}</dt>
                <dd className={`m-0 ${monoCls}`}>{detail.vendorCode ?? "—"}</dd>
                <dt className="text-muted">{t("stock.fhbEan")}</dt>
                <dd className={`m-0 ${monoCls}`}>{detail.vendorEan ?? "—"}</dd>
                <dt className="text-muted">{t("stock.ourEans")}</dt>
                <dd className={`m-0 ${monoCls}`}>
                  {detail.product?.eans.length
                    ? detail.product.eans.map((e) => <div key={e.id}>{e.ean}</div>)
                    : "—"}
                </dd>
                <dt className="text-muted">{t("stock.connection")}</dt>
                <dd className="m-0">{detail.connection.name}</dd>
                <dt className="text-muted">{t("stock.physical")}</dt>
                <dd className={`m-0 ${monoCls}`}>{detail.stockLevel?.physical ?? "—"}</dd>
                <dt className="text-muted">{t("stock.free")}</dt>
                <dd className={`m-0 ${monoCls}`}>{detail.stockLevel?.free ?? "—"}</dd>
                <dt className="text-muted">{t("stock.snapshot")}</dt>
                <dd className="m-0">
                  {detail.stockLevel
                    ? `${format.relativeTime(detail.stockLevel.snapshotAt, new Date())} · ${t(`stock.source.${detail.stockLevel.source}`)}`
                    : "—"}
                </dd>
              </dl>
              <p className="m-0 text-xs text-muted">{t("stock.eanNeverKey")}</p>
              {!detail.productId && canLink && <LinkVendorProductForm vendorProductId={detail.id} />}
              <h3 className="m-0 text-sm font-semibold">{t("stock.lastMovements")}</h3>
              {detail.movements.length === 0 ? (
                <p className="m-0 text-sm text-muted">{t("stock.noMovements")}</p>
              ) : (
                <ul className="m-0 list-none p-0 text-sm">
                  {detail.movements.map((m) => (
                    <li key={m.id} className="flex justify-between border-b border-line-soft py-1">
                      <span>{format.dateTime(m.occurredAt, { dateStyle: "short" })}</span>
                      <span className={`${monoCls} ${m.quantity < 0 ? "text-block" : "text-ok"}`}>
                        {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <a
                href="https://zoe2.fhb.sk"
                target="_blank"
                rel="noreferrer"
                className="text-sm text-accent hover:underline"
              >
                {t("stock.batchesInZoe")}
              </a>
            </div>
          )}
        </Card>
      </aside>
    </div>
  );
}
