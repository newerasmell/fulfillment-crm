import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { hrefWith, Tabs } from "@/app/(app)/warehouses/fhb/ui";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, inputCls, tdCls, thCls } from "@/components/ui/form";
import { listOpenAlerts } from "@/server/alerts";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import {
  BOARD_FILTERS,
  BOARD_PAGE_SIZE,
  BOARD_VIEWS,
  SALES_WINDOW_DAYS,
  stockBoard,
  stockMovements,
  stockProductDetail,
  type BoardFilter,
  type BoardRow,
  type BoardView,
  type MismatchWhy,
} from "@/server/stock/board";
import { STOCK_ALERT_KINDS } from "@/server/stock/discrepancies";
import { INBOUND_ALERT_KINDS } from "@/server/stock/inbound";
import { getStockSettings } from "@/server/stock/settings";
import { StockSettingsForm } from "./forms";
import { ConnectionChip, monoCls, TesterBadge } from "./ui";

/**
 * "Продукти и наличности" (DESIGN.md screen 4, P5-01): master products of the selected product line with one
 * column per warehouse and per store, modelled on ZOE Stock. Reads the local mirrors only.
 */

type Params = { view?: string; q?: string; filter?: string; page?: string; p?: string };
const BASE = "/products/stock";
const NOTICE_KINDS = new Set<string>([
  ...STOCK_ALERT_KINDS,
  ...INBOUND_ALERT_KINDS,
  "eushipments_inbound_discrepancy",
]);

export default async function StockPage({ searchParams }: { searchParams: Promise<Params> }) {
  const ctx = await requireAccountContext();
  const t = await getTranslations("stock");
  const params = await searchParams;
  const view: BoardView = (BOARD_VIEWS as readonly string[]).includes(params.view ?? "")
    ? (params.view as BoardView)
    : "stock";
  const filter: BoardFilter = (BOARD_FILTERS as readonly string[]).includes(params.filter ?? "")
    ? (params.filter as BoardFilter)
    : "all";
  const page = Math.max(1, Number(params.page) || 1);
  const q = (params.q ?? "").slice(0, 100);
  const keep = {
    view: view === "stock" ? undefined : view,
    q: q || undefined,
    filter: filter === "all" ? undefined : filter,
  };
  const tabs = (
    <Tabs
      label={t("views")}
      items={(
        [
          ["stock", "Stock"],
          ["movements", "Stock movements"],
          ["bundles", "Multi-products"],
          ["archive", "Archive"],
          ["notices", "Notifications"],
        ] as const
      ).map(([v, original]) => ({
        href: hrefWith(BASE, {}, { view: v === "stock" ? undefined : v }),
        title: t(`tab.${v}`),
        original,
        active: view === v,
      }))}
    />
  );

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("intro")}
        actions={
          <div className="flex flex-wrap gap-2">
            {can(ctx.role, "inbound.manage") && (
              <Link href="/inbound/new" className={`${ghostButtonCls} inline-flex items-center`}>
                {t("newInbound")}
              </Link>
            )}
            <Link href="/products" className={`${ghostButtonCls} inline-flex items-center`}>
              {t("toMasters")}
            </Link>
          </div>
        }
      />
      {view === "movements" ? (
        <Movements ctx={ctx} tabs={tabs} q={q} page={page} />
      ) : view === "notices" ? (
        <Notices ctx={ctx} tabs={tabs} />
      ) : (
        <Board
          ctx={ctx}
          tabs={tabs}
          view={view}
          filter={filter}
          q={q}
          page={page}
          keep={keep}
          selected={params.p}
        />
      )}
    </>
  );
}

type Ctx = Awaited<ReturnType<typeof requireAccountContext>>;

