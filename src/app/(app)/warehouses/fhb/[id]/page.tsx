import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { refreshFhbOrderAction } from "@/app/actions/fhb";
import { StockBoard } from "@/app/(app)/products/stock/board";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, inputCls, tdCls, thCls } from "@/components/ui/form";
import { DomainError } from "@/server/accounts";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { mapFhbOrderStatus } from "@/integrations/fhb-v3/status-map";
import {
  fhbCarriers,
  fhbCod,
  fhbInbound,
  fhbOrderDetail,
  fhbOrders,
  fhbOutbox,
  fhbReturns,
  getFhbConnection,
} from "@/server/fhb/mirror";
import {
  FhbModeForm,
  FhbSettingsForm,
  LoadPickupPointsForm,
  RotateFhbCredentialsForm,
  SyncButton,
} from "../forms";
import { FhbChip, Freshness, Pager, Tabs, hrefWith, monoCls } from "../ui";

/**
 * FHB mirror for one connection (SPEC §6.7, DESIGN screen 5 mirror section): tabs follow ZOE's own menu with the
 * original names under ours. Everything is read from the local mirror; "Обнови" queues a GET-only refresh.
 */

const TABS = [
  { key: "products", original: "Stock", resource: "products" },
  { key: "orders", original: "Orders", resource: "orders" },
  { key: "rma", original: "RMA", resource: "rma" },
  { key: "returns", original: "Return", resource: "returns" },
  { key: "cod", original: "COD", resource: "cod" },
  { key: "inbound", original: "Stock receipts", resource: null },
  { key: "carriers", original: "Parcel services", resource: "carriers" },
  { key: "outbox", original: "API requests", resource: null },
  { key: "settings", original: "API, Settings", resource: null },
] as const;
type TabKey = (typeof TABS)[number]["key"];

type Params = {
  tab?: string;
  q?: string;
  page?: string;
  status?: string;
  order?: string;
  service?: string;
  country?: string;
  view?: string;
  filter?: string;
  vp?: string;
};

