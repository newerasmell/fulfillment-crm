import Link from "next/link";
import { cookies } from "next/headers";
import { getFormatter, getTranslations } from "next-intl/server";
import { isScope, SCOPE_COOKIE, SCOPE_TYPES } from "@/components/shell/scope";
import { LineChip } from "@/components/ui/LineChip";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, inputCls, labelCls, tdCls, thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import {
  getShipment,
  listShipments,
  parseShipmentFilter,
  SHIPMENT_TABS,
  shipmentFilterOptions,
  type ShipmentView,
} from "@/server/shipments";
import { StatusChip } from "../orders/status";
import { ShipmentSettingsForm } from "./ui";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
/** The plain ZOE address already used on Складове и връзки (no deep links: none are documented). */
const ZOE_URL = "https://zoe2.fhb.sk";

const WAREHOUSE_DOT: Record<string, string> = { FHB_V3: "bg-fhb", FHB_JOY: "bg-fhb", EUSHIPMENTS: "bg-eu" };
const WAREHOUSE_CHIP: Record<string, string> = {
  FHB_V3: "bg-fhb-chip text-fhb-text",
  FHB_JOY: "bg-fhb-chip text-fhb-text",
  EUSHIPMENTS: "bg-eu-chip text-eu-text",
};

/** Товарителници (P10-01): every shipment of both warehouses (incl. Joy labels and AWBs), with tracking. */
export default async function ShipmentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const ctx = await requireAccountContext();
  const t = await getTranslations("shipmentList");
  const format = await getFormatter();
  const rawScope = (await cookies()).get(SCOPE_COOKIE)?.value;
  const scope = isScope(rawScope) ? rawScope : "all";
  const params = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, one(v)]));
  const parsed = parseShipmentFilter(params);
  const view: ShipmentView = parsed.view ?? "all";
  const connectionTypes = scope === "all" ? undefined : SCOPE_TYPES[scope];
  const actor = {
    ...actorFrom(ctx),
    activeCompanyId: ctx.activeCompanyId,
    lineCompanyIds: ctx.lineCompanyIds,
  };
  const detailId = one(sp.id)?.slice(0, 64);
  const [data, options, detail] = await Promise.all([
    listShipments(actor, { ...parsed, view, connectionTypes }),
    shipmentFilterOptions(actor, { connectionTypes }),
    detailId ? getShipment(actor, detailId).catch(() => null) : Promise.resolve(null),
  ]);
  const showCod = can(ctx.role, "cod.read");
  const state = {
    tab: view === "all" ? undefined : view,
    connection: parsed.connectionId,
    carrier: parsed.carrier,
    from: parsed.from,
    to: parsed.to,
    q: parsed.q,
    page: parsed.page && parsed.page > 1 ? parsed.page : undefined,
  } as Record<string, string | number | undefined>;
  const href = (over: Record<string, string | number | undefined>, base = "/shipments") => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...state, ...over }))
      if (v !== undefined && v !== "") p.set(k, String(v));
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };
  const date = (d: Date | null) => (d ? format.dateTime(d, { dateStyle: "short" }) : "—");
  const money = (n: number, currency: string) =>
    currency.length === 3
      ? format.number(n, { style: "currency", currency, maximumFractionDigits: 2 })
      : format.number(n, { maximumFractionDigits: 2 });
  const chip = (key: ShipmentView, n: number) => (
    <Link
      key={key}
      href={href({ tab: key === "all" ? undefined : key, page: undefined })}
      aria-current={view === key ? "page" : undefined}
      data-testid={`shipments-tab-${key}`}
      className={`flex min-h-10 items-center gap-2 rounded-full border px-3 no-underline ${
        view === key
          ? "border-accent bg-accent-soft text-accent-strong"
          : key === "delayed" && n > 0
            ? "border-line bg-warn-bg text-warn"
            : "border-line bg-surface text-ink"
      }`}
    >
      {t(`tabs.${key}`)}
      <span className="font-mono text-xs">{n}</span>
    </Link>
  );
  const warehouseLabel = (type: string) => (t.has(`type.${type}`) ? t(`type.${type}`) : type);

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <a
            href={href({}, "/api/shipments/export")}
            className={`${ghostButtonCls} inline-flex items-center no-underline`}
            data-testid="shipments-export"
          >
            {t("export")}
          </a>
        }
      />
      <nav aria-label={t("tabsLabel")} className="flex flex-wrap gap-2">
        {SHIPMENT_TABS.map((k) => chip(k, data.counts[k]))}
        <span aria-hidden className="mx-1 w-px self-stretch bg-line" />
        {chip("delayed", data.counts.delayed)}
      </nav>
      <p className="m-0 text-sm text-muted">{t("delayedHint", { days: data.settings.delayedDays })}</p>
      <form
        method="get"
        action="/shipments"
        className="flex flex-wrap items-end gap-2"
        aria-label={t("filters")}
      >
        {state.tab && <input type="hidden" name="tab" value={state.tab} />}
        <label className={labelCls}>
          {t("filter.warehouse")}
          <select name="connection" defaultValue={state.connection ?? ""} className={inputCls}>
            <option value="">{t("filter.allWarehouses")}</option>
            {options.connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {warehouseLabel(c.type)}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          {t("filter.carrier")}
          <select name="carrier" defaultValue={state.carrier ?? ""} className={inputCls}>
            <option value="">{t("filter.allCarriers")}</option>
            {options.carriers.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          {t("filter.from")}
          <input type="date" name="from" defaultValue={state.from ?? ""} className={inputCls} />
        </label>
        <label className={labelCls}>
          {t("filter.to")}
          <input type="date" name="to" defaultValue={state.to ?? ""} className={inputCls} />
        </label>
        <label className={labelCls}>
          {t("filter.search")}
          <input
            name="q"
            type="search"
            defaultValue={state.q ?? ""}
            placeholder={t("filter.searchPlaceholder")}
            className={`${inputCls} min-w-72`}
          />
        </label>
        <button type="submit" className={ghostButtonCls}>
          {t("filter.apply")}
        </button>
        <Link href="/shipments" className="flex min-h-10 items-center px-2 text-muted">
          {t("filter.clear")}
        </Link>
      </form>

      {detail && (
        <aside
          aria-label={t("detail.title", { id: detail.externalId })}
          data-testid="shipment-detail"
          className="fixed top-0 right-0 z-30 flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-line bg-surface p-5 shadow-xl"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="m-0 text-lg font-semibold">{t("detail.title", { id: detail.externalId })}</h2>
              <p className="m-0 text-sm text-muted">
                {detail.connection.name} · {warehouseLabel(detail.connection.type)}
              </p>
            </div>
            <Link href={href({ id: undefined })} className={ghostButtonCls + " inline-flex items-center"}>
              {t("detail.close")}
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={detail.status} />
            {detail.rawStatus && (
              <span className="text-xs text-muted" title={t("rawStatus")}>
                {detail.rawStatus}
              </span>
            )}
          </div>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">{t("detail.order")}</dt>
            <dd className="m-0">
              <Link href={`/orders/${detail.order.id}`} className="font-mono text-accent hover:underline">
                {detail.order.number}
              </Link>{" "}
              <span className="text-xs text-muted">{t("detail.timeline")}</span>
            </dd>
            {detail.vendorOrderId && (
              <>
                <dt className="text-muted">{t("detail.vendorId")}</dt>
                <dd className="m-0 font-mono">{detail.vendorOrderId}</dd>
              </>
            )}
            {detail.vendorUid && (
              <>
                <dt className="text-muted">{t("detail.vendorUid")}</dt>
                <dd className="m-0 font-mono">{detail.vendorUid}</dd>
              </>
            )}
            {detail.variableSymbol && (
              <>
                <dt className="text-muted">{t("detail.variableSymbol")}</dt>
                <dd className="m-0 font-mono">{detail.variableSymbol}</dd>
              </>
            )}
            <dt className="text-muted">{t("col.carrier")}</dt>
            <dd className="m-0">{detail.carrierName ?? "—"}</dd>
            <dt className="text-muted">{t("col.tracking")}</dt>
            <dd className="m-0 font-mono">
              {detail.tracking.items.length === 0 && "—"}
              {detail.tracking.items.map((i) => (
                <div key={i.number}>
                  {i.url ? (
                    <a href={i.url} target="_blank" rel="noopener noreferrer" className="text-accent">
                      {i.number} ↗
                    </a>
                  ) : (
                    i.number
                  )}
                </div>
              ))}
            </dd>
            {detail.deliveryPoint != null && (
              <>
                <dt className="text-muted">{t("detail.deliveryPoint")}</dt>
                <dd className="m-0 font-mono text-xs break-all">{JSON.stringify(detail.deliveryPoint)}</dd>
              </>
            )}
            {detail.ticketDetail && (
              <>
                <dt className="text-muted">{t("detail.ticket")}</dt>
                <dd className="m-0">
                  <Link href="/tickets?tab=all" className="text-accent hover:underline">
                    {t(`ticketState.${detail.ticketDetail.state}`)} ·{" "}
                    {t("detail.ticketEvents", { count: detail.ticketDetail.eventCount })}
                  </Link>
                </dd>
              </>
            )}
          </dl>
          <section>
            <h3 className="mt-0 mb-2 text-sm font-semibold">{t("detail.events")}</h3>
            {detail.events.length === 0 ? (
              <p className="m-0 text-sm text-muted">{t("detail.noEvents")}</p>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-2 p-0">
                {detail.events.map((e) => (
                  <li key={e.id} className="border-l-2 border-line pl-3 text-sm">
                    <div className="font-mono text-xs text-muted">
                      {format.dateTime(e.occurredAt, { dateStyle: "short", timeStyle: "short" })} · {e.source}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {e.status && <StatusChip status={e.status} />}
                      {e.rawStatus && <span className="text-xs text-muted">{e.rawStatus}</span>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <p className="m-0 text-sm text-muted">
            {detail.connection.type === "EUSHIPMENTS" ? (
              t("detail.moreInEu")
            ) : (
              <a href={ZOE_URL} target="_blank" rel="noopener noreferrer" className="text-accent">
                {t("detail.openZoe")}
              </a>
            )}
          </p>
        </aside>
      )}

      <Card>
        {data.rows.length === 0 ? (
          <p className="m-0 text-muted">{t("empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("title")}>
              <thead>
                <tr>
                  <th className={thCls}>{t("col.order")}</th>
                  <th className={thCls}>{t("col.company")}</th>
                  <th className={thCls}>{t("col.warehouse")}</th>
                  <th className={thCls}>{t("col.carrier")}</th>
                  <th className={thCls}>{t("col.tracking")}</th>
                  <th className={thCls}>{t("col.status")}</th>
                  {showCod && <th className={thCls}>{t("col.cod")}</th>}
                  <th className={thCls}>{t("col.dates")}</th>
                  <th className={thCls}>{t("col.age")}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} data-testid={`shipment-${r.externalId}`} className="align-top">
                    <td className={tdCls}>
                      <Link
                        href={`/orders/${r.order.id}`}
                        className="font-mono font-medium text-accent hover:underline"
                      >
                        {r.order.number}
                      </Link>
                      <div className="text-xs text-muted">{r.order.customerName ?? "—"}</div>
                      <Link
                        href={href({ id: r.id })}
                        scroll={false}
                        className="font-mono text-xs text-accent hover:underline"
                        aria-label={t("detail.open", { id: r.externalId })}
                      >
                        {r.externalId} ›
                      </Link>
                      {r.manualKind && (
                        <div className="mt-1">
                          <span className="rounded-full bg-hover px-2 py-0.5 text-xs">
                            {t.has(`manualKind.${r.manualKind}`)
                              ? t(`manualKind.${r.manualKind}`)
                              : r.manualKind}
                          </span>
                        </div>
                      )}
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
                    <td className={tdCls}>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${WAREHOUSE_CHIP[r.connection.type] ?? "bg-hover"}`}
                      >
                        <span
                          aria-hidden
                          className={`size-2 rounded-full ${WAREHOUSE_DOT[r.connection.type] ?? ""}`}
                        />
                        {warehouseLabel(r.connection.type)}
                      </span>
                      <div className="text-xs text-muted">{r.connection.name}</div>
                      {r.order.country && (
                        <div className="font-mono text-xs text-muted">{r.order.country}</div>
                      )}
                    </td>
                    <td className={`${tdCls} text-sm`}>
                      {r.carrierName ?? "—"}
                      {r.carrier && r.carrierName !== r.carrier && (
                        <div className="font-mono text-xs text-muted">{r.carrier}</div>
                      )}
                    </td>
                    <td className={`${tdCls} font-mono text-xs`}>
                      {r.tracking.items.length === 0 && <span className="text-muted">—</span>}
                      {r.tracking.items.map((i) => (
                        <div key={i.number}>
                          {i.url ? (
                            <a
                              href={i.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-accent hover:underline"
                            >
                              {i.number} ↗
                            </a>
                          ) : (
                            i.number
                          )}
                        </div>
                      ))}
                      {r.tracking.extraUrls.map((u, n) => (
                        <div key={u}>
                          <a
                            href={u}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-accent hover:underline"
                          >
                            {t("trackingLink", { n: n + 1 })} ↗
                          </a>
                        </div>
                      ))}
                    </td>
                    <td className={tdCls}>
                      <div className="flex flex-col items-start gap-1">
                        <StatusChip status={r.status} />
                        {r.rawStatus && (
                          <span className="text-xs text-muted" title={t("rawStatus")}>
                            {r.rawStatus}
                          </span>
                        )}
                        {r.delayed && (
                          <span
                            className="rounded-full bg-warn-bg px-2 py-0.5 text-xs font-semibold text-warn"
                            data-testid="shipment-delayed"
                          >
                            {t("delayed")}
                          </span>
                        )}
                        {r.rerouted && (
                          <span className="rounded-full bg-hover px-2 py-0.5 text-xs">
                            {t("rerouted", {
                              status: t.has(`rerouteStatus.${r.rerouted.status}`)
                                ? t(`rerouteStatus.${r.rerouted.status}`)
                                : r.rerouted.status,
                            })}
                          </span>
                        )}
                        {r.ticket && (
                          <Link href="/tickets?tab=all" className="text-xs text-accent hover:underline">
                            {t("ticket", { state: t(`ticketState.${r.ticket.state}`) })}
                          </Link>
                        )}
                      </div>
                    </td>
                    {showCod && (
                      <td className={`${tdCls} font-mono text-sm whitespace-nowrap`}>
                        {r.cod ? money(r.cod.amount, r.cod.currency) : <span className="text-muted">—</span>}
                      </td>
                    )}
                    <td className={`${tdCls} text-xs whitespace-nowrap`}>
                      <div>
                        <span className="text-muted">{t("date.created")}</span> {date(r.createdAt)}
                      </div>
                      {r.submittedAt && (
                        <div>
                          <span className="text-muted">{t("date.submitted")}</span> {date(r.submittedAt)}
                        </div>
                      )}
                      {r.shippedAt && (
                        <div>
                          <span className="text-muted">{t("date.shipped")}</span> {date(r.shippedAt)}
                        </div>
                      )}
                      {r.deliveredAt && (
                        <div>
                          <span className="text-muted">{t("date.delivered")}</span> {date(r.deliveredAt)}
                        </div>
                      )}
                    </td>
                    <td className={`${tdCls} font-mono text-sm`}>{t("days", { n: r.ageDays })}</td>
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
                className={ghostButtonCls + " inline-flex items-center"}
              >
                ← {t("prev")}
              </Link>
            )}
            <span className="text-sm text-muted">
              {t("pageOf", { page: data.page, pages: data.pages, total: data.total })}
            </span>
            {data.page < data.pages && (
              <Link
                href={href({ page: data.page + 1 })}
                className={ghostButtonCls + " inline-flex items-center"}
              >
                {t("next")} →
              </Link>
            )}
          </nav>
        )}
      </Card>
      {can(ctx.role, "shipments.settings") && (
        <Card>
          <h2 className="mt-0 mb-3 text-lg font-semibold">{t("settings.title")}</h2>
          <ShipmentSettingsForm delayedDays={data.settings.delayedDays} />
        </Card>
      )}
    </>
  );
}