function SearchForm({
  q,
  keep,
  label,
  placeholder,
  button,
}: {
  q: string;
  keep: Record<string, string | undefined>;
  label: string;
  placeholder: string;
  button: string;
}) {
  return (
    <form method="get" action={BASE} className="flex flex-wrap items-center gap-2" role="search">
      {Object.entries(keep).map(([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />)}
      <input
        name="q"
        defaultValue={q}
        placeholder={placeholder}
        aria-label={label}
        className={`${inputCls} w-80`}
      />
      <button type="submit" className={ghostButtonCls}>
        {button}
      </button>
    </form>
  );
}

async function Pager({
  params,
  page,
  total,
}: {
  params: Record<string, string | undefined>;
  page: number;
  total: number;
}) {
  const t = await getTranslations("stock");
  const pages = Math.max(1, Math.ceil(total / BOARD_PAGE_SIZE));
  return (
    <nav aria-label={t("pager.label")} className="mt-3 flex items-center gap-3 text-sm">
      {page > 1 ? (
        <Link
          href={hrefWith(BASE, params, { page: String(page - 1) })}
          className="text-accent hover:underline"
        >
          {t("pager.prev")}
        </Link>
      ) : (
        <span className="text-label">{t("pager.prev")}</span>
      )}
      <span className="text-muted">{t("pager.of", { page, pages, total })}</span>
      {page < pages ? (
        <Link
          href={hrefWith(BASE, params, { page: String(page + 1) })}
          className="text-accent hover:underline"
        >
          {t("pager.next")}
        </Link>
      ) : (
        <span className="text-label">{t("pager.next")}</span>
      )}
    </nav>
  );
}

async function Board({
  ctx,
  tabs,
  view,
  filter,
  q,
  page,
  keep,
  selected,
}: {
  ctx: Ctx;
  tabs: React.ReactNode;
  view: BoardView;
  filter: BoardFilter;
  q: string;
  page: number;
  keep: Record<string, string | undefined>;
  selected?: string;
}) {
  const t = await getTranslations("stock");
  const format = await getFormatter();
  const board = await stockBoard(ctx, { view, q, filter, page });
  const detail = selected ? await stockProductDetail(ctx, selected) : null;
  const now = new Date();
  const age = (d: Date | null) => (d ? format.relativeTime(d, now) : "—");

  if (board.connections.length === 0 && board.stores.length === 0)
    return (
      <Card>
        {tabs}
        <p className="mb-0 mt-3 text-muted">{t("noWarehouses")}</p>
      </Card>
    );

  const state = (r: BoardRow) =>
    r.archived ? (
      <span className="text-muted">{t("state.archived")}</span>
    ) : r.flags.runningOut ? (
      <span className="text-warn">
        {t("state.runningOut", { days: Math.max(0, Math.floor(r.daysLeft ?? 0)) })}
      </span>
    ) : r.flags.inStock ? (
      <span className="text-ok">{t("state.inStock")}</span>
    ) : (
      <span className="text-block">{t("state.zero")}</span>
    );

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <Card className="min-w-0">
        {tabs}
        <div className="mt-3 flex flex-col gap-3">
          <SearchForm
            q={q}
            keep={{ view: keep.view, filter: keep.filter }}
            label={t("search")}
            placeholder={t("searchPlaceholder")}
            button={t("search")}
          />
          {view === "stock" && (
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label={t("quickFilters")}>
              {BOARD_FILTERS.map((f) => (
                <li key={f}>
                  <Link
                    href={hrefWith(BASE, { q: q || undefined }, { filter: f === "all" ? undefined : f })}
                    aria-current={filter === f ? "true" : undefined}
                    className={`inline-flex min-h-10 items-center gap-1 rounded-full border px-3 text-[13px] ${
                      filter === f
                        ? "border-accent bg-accent-soft font-semibold text-accent-strong"
                        : "border-line"
                    }`}
                  >
                    {t(`filter.${f}`, { days: board.settings.runOutDays })}
                    <span className="font-mono text-[12px] text-muted">{board.counts[f]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        {board.truncated && <p className="mt-3 text-sm text-warn">{t("truncated")}</p>}
        {board.rows.length === 0 ? (
          <p className="mb-0 mt-3 text-muted">{t("empty")}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("tableLabel")}>
              <thead>
                <tr>
                  <th className={thCls}>{t("col.product")}</th>
                  <th className={thCls}>{t("col.sku")}</th>
                  {board.connections.map((c) => (
                    <th key={c.id} className={`${thCls} text-right normal-case`}>
                      <ConnectionChip type={c.type} name={c.name} />
                      <div className="mt-1 text-[11px] font-normal tracking-normal">{t("col.cellHint")}</div>
                    </th>
                  ))}
                  {board.stores.map((s) => (
                    <th key={s.id} className={`${thCls} text-right`}>
                      Shopify · {s.code}
                    </th>
                  ))}
                  <th className={`${thCls} text-right`}>{t("col.total")}</th>
                  <th className={thCls}>{t("col.state")}</th>
                </tr>
              </thead>
              <tbody>
                {board.rows.map((r) => (
                  <tr
                    key={r.id}
                    data-testid={`stock-row-${r.sku}`}
                    className={selected === r.id ? "bg-accent-soft" : undefined}
                  >
                    <td className={`${tdCls} ${r.isTester && r.parentProductId ? "pl-8" : ""}`}>
                      <Link
                        href={hrefWith(BASE, { ...keep, page: String(page) }, { p: r.id })}
                        className="font-medium text-accent hover:underline"
                      >
                        {r.name}
                      </Link>
                      {r.isTester && <TesterBadge />}
                      {r.isBundle && (
                        <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-strong">
                          {t("bundle")}
                        </span>
                      )}
                    </td>
                    <td className={tdCls}>
                      <div className={monoCls}>{r.sku}</div>
                      <div className="text-xs text-muted">
                        {r.eans[0] ? <span className="font-mono">{r.eans[0]}</span> : "—"}
                      </div>
                    </td>
                    {board.connections.map((c) => {
                      const cell = r.cells[c.id];
                      if (!cell)
                        return (
                          <td key={c.id} className={`${tdCls} text-right text-label`}>
                            {t("notAtWarehouse")}
                          </td>
                        );
                      return (
                        <td key={c.id} className={`${tdCls} text-right`}>
                          <div className={`${monoCls} text-[15px] font-semibold`} title={t("sellable")}>
                            {cell.sellable}
                          </div>
                          <div className={`${monoCls} text-[11px] text-muted`}>
                            {cell.physical} · {cell.free} · {cell.reserved}
                          </div>
                          <div
                            className={`text-[11px] ${cell.stale ? "font-semibold text-warn" : "text-label"}`}
                          >
                            {cell.snapshotAt
                              ? `${age(cell.snapshotAt)} · ${t(`source.${cell.source}`)}`
                              : t("noSnapshot")}
                            {cell.stale && ` · ${t("stale")}`}
                          </div>
                        </td>
                      );
                    })}
                    {board.stores.map((s) => {
                      const sc = r.shopify[s.id];
                      return (
                        <td key={s.id} className={`${tdCls} text-right`}>
                          {sc?.available === null || sc === undefined ? (
                            <span className="text-label">—</span>
                          ) : (
                            <>
                              <div className={`${monoCls} ${sc.mismatch ? "font-semibold text-warn" : ""}`}>
                                {sc.available}
                              </div>
                              {sc.variants.length > 1 && (
                                <div
                                  className="text-[11px] text-muted"
                                  title={sc.variants
                                    .map(
                                      (v) =>
                                        `${v.title ?? "—"} · ${v.sku ?? "—"} · ${v.variantGid?.split("/").pop() ?? ""}: ${v.available}`,
                                    )
                                    .join("\n")}
                                >
                                  {t("shopifyListings", {
                                    n: sc.variants.length,
                                    each: sc.variants.map((v) => v.available).join(" + "),
                                  })}
                                </div>
                              )}
                              {sc.unmappedAvailable > 0 && sc.mapped.length > 0 && (
                                <div className="text-[11px] text-muted">
                                  {t("shopifyOtherLocations", { n: sc.unmappedAvailable })}
                                </div>
                              )}
                              {sc.mismatch && <div className="text-[11px] text-warn">{t("mismatch")}</div>}
                              {sc.mismatch && (
                                <MismatchWhyHint
                                  why={sc.why}
                                  mapped={sc.mapped.map((m) => ({
                                    name: board.connections.find((c) => c.id === m.connectionId)?.name ?? "—",
                                    available: m.available,
                                    sellable: m.sellable,
                                  }))}
                                />
                              )}
                            </>
                          )}
                        </td>
                      );
                    })}
                    <td className={`${tdCls} ${monoCls} text-right font-semibold`}>{r.totalSellable}</td>
                    <td className={tdCls}>{state(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager params={keep} page={page} total={board.total} />
      </Card>
      <aside aria-label={t("panel.label")}>
        <Card>
          {!detail ? (
            <p className="m-0 text-sm text-muted">{t("panel.empty")}</p>
          ) : (
            <ProductPanel detail={detail} />
          )}
        </Card>
      </aside>
    </div>
  );
}

/** Why a differing Shopify cell is not corrected by the push: the planner's own reasons, one short line each. */
async function MismatchWhyHint({
  why,
  mapped,
}: {
  why: MismatchWhy | null;
  mapped: { name: string; available: number; sellable: number | null }[];
}) {
  if (!why) return null;
  const t = await getTranslations("stock.why");
  const format = await getFormatter();
  const at = (d: Date) => format.dateTime(d, { dateStyle: "short", timeStyle: "short" });
  const lines: React.ReactNode[] = why.store.map((b) => t(`store.${b}`));
  for (const l of why.locations) {
    const w = l.why;
    const where = l.sku ? `${l.locationName} (${l.sku})` : l.locationName;
    const text =
      w.kind === "will_push"
        ? t("loc.will_push", { target: w.target })
        : w.kind === "applied_waiting_read"
          ? t("loc.applied_waiting_read", { target: w.target, at: at(w.at) })
          : w.kind === "overwritten"
            ? t("loc.overwritten", { target: w.target, at: at(w.at) })
            : w.kind === "failed"
              ? t("loc.failed", { at: at(w.at), error: w.error ?? "—" })
              : t(`loc.${w.kind}`);
    lines.push(
      w.kind === "suspicious_link" ? (
        <Link href="/products#suspicious-links" className="underline">
          {`${where}: ${text}`}
        </Link>
      ) : (
        `${where}: ${text}`
      ),
    );
  }
  if (!lines.length) return null;
  return (
    <div
      className="ml-auto max-w-[16rem] text-[11px] text-muted"
      title={mapped
        .map((m) => t("perLocation", { name: m.name, shopify: m.available, sellable: m.sellable ?? 0 }))
        .join("\n")}
    >
      {lines.map((r, i) => (
        <div key={i}>{r}</div>
      ))}
    </div>
  );
}

async function ProductPanel({
  detail,
}: {
  detail: NonNullable<Awaited<ReturnType<typeof stockProductDetail>>>;
}) {
  const t = await getTranslations("stock");
  const format = await getFormatter();
  const now = new Date();
  const { product, row, connections, stores } = detail;
  const conn = new Map(connections.map((c) => [c.id, c]));
  const store = new Map(stores.map((s) => [s.id, s]));
  const ourEans = product.eans.map((e) => e.ean);
  return (
    <div className="flex flex-col gap-3" data-testid="stock-panel">
      <div>
        <h2 className="m-0 text-base font-semibold">
          {product.name}
          {product.isTester && <TesterBadge />}
        </h2>
        <div className={`${monoCls} text-muted`}>{product.sku}</div>
        <Link href={`/products/${product.id}`} className="text-sm text-accent hover:underline">
          {(await getTranslations("weights"))("productLink")}
        </Link>
        {product.parent && (
          <div className="text-xs text-muted">
            {t("panel.testerOf")} <span className="font-mono">{product.parent.sku}</span>
          </div>
        )}
        {product.testers.length > 0 && (
          <div className="text-xs text-muted">
            {t("panel.testers")} {product.testers.map((x) => x.sku).join(", ")}
          </div>
        )}
      </div>

      <section>
        <h3 className="m-0 mb-1 text-sm font-semibold">{t("panel.codes")}</h3>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
          {product.vendorProducts.map((v) => {
            const c = conn.get(v.connectionId);
            const corrected = !!v.vendorEan && ourEans.length > 0 && !ourEans.includes(v.vendorEan);
            return (
              <li key={v.id} className="flex flex-wrap items-center gap-2">
                {c && <ConnectionChip type={c.type} name={c.name} />}
                <span className={monoCls}>{v.vendorId}</span>
                {v.vendorCode && <span className={`${monoCls} text-muted`}>{v.vendorCode}</span>}
                {v.vendorEan && (
                  <span className="text-xs text-muted">
                    EAN <span className="font-mono">{v.vendorEan}</span>{" "}
                    {corrected ? t("panel.eanReal") : t("panel.eanAtWarehouse")}
                  </span>
                )}
                {v.archived && <span className="text-xs text-muted">{t("state.archived")}</span>}
              </li>
            );
          })}
          {product.vendorProducts.length === 0 && <li className="text-muted">{t("panel.noCodes")}</li>}
        </ul>
      </section>

      <section>
        <h3 className="m-0 mb-1 text-sm font-semibold">{t("panel.eanHistory")}</h3>
        {product.eans.length === 0 ? (
          <p className="m-0 text-sm text-muted">—</p>
        ) : (
          <ul className="m-0 list-none p-0 text-sm">
            {product.eans.map((e) => (
              <li
                key={e.ean + e.createdAt.toISOString()}
                className="flex justify-between gap-2 border-b border-line-soft py-1"
              >
                <span className={monoCls}>{e.ean}</span>
                <span className="text-xs text-muted">
                  {[e.note, e.source, format.dateTime(e.createdAt, { dateStyle: "short" })]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="m-0 mt-1 text-xs text-muted">{t("panel.eanNeverKey")}</p>
      </section>

      <section>
        <h3 className="m-0 mb-1 text-sm font-semibold">{t("panel.stock")}</h3>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="text-left text-xs text-label">{t("panel.warehouse")}</th>
              <th className="text-right text-xs text-label">{t("physical")}</th>
              <th className="text-right text-xs text-label">{t("free")}</th>
              <th className="text-right text-xs text-label">{t("reserved")}</th>
              <th className="text-right text-xs text-label">{t("sellable")}</th>
            </tr>
          </thead>
          <tbody>
            {Object.values(row.cells).map((c) => (
              <tr key={c.connectionId}>
                <td className="py-1">
                  {conn.get(c.connectionId)?.name}
                  <div className={`text-[11px] ${c.stale ? "text-warn" : "text-label"}`}>
                    {c.snapshotAt
                      ? `${format.relativeTime(c.snapshotAt, now)} · ${t(`source.${c.source}`)}`
                      : t("noSnapshot")}
                  </div>
                </td>
                <td className={`${monoCls} text-right`}>{c.physical}</td>
                <td className={`${monoCls} text-right`}>{c.free}</td>
                <td className={`${monoCls} text-right`}>{c.reserved}</td>
                <td className={`${monoCls} text-right font-semibold`}>{c.sellable}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {detail.euStock.length > 0 && (
          <ul className="m-0 mt-2 list-none p-0 text-xs text-muted">
            {detail.euStock.map((e) => (
              <li key={e.connectionId + e.warehouseName}>
                {e.warehouseName}: <span className="font-mono">{e.availQty}</span>
                {e.availDate &&
                  ` · ${format.dateTime(e.availDate, { dateStyle: "short", timeStyle: "short" })}`}
              </li>
            ))}
          </ul>
        )}
        <p className="m-0 mt-1 text-xs text-muted">
          {t("panel.sales", { sold: row.sold, days: SALES_WINDOW_DAYS })}
          {row.daysLeft !== null && ` · ${t("panel.daysLeft", { days: Math.floor(row.daysLeft) })}`}
        </p>
      </section>

      <section>
        <h3 className="m-0 mb-1 text-sm font-semibold">{t("panel.shopify")}</h3>
        {detail.shopifyLevels.length === 0 ? (
          <p className="m-0 text-sm text-muted">{t("panel.noShopify")}</p>
        ) : (
          <ul className="m-0 list-none p-0 text-sm">
            {detail.shopifyLevels.map((l) => (
              <li
                key={l.storeId + l.locationGid}
                className="flex justify-between gap-2 border-b border-line-soft py-1"
              >
                <span>
                  {store.get(l.storeId)?.name} · {l.location?.name ?? l.locationGid}
                  {l.location?.connectionId && (
                    <span className="ml-1 text-xs text-muted">
                      → {conn.get(l.location.connectionId)?.name}
                    </span>
                  )}
                </span>
                <span className={monoCls}>{l.tracked ? l.available : t("panel.untracked")}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail.inbound.length > 0 && (
        <section>
          <h3 className="m-0 mb-1 text-sm font-semibold">{t("panel.inbound")}</h3>
          <ul className="m-0 list-none p-0 text-sm">
            {detail.inbound.map((i) => (
              <li key={i.inbound.id} className="flex justify-between gap-2 py-1">
                <Link href={`/inbound/${i.inbound.id}`} className={`${monoCls} text-accent hover:underline`}>
                  {i.inbound.externalRef}
                </Link>
                <span className={monoCls}>
                  {i.receivedQty ?? 0}/{i.expectedQty}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="m-0 mb-1 text-sm font-semibold">{t("panel.movements")}</h3>
        {detail.movements.length === 0 ? (
          <p className="m-0 text-sm text-muted">{t("noMovements")}</p>
        ) : (
          <ul className="m-0 list-none p-0 text-sm">
            {detail.movements.map((m) => (
              <li key={m.id} className="flex justify-between border-b border-line-soft py-1">
                <span>
                  {format.dateTime(m.occurredAt, { dateStyle: "short" })}{" "}
                  <span className="text-xs text-muted">{conn.get(m.connectionId)?.name}</span>
                </span>
                <span className={`${monoCls} ${m.quantity < 0 ? "text-block" : "text-ok"}`}>
                  {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="flex flex-wrap gap-3 text-sm">
        <Link href={`/inbound/new?product=${product.id}`} className="text-accent hover:underline">
          {t("panel.receive")}
        </Link>
        <a
          href="https://zoe2.fhb.sk"
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          {t("panel.batchesInZoe")}
        </a>
      </div>
    </div>
  );
}

async function Movements({
  ctx,
  tabs,
  q,
  page,
}: {
  ctx: Ctx;
  tabs: React.ReactNode;
  q: string;
  page: number;
}) {
  const t = await getTranslations("stock");
  const format = await getFormatter();
  const { rows, total } = await stockMovements(ctx, { q, page });
  return (
    <Card>
      {tabs}
      <div className="mt-3">
        <SearchForm
          q={q}
          keep={{ view: "movements" }}
          label={t("search")}
          placeholder={t("searchPlaceholder")}
          button={t("search")}
        />
      </div>
      {rows.length === 0 ? (
        <p className="mb-0 mt-3 text-muted">{t("noMovements")}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>{t("mv.date")}</th>
                <th className={thCls}>{t("mv.warehouse")}</th>
                <th className={thCls}>{t("col.product")}</th>
                <th className={thCls}>{t("mv.direction")}</th>
                <th className={`${thCls} text-right`}>{t("mv.change")}</th>
                <th className={`${thCls} text-right`}>{t("mv.after")}</th>
                <th className={thCls}>{t("mv.reference")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const raw = (m.raw ?? {}) as {
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
                    <td className={tdCls}>
                      <ConnectionChip type={m.connection.type} name={m.connection.name} />
                    </td>
                    <td className={tdCls}>
                      <div>{m.vendorProduct?.product?.name ?? "—"}</div>
                      <div className={`${monoCls} text-muted`}>{m.vendorProduct?.vendorId ?? "—"}</div>
                    </td>
                    <td className={tdCls}>
                      {m.kind === "in" ? t("mv.in") : m.kind === "out" ? t("mv.out") : m.kind}
                      {raw.reason && <div className="text-xs text-label">{raw.reason}</div>}
                    </td>
                    <td
                      className={`${tdCls} ${monoCls} text-right ${m.quantity < 0 ? "text-block" : "text-ok"}`}
                    >
                      {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                    </td>
                    <td className={`${tdCls} ${monoCls} text-right`}>{raw.quantity ?? "—"}</td>
                    <td className={`${tdCls} ${monoCls}`}>{raw.order ?? raw.stock_receipt ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager params={{ view: "movements", q: q || undefined }} page={page} total={total} />
    </Card>
  );
}

async function Notices({ ctx, tabs }: { ctx: Ctx; tabs: React.ReactNode }) {
  const t = await getTranslations("stock");
  const format = await getFormatter();
  const [alerts, settings] = await Promise.all([
    listOpenAlerts({
      ...actorFrom(ctx),
      activeCompanyId: ctx.activeCompanyId,
      lineCompanyIds: ctx.lineCompanyIds,
    }),
    getStockSettings(ctx.accountId),
  ]);
  const notices = alerts.filter((a) => NOTICE_KINDS.has(a.kind));
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <Card>
        {tabs}
        {notices.length === 0 ? (
          <p className="mb-0 mt-3 text-muted">{t("notices.empty")}</p>
        ) : (
          <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0" aria-label={t("notices.label")}>
            {notices.map((a) => (
              <li key={a.id} className="rounded-[10px] border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{t(`notices.kind.${a.kind}`)}</span>
                  <span className="text-xs text-muted">{format.relativeTime(a.createdAt, new Date())}</span>
                </div>
                <div className="text-sm">{a.title}</div>
                {a.body && <div className={`${monoCls} whitespace-pre-line text-muted`}>{a.body}</div>}
                {a.entityType === "InboundShipment" && a.entityId && (
                  <Link href={`/inbound/${a.entityId}`} className="text-sm text-accent hover:underline">
                    {t("notices.openInbound")}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mb-0 mt-3 text-sm">
          <Link href="/alerts" className="text-accent hover:underline">
            {t("notices.toAlerts")}
          </Link>
        </p>
      </Card>
      <aside>
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("settings.title")}</h2>
          <StockSettingsForm values={settings} canEdit={can(ctx.role, "stock.settings")} />
        </Card>
      </aside>
    </div>
  );
}