export default async function FhbConnectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Params>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requireAccountContext();
  const t = await getTranslations("fhb");
  const tm = await getTranslations("mode");
  const ts = await getTranslations("orderStatus");
  const format = await getFormatter();
  let c;
  try {
    c = await getFhbConnection(actorFrom(ctx), id);
  } catch (err) {
    if (err instanceof DomainError) notFound();
    throw err;
  }
  const base = `/warehouses/fhb/${id}`;
  const tab: TabKey = (TABS.find((x) => x.key === sp.tab)?.key ?? "products") as TabKey;
  const page = Math.max(1, Number(sp.page) || 1);
  const q = sp.q ?? "";
  const sync = can(ctx.role, "connections.sync");
  const tabDef = TABS.find((x) => x.key === tab)!;
  const state = (resource: string | null) =>
    resource ? (c.fhbSyncStates.find((s) => s.resource === resource) ?? null) : null;
  const money = (v: unknown) =>
    v === null || v === undefined
      ? "—"
      : format.number(Number(v), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const date = (d: Date | null) => (d ? format.dateTime(d, { dateStyle: "short", timeStyle: "short" }) : "—");

  const search = (placeholder: string, hidden: Record<string, string | undefined> = {}) => (
    <form method="get" action={base} className="flex flex-wrap items-center gap-2" role="search">
      {Object.entries({ tab, ...hidden }).map(
        ([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />,
      )}
      <input
        name="q"
        defaultValue={q}
        placeholder={placeholder}
        aria-label={t("search")}
        className={`${inputCls} w-72`}
      />
      <button type="submit" className={ghostButtonCls}>
        {t("search")}
      </button>
    </form>
  );

  const toolbar = tabDef.resource && (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Freshness state={state(tabDef.resource)} />
      {sync && <SyncButton connectionId={id} resource={tabDef.resource} label={t("sync.now")} />}
    </div>
  );

  let body: React.ReactNode = null;

  if (tab === "products") {
    body = (
      <>
        <Card>{toolbar}</Card>
        <StockBoard
          accountId={ctx.accountId}
          connectionIds={[id]}
          base={base}
          params={sp}
          extra={{ tab: "products" }}
          canLink={can(ctx.role, "products.match")}
        />
      </>
    );
  } else if (tab === "orders" || tab === "rma") {
    const rma = tab === "rma";
    const { rows, total, statuses } = await fhbOrders(ctx.accountId, id, {
      q,
      rawStatus: sp.status,
      rma,
      page,
    });
    const detail = sp.order ? await fhbOrderDetail(ctx.accountId, id, sp.order) : null;
    body = (
      <Card>
        {toolbar}
        {rma && <p className="text-sm text-muted">{t("orders.rmaHelp")}</p>}
        <div className="mt-3 flex flex-col gap-3">
          {search(t("orders.searchPlaceholder"), { status: sp.status })}
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label={t("orders.statuses")}>
            <li>
              <Link
                href={hrefWith(base, { tab, q: q || undefined }, {})}
                aria-current={!sp.status ? "true" : undefined}
                className={`inline-flex min-h-10 items-center rounded-full border px-3 text-[13px] ${!sp.status ? "border-accent bg-accent-soft font-semibold" : "border-line"}`}
              >
                {t("orders.allStatuses")}
              </Link>
            </li>
            {statuses.map((s) => (
              <li key={s.raw ?? "none"}>
                <Link
                  href={hrefWith(base, { tab, q: q || undefined }, { status: s.raw ?? undefined })}
                  aria-current={sp.status === s.raw ? "true" : undefined}
                  className={`inline-flex min-h-10 items-center gap-1 rounded-full border px-3 text-[13px] ${sp.status === s.raw ? "border-accent bg-accent-soft font-semibold" : "border-line"}`}
                >
                  <span className="font-mono">{s.raw ?? "—"}</span>
                  <span className="font-mono text-[12px] text-muted">{s.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        {rows.length === 0 ? (
          <p className="mb-0 mt-3 text-muted">{t("orders.empty")}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>{t("orders.id")}</th>
                  <th className={thCls}>{t("orders.status")}</th>
                  <th className={thCls}>{t("orders.recipient")}</th>
                  <th className={thCls}>{t("orders.carrier")}</th>
                  <th className={thCls}>{t("orders.tracking")}</th>
                  <th className={`${thCls} text-right`}>{t("orders.cod")}</th>
                  <th className={thCls}>{rma ? t("orders.returnedAt") : t("orders.createdAt")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} className={sp.order === o.externalId ? "bg-accent-soft" : undefined}>
                    <td className={tdCls}>
                      <Link
                        href={hrefWith(
                          base,
                          { tab, q: q || undefined, status: sp.status, page: String(page) },
                          { order: o.externalId },
                        )}
                        className={`${monoCls} text-accent hover:underline`}
                      >
                        {o.externalId}
                      </Link>
                      <div className={`${monoCls} text-xs text-muted`}>
                        {o.uid ?? "—"} · VS {o.variableSymbol ?? "—"}
                      </div>
                    </td>
                    <td className={tdCls}>
                      <div>{ts(o.status)}</div>
                      <div className="font-mono text-xs text-label">{o.rawStatus ?? "—"}</div>
                    </td>
                    <td className={tdCls}>
                      {o.recipientName ?? "—"} <span className="text-muted">{o.country ?? ""}</span>
                    </td>
                    <td className={`${tdCls} ${monoCls}`}>{o.parcelService ?? "—"}</td>
                    <td className={`${tdCls} ${monoCls}`}>{o.trackingNumbers.join(", ") || "—"}</td>
                    <td className={`${tdCls} ${monoCls} text-right`}>{money(o.cod)}</td>
                    <td className={`${tdCls} whitespace-nowrap`}>
                      {date(rma ? o.returnedAt : o.vendorCreatedAt)}
                      {rma && o.returnType && (
                        <div className="font-mono text-xs text-label">{o.returnType}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager base={base} params={{ tab, q: q || undefined, status: sp.status }} page={page} total={total} />
        {detail && (
          <section aria-label={t("orders.detail")} className="mt-4 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="m-0 text-base font-semibold">
                {t("orders.detail")} <span className={monoCls}>{detail.externalId}</span>
              </h2>
              {sync && (
                <form action={refreshFhbOrderAction.bind(null, id, detail.externalId)}>
                  <button type="submit" className={ghostButtonCls}>
                    {t("orders.refresh")}
                  </button>
                </form>
              )}
              {mapFhbOrderStatus(detail.rawStatus).editable && (
                <span className="text-sm text-muted">{t("orders.editable")}</span>
              )}
            </div>
            <OrderDetail raw={detail.raw} t={t} />
          </section>
        )}
      </Card>
    );
  } else if (tab === "returns") {
    const { rows, total } = await fhbReturns(ctx.accountId, id, { q, page });
    body = (
      <Card>
        {toolbar}
        <p className="text-sm text-muted">{t("returns.help")}</p>
        {search(t("returns.searchPlaceholder"))}
        {rows.length === 0 ? (
          <p className="mb-0 mt-3 text-muted">{t("returns.empty")}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>UID</th>
                  <th className={thCls}>{t("returns.type")}</th>
                  <th className={thCls}>{t("orders.status")}</th>
                  <th className={thCls}>{t("returns.barcodes")}</th>
                  <th className={thCls}>{t("returns.items")}</th>
                  <th className={thCls}>{t("returns.photos")}</th>
                  <th className={thCls}>{t("orders.createdAt")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const items = (r.items ?? []) as {
                    description?: string;
                    condition?: string;
                    quantity?: number;
                    action?: string;
                  }[];
                  return (
                    <tr key={r.id}>
                      <td className={`${tdCls} ${monoCls}`}>{r.uid}</td>
                      <td className={`${tdCls} font-mono`}>{r.type ?? "—"}</td>
                      <td className={`${tdCls} font-mono`}>{r.status ?? "—"}</td>
                      <td className={`${tdCls} ${monoCls}`}>{r.barcodes.join(", ") || "—"}</td>
                      <td className={tdCls}>
                        {items.length === 0
                          ? "—"
                          : items.map((i, n) => (
                              <div key={n} className="text-sm">
                                {i.quantity ?? "?"} × {i.description ?? "—"}
                                {i.condition && <span className="text-muted"> · {i.condition}</span>}
                                {i.action && (
                                  <span className="font-mono text-xs text-label"> · {i.action}</span>
                                )}
                              </div>
                            ))}
                      </td>
                      <td className={tdCls}>{(r.photos as unknown[]).length}</td>
                      <td className={`${tdCls} whitespace-nowrap`}>{date(r.vendorCreatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pager base={base} params={{ tab, q: q || undefined }} page={page} total={total} />
      </Card>
    );
  } else if (tab === "cod") {
    const { rows, total, totals } = await fhbCod(ctx.accountId, id, { status: sp.status, q, page });
    body = (
      <Card>
        {toolbar}
        <ul className="m-0 mt-3 grid list-none gap-3 p-0 sm:grid-cols-3" aria-label={t("cod.summary")}>
          {["waiting", "received", "paid"].map((s) => {
            const row = totals.find((x) => x.status === s);
            return (
              <li key={s} className="rounded-[10px] border border-line p-3">
                <Link href={hrefWith(base, { tab }, { status: s })} className="flex flex-col gap-1">
                  <span className="text-sm font-semibold">{t(`cod.${s}`)}</span>
                  <span className="font-mono text-[11px] text-label">{s}</span>
                  <span className="font-mono text-lg">{money(row?.sum ?? 0)}</span>
                  <span className="text-xs text-muted">{t("cod.count", { count: row?.count ?? 0 })}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted">{t("cod.localCurrency")}</p>
        {search(t("cod.searchPlaceholder"), { status: sp.status })}
        {rows.length === 0 ? (
          <p className="mb-0 mt-3 text-muted">{t("cod.empty")}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>{t("orders.id")}</th>
                  <th className={thCls}>{t("orders.carrier")}</th>
                  <th className={`${thCls} text-right`}>{t("orders.cod")}</th>
                  <th className={thCls}>{t("orders.status")}</th>
                  <th className={thCls}>{t("cod.receivedAt")}</th>
                  <th className={thCls}>{t("cod.paidAt")}</th>
                  <th className={thCls}>{t("orders.createdAt")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className={tdCls}>
                      <div className={monoCls}>{r.externalId}</div>
                      <div className={`${monoCls} text-xs text-muted`}>VS {r.variableSymbol ?? "—"}</div>
                    </td>
                    <td className={`${tdCls} ${monoCls}`}>{r.parcelService ?? "—"}</td>
                    <td className={`${tdCls} ${monoCls} text-right`}>{money(r.cod)}</td>
                    <td className={tdCls}>
                      {r.status && t.has(`cod.${r.status}`) ? t(`cod.${r.status}`) : t("cod.unknown")}
                      <div className="font-mono text-xs text-label">{r.status ?? "—"}</div>
                    </td>
                    <td className={`${tdCls} whitespace-nowrap`}>{date(r.receivedAt)}</td>
                    <td className={`${tdCls} whitespace-nowrap`}>{date(r.paidAt)}</td>
                    <td className={`${tdCls} whitespace-nowrap`}>{date(r.vendorCreatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager base={base} params={{ tab, q: q || undefined, status: sp.status }} page={page} total={total} />
      </Card>
    );
  } else if (tab === "inbound") {
    const { rows, total } = await fhbInbound(ctx.accountId, id, { page });
    body = (
      <Card>
        <p className="mt-0 text-sm text-muted">{t("inbound.help")}</p>
        {rows.length === 0 ? (
          <p className="mb-0 text-muted">{t("inbound.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>{t("inbound.ref")}</th>
                  <th className={thCls}>{t("orders.status")}</th>
                  <th className={thCls}>{t("orders.tracking")}</th>
                  <th className={thCls}>{t("inbound.lines")}</th>
                  <th className={thCls}>{t("inbound.expectedAt")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className={`${tdCls} ${monoCls}`}>{r.externalRef}</td>
                    <td className={`${tdCls} font-mono`}>{r.status}</td>
                    <td className={`${tdCls} ${monoCls}`}>{r.tracking ?? "—"}</td>
                    <td className={tdCls}>
                      {r.lines.map((l) => (
                        <div key={l.id} className="text-sm">
                          <span className={monoCls}>{l.product.sku}</span> · {l.expectedQty}
                          {" → "}
                          <span
                            className={
                              l.receivedQty !== null && l.receivedQty !== l.expectedQty
                                ? "font-semibold text-warn"
                                : ""
                            }
                          >
                            {l.receivedQty ?? "—"}
                          </span>
                        </div>
                      ))}
                    </td>
                    <td className={`${tdCls} whitespace-nowrap`}>{date(r.expectedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager base={base} params={{ tab }} page={page} total={total} />
      </Card>
    );
  } else if (tab === "carriers") {
    const data = await fhbCarriers(ctx.accountId, id, { service: sp.service, country: sp.country, q, page });
    body = (
      <>
        <Card>
          {toolbar}
          {data.carriers.length === 0 ? (
            <p className="mb-0 mt-3 text-muted">{t("carriers.empty")}</p>
          ) : (
            <table className="mt-3 w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>{t("carriers.code")}</th>
                  <th className={thCls}>{t("carriers.name")}</th>
                  <th className={thCls}>{t("carriers.lists")}</th>
                </tr>
              </thead>
              <tbody>
                {data.carriers.map((cr) => (
                  <tr key={cr.id}>
                    <td className={`${tdCls} ${monoCls}`}>{cr.code}</td>
                    <td className={tdCls}>{cr.name ?? "—"}</td>
                    <td className={tdCls}>
                      {data.lists
                        .filter((l) => l.service === cr.code)
                        .map((l) => (
                          <Link
                            key={l.country}
                            href={hrefWith(
                              base,
                              { tab },
                              { service: l.service, country: l.country || undefined },
                            )}
                            className="mr-3 text-accent hover:underline"
                          >
                            {l.country || t("carriers.allCountries")} ({l.count})
                          </Link>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        {sync && (
          <Card>
            <h2 className="mt-0 text-base font-semibold">{t("carriers.load")}</h2>
            <LoadPickupPointsForm connectionId={id} carriers={data.carriers} />
          </Card>
        )}
        {sp.service && (
          <Card>
            <h2 className="mt-0 text-base font-semibold">
              {t("carriers.points")} · <span className={monoCls}>{sp.service}</span> {sp.country ?? ""}
            </h2>
            {search(t("carriers.searchPlaceholder"), { service: sp.service, country: sp.country })}
            {data.points.length === 0 ? (
              <p className="mb-0 mt-3 text-muted">{t("carriers.noPoints")}</p>
            ) : (
              <table className="mt-3 w-full border-collapse">
                <thead>
                  <tr>
                    <th className={thCls}>{t("carriers.code")}</th>
                    <th className={thCls}>{t("carriers.name")}</th>
                    <th className={thCls}>{t("carriers.address")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.points.map((p) => (
                    <tr key={p.id}>
                      <td className={`${tdCls} ${monoCls}`}>
                        {p.vendorId}
                        {p.externalCode && <div className="text-xs text-muted">{p.externalCode}</div>}
                      </td>
                      <td className={tdCls}>{p.name ?? "—"}</td>
                      <td className={tdCls}>
                        {[p.street, p.zip, p.city, p.country].filter(Boolean).join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <Pager
              base={base}
              params={{ tab, service: sp.service, country: sp.country, q: q || undefined }}
              page={page}
              total={data.pointsTotal}
            />
          </Card>
        )}
      </>
    );
  } else if (tab === "outbox") {
    const data = await fhbOutbox(ctx.accountId, id, ctx.role, { status: sp.status, page });
    body = (
      <Card>
        <p className="mt-0 text-sm text-muted">{t(`outbox.help.${c.liveMode}`)}</p>
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label={t("outbox.statuses")}>
          <li>
            <Link
              href={hrefWith(base, { tab }, {})}
              aria-current={!sp.status ? "true" : undefined}
              className={`inline-flex min-h-10 items-center rounded-full border px-3 text-[13px] ${!sp.status ? "border-accent bg-accent-soft font-semibold" : "border-line"}`}
            >
              {t("orders.allStatuses")}
            </Link>
          </li>
          {data.statuses.map((s) => (
            <li key={s.status}>
              <Link
                href={hrefWith(base, { tab }, { status: s.status })}
                aria-current={sp.status === s.status ? "true" : undefined}
                className={`inline-flex min-h-10 items-center gap-1 rounded-full border px-3 text-[13px] ${sp.status === s.status ? "border-accent bg-accent-soft font-semibold" : "border-line"}`}
              >
                {t(`outbox.status.${s.status}`)}
                <span className="font-mono text-[12px] text-muted">{s.count}</span>
              </Link>
            </li>
          ))}
        </ul>
        {data.rows.length === 0 ? (
          <p className="mb-0 mt-3 text-muted">{t("outbox.empty")}</p>
        ) : (
          <ul className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
            {data.rows.map((r) => (
              <li key={r.id} className="rounded-[10px] border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`${monoCls} font-semibold`}>{r.operation}</span>
                  {r.target && <span className={monoCls}>{r.target}</span>}
                  <span className="rounded-full border border-line px-2 py-0.5 text-[12px]">
                    {t(`outbox.status.${r.status}`)}
                  </span>
                  {r.evaluatedMode && <span className="text-xs text-muted">{tm(r.evaluatedMode)}</span>}
                  <span className="ml-auto text-xs text-muted">{date(r.createdAt)}</span>
                </div>
                {r.lastError && <p className="mb-0 mt-1 text-sm text-block">{r.lastError}</p>}
                {data.withPayload ? (
                  r.body !== null && (
                    <details className="mt-2" open={r.status === "DRY_RUN_RECORDED"}>
                      <summary className="cursor-pointer text-sm text-accent">{t("outbox.payload")}</summary>
                      <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-bg p-3 font-mono text-[12px]">
                        {JSON.stringify(r.body, null, 2)}
                      </pre>
                    </details>
                  )
                ) : (
                  <p className="mb-0 mt-1 text-xs text-muted">{t("outbox.payloadHidden")}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        <Pager base={base} params={{ tab, status: sp.status }} page={page} total={data.total} />
      </Card>
    );
  } else {
    // settings
    const manage = can(ctx.role, "connections.manage");
    const prefix = ((c.skuPrefixRule ?? {}) as { prefix?: string }).prefix ?? "";
    body = (
      <>
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("conn.mode")}</h2>
          <p className="mt-0 text-sm text-muted">{t("conn.modeHelp")}</p>
          {manage ? (
            <FhbModeForm
              connectionId={id}
              current={c.liveMode}
              canRaise={can(ctx.role, "connections.raiseMode")}
            />
          ) : (
            <p className="m-0 font-semibold">{tm(c.liveMode)}</p>
          )}
        </Card>
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("sync.title")}</h2>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>{t("sync.resource")}</th>
                <th className={thCls}>{t("sync.state")}</th>
                <th className={`${thCls} text-right`}>{t("sync.count")}</th>
              </tr>
            </thead>
            <tbody>
              {c.fhbSyncStates.map((s) => (
                <tr key={s.id}>
                  <td className={tdCls}>{t(`sync.resources.${s.resource}`)}</td>
                  <td className={tdCls}>
                    <Freshness state={s} />
                  </td>
                  <td className={`${tdCls} ${monoCls} text-right`}>{s.lastCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {sync && (
            <div className="mt-3">
              <SyncButton connectionId={id} resource="all" label={t("sync.all")} />
            </div>
          )}
        </Card>
        {manage && (
          <Card>
            <h2 className="mt-0 text-base font-semibold">{t("conn.settings")}</h2>
            <FhbSettingsForm connectionId={id} name={c.name} skuPrefix={prefix} enabled={c.enabled} />
          </Card>
        )}
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("conn.credentials")}</h2>
          <p className="mt-0 text-sm">
            {c.credentialId
              ? t("conn.credentialsSet", { hint: c.credential?.hint ?? "" })
              : t("errors.no_credentials")}
          </p>
          {can(ctx.role, "credentials.write") && <RotateFhbCredentialsForm connectionId={id} />}
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={`${c.company?.name ?? "—"} · ${tm(c.liveMode)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <FhbChip />
            <a
              href="https://zoe2.fhb.sk"
              target="_blank"
              rel="noreferrer"
              className={`${ghostButtonCls} inline-flex items-center`}
            >
              {t("conn.openZoe")}
            </a>
            <Link href="/warehouses" className={`${ghostButtonCls} inline-flex items-center`}>
              {t("back")}
            </Link>
          </div>
        }
      />
      <Tabs
        label={t("tabs.label")}
        items={TABS.map((x) => ({
          href: hrefWith(base, {}, { tab: x.key }),
          title: t(`tabs.${x.key}`),
          original: x.original,
          active: x.key === tab,
        }))}
      />
      {body}
    </>
  );
}

/** Read-only order detail from the mirror (the full FHB view as stored). */
function OrderDetail({ raw, t }: { raw: unknown; t: Awaited<ReturnType<typeof getTranslations<"fhb">>> }) {
  const o = (raw ?? {}) as {
    recipient?: { address?: Record<string, string | null>; contact?: Record<string, string | null> } | null;
    items?: { id: string; quantity: number }[] | null;
    tracking_links?: string[] | null;
    tracking_events?: { date?: string | null; message?: string | null; event_code?: string | null }[] | null;
    packages?: { tracking_number?: string | null; weight?: number | null }[] | null;
    package_returns?: { tracking?: string | null; return_tracking?: string | null }[] | null;
    note?: string | null;
    sender?: string | null;
    delivery_point?: string | null;
  };
  const a = o.recipient?.address ?? {};
  return (
    <div className="mt-3 grid gap-4 md:grid-cols-2">
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">{t("orders.recipient")}</dt>
        <dd className="m-0">
          {[a.name, a.street, `${a.zip ?? ""} ${a.city ?? ""}`.trim(), a.province, a.country]
            .filter(Boolean)
            .join(", ") || "—"}
        </dd>
        <dt className="text-muted">{t("orders.contact")}</dt>
        <dd className="m-0">
          {[o.recipient?.contact?.email, o.recipient?.contact?.phone].filter(Boolean).join(" · ") || "—"}
        </dd>
        <dt className="text-muted">{t("orders.deliveryPoint")}</dt>
        <dd className="m-0 font-mono">{o.delivery_point ?? "—"}</dd>
        <dt className="text-muted">{t("orders.sender")}</dt>
        <dd className="m-0 font-mono">{o.sender ?? "—"}</dd>
        <dt className="text-muted">{t("orders.note")}</dt>
        <dd className="m-0">{o.note ?? "—"}</dd>
        <dt className="text-muted">{t("orders.items")}</dt>
        <dd className="m-0 font-mono">
          {(o.items ?? []).map((i) => `${i.quantity} × ${i.id}`).join(", ") || "—"}
        </dd>
        <dt className="text-muted">{t("orders.packages")}</dt>
        <dd className="m-0 font-mono">
          {(o.packages ?? []).map((p) => `${p.tracking_number ?? "—"} (${p.weight ?? "?"} kg)`).join(", ") ||
            "—"}
        </dd>
        <dt className="text-muted">{t("orders.packageReturns")}</dt>
        <dd className="m-0 font-mono">
          {(o.package_returns ?? [])
            .map((p) => `${p.tracking ?? "—"} → ${p.return_tracking ?? "—"}`)
            .join(", ") || "—"}
        </dd>
        <dt className="text-muted">{t("orders.trackingLinks")}</dt>
        <dd className="m-0">
          {(o.tracking_links ?? []).map((l) =>
            /^https?:\/\//.test(l) ? (
              <a
                key={l}
                href={l}
                target="_blank"
                rel="noreferrer"
                className="mr-2 text-accent hover:underline"
              >
                {t("orders.track")}
              </a>
            ) : null,
          )}
          {(o.tracking_links ?? []).length === 0 && "—"}
        </dd>
      </dl>
      <div>
        <h3 className="mt-0 text-sm font-semibold">{t("orders.events")}</h3>
        {(o.tracking_events ?? []).length === 0 ? (
          <p className="m-0 text-sm text-muted">—</p>
        ) : (
          <ol className="m-0 list-none p-0 text-sm">
            {(o.tracking_events ?? []).map((e, i) => (
              <li key={i} className="border-b border-line-soft py-1">
                <span className="font-mono text-xs text-muted">{e.date ?? ""}</span> {e.message ?? ""}
                {e.event_code && <span className="font-mono text-xs text-label"> · {e.event_code}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
