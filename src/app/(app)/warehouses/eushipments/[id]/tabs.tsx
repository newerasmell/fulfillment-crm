import Link from "next/link";
import type { Role } from "@/generated/prisma/client";
import { getFormatter, getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/PageHeader";
import { buttonCls, inputCls, tdCls, thCls } from "@/components/ui/form";
import {
  canSeeDryRuns,
  mirrorBookings,
  mirrorCod,
  mirrorCouriers,
  mirrorDryRuns,
  mirrorProducts,
  mirrorShipments,
  mirrorStock,
  mirrorWarehouses,
  PAGE_SIZE,
  type MirrorTab,
  type ProductFilter,
} from "@/server/eushipments/mirror";
import { masterSkuFor } from "@/server/eushipments/read";
import { CountryCourierForm, EuCitiesForm, LinkEuProduct } from "../forms";
import { countryCourierBoard } from "@/server/eushipments/country-couriers";
import { SERVICE_NAMES } from "@/integrations/eushipments/schemas";
import { can } from "@/server/auth/rbac";
import { Freshness } from "../ui";

type Search = { tab?: string; q?: string; filter?: string; page?: string };
interface Props {
  tab: MirrorTab;
  accountId: string;
  connectionId: string;
  prefix: string;
  canLink: boolean;
  canSync: boolean;
  role: Role;
  search: Search;
}

const mono = `${tdCls} font-mono text-[13px]`;
const pageOf = (s: Search) => Math.max(1, Number(s.page) || 1);

async function SearchBox({ tab, q, extra }: { tab: MirrorTab; q?: string; extra?: Record<string, string> }) {
  const t = await getTranslations("eushipments");
  return (
    <form method="get" className="mb-3 flex flex-wrap items-end gap-2" role="search">
      <input type="hidden" name="tab" value={tab} />
      {Object.entries(extra ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input
        name="q"
        defaultValue={q ?? ""}
        aria-label={t("search")}
        placeholder={t(`searchHint.${tab}`)}
        className={`${inputCls} w-72`}
      />
      <button type="submit" className={buttonCls}>
        {t("searchButton")}
      </button>
    </form>
  );
}

async function Pager({ base, page, total }: { base: string; page: number; total: number }) {
  const t = await getTranslations("eushipments");
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return null;
  return (
    <nav aria-label={t("pages")} className="mt-3 flex items-center gap-3 text-sm">
      {page > 1 && <Link href={`${base}&page=${page - 1}`}>← {t("prev")}</Link>}
      <span>{t("pageOf", { page, pages })}</span>
      {page < pages && <Link href={`${base}&page=${page + 1}`}>{t("next")} →</Link>}
    </nav>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="m-0 text-muted">{text}</p>;
}

export async function MirrorTabContent(p: Props) {
  switch (p.tab) {
    case "products":
      return <ProductsTab {...p} />;
    case "stock":
      return <StockTab {...p} />;
    case "orders":
      return <OrdersTab {...p} />;
    case "inbound":
      return <InboundTab {...p} />;
    case "cod":
      return <CodTab {...p} />;
    case "couriers":
      return <CouriersTab {...p} />;
    case "warehouses":
      return <WarehousesTab {...p} />;
    case "dryrun":
      return <DryRunTab {...p} />;
  }
}

async function ProductsTab({ accountId, connectionId, prefix, canLink, search }: Props) {
  const t = await getTranslations("eushipments");
  const filter = (
    ["all", "unmatched", "archived"].includes(search.filter ?? "") ? search.filter : "all"
  ) as ProductFilter;
  const page = pageOf(search);
  const r = await mirrorProducts(accountId, connectionId, { q: search.q, filter, page });
  const base = `/warehouses/eushipments/${connectionId}?tab=products`;
  return (
    <Card>
      <nav aria-label={t("filters")} className="mb-3 flex flex-wrap gap-2">
        {(["all", "unmatched", "archived"] as const).map((f) => (
          <Link
            key={f}
            href={`${base}&filter=${f}`}
            aria-current={f === filter ? "true" : undefined}
            className={`inline-flex min-h-10 items-center rounded-full border px-3 text-sm ${
              f === filter ? "border-accent bg-accent-soft text-accent-strong" : "border-line"
            }`}
          >
            {t(`productFilters.${f}`)} ({r.counts[f]})
          </Link>
        ))}
      </nav>
      <SearchBox tab="products" q={search.q} extra={{ filter }} />
      {r.rows.length === 0 ? (
        <Empty text={t("emptyProducts")} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>{t("refNumber")}</th>
                <th className={thCls}>{t("vendorProductId")}</th>
                <th className={thCls}>{t("vendorName")}</th>
                <th className={thCls}>{t("masterProduct")}</th>
                <th className={thCls}>{t("available")}</th>
                <th className={thCls}>{t("lastSync")}</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((v) => (
                <tr key={v.id}>
                  <td className={mono}>{v.vendorId}</td>
                  <td className={mono}>{v.vendorCode ?? "—"}</td>
                  <td className={tdCls}>{v.vendorName ?? "—"}</td>
                  <td className={tdCls}>
                    {v.product ? (
                      <span>
                        <span className="font-mono text-[13px]">{v.product.sku}</span>{" "}
                        <span className="text-muted">{v.product.name}</span>
                      </span>
                    ) : canLink && !v.archived ? (
                      <LinkEuProduct
                        connectionId={connectionId}
                        vendorProductId={v.id}
                        refNumber={v.vendorId}
                        suggestion={masterSkuFor(v.vendorId, { prefix })}
                      />
                    ) : (
                      <span className="rounded-full bg-warn-bg px-2 py-0.5 text-xs text-warn">
                        {t("notLinked")}
                      </span>
                    )}
                  </td>
                  <td className={mono}>{v.stockLevel ? v.stockLevel.free : "—"}</td>
                  <td className={tdCls}>
                    <Freshness at={v.lastSyncAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        base={`${base}&filter=${filter}&q=${encodeURIComponent(search.q ?? "")}`}
        page={page}
        total={r.total}
      />
      <p className="mb-0 mt-3 text-xs text-muted">{t("eanNote")}</p>
    </Card>
  );
}

async function StockTab({ accountId, connectionId, search }: Props) {
  const t = await getTranslations("eushipments");
  const page = pageOf(search);
  const r = await mirrorStock(accountId, connectionId, { q: search.q, page });
  return (
    <Card>
      <p className="mt-0 text-sm">
        {t("snapshot")}: <Freshness at={r.snapshotAt} /> · {t("lastSync")}: <Freshness at={r.syncedAt} />
      </p>
      <SearchBox tab="stock" q={search.q} />
      {r.rows.length === 0 ? (
        <Empty text={t("emptyStock")} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>{t("refNumber")}</th>
                <th className={thCls}>{t("masterProduct")}</th>
                <th className={thCls}>{t("warehouse")}</th>
                <th className={thCls}>{t("available")}</th>
                <th className={thCls}>{t("itemCode")}</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((s) => (
                <tr key={s.id}>
                  <td className={mono}>{s.refNumber}</td>
                  <td className={tdCls}>
                    {s.product ? (
                      <span className="font-mono text-[13px]">{s.product.sku}</span>
                    ) : (
                      <span className="rounded-full bg-warn-bg px-2 py-0.5 text-xs text-warn">
                        {t("notLinked")}
                      </span>
                    )}
                  </td>
                  <td className={tdCls}>{s.warehouseName}</td>
                  <td className={`${mono} font-semibold`}>{s.availQty}</td>
                  <td className={mono}>{s.courierItemCode ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        base={`/warehouses/eushipments/${connectionId}?tab=stock&q=${encodeURIComponent(search.q ?? "")}`}
        page={page}
        total={r.total}
      />
    </Card>
  );
}

async function OrdersTab({ accountId, connectionId, search }: Props) {
  const t = await getTranslations();
  const page = pageOf(search);
  const r = await mirrorShipments(accountId, connectionId, { q: search.q, page });
  return (
    <Card>
      <SearchBox tab="orders" q={search.q} />
      {r.rows.length === 0 ? (
        <Empty text={t("eushipments.emptyOrders")} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>{t("eushipments.reference")}</th>
                <th className={thCls}>{t("eushipments.order")}</th>
                <th className={thCls}>{t("eushipments.status")}</th>
                <th className={thCls}>{t("eushipments.vendorStatus")}</th>
                <th className={thCls}>AWB</th>
                <th className={thCls}>{t("eushipments.polled")}</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((f) => (
                <tr key={f.id}>
                  <td className={mono}>{f.externalId}</td>
                  <td className={tdCls}>
                    <Link href={`/orders/${f.order.id}`} className="text-accent hover:underline">
                      {f.order.number}
                    </Link>{" "}
                    <span className="text-muted">{f.order.countryCode ?? ""}</span>
                  </td>
                  <td className={tdCls}>{t(`orderStatus.${f.status}`)}</td>
                  <td className={tdCls}>{f.rawStatus ?? "—"}</td>
                  <td className={mono}>{f.trackingNumbers.join(", ") || "—"}</td>
                  <td className={tdCls}>
                    <Freshness at={f.tracking?.polledAt ?? null} />
                    {f.tracking?.lastError && (
                      <span className="block text-xs text-block">{f.tracking.lastError}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        base={`/warehouses/eushipments/${connectionId}?tab=orders&q=${encodeURIComponent(search.q ?? "")}`}
        page={page}
        total={r.total}
      />
    </Card>
  );
}

async function InboundTab({ accountId, connectionId, search }: Props) {
  const t = await getTranslations("eushipments");
  const page = pageOf(search);
  const r = await mirrorBookings(accountId, connectionId, { page });
  return (
    <Card>
      {r.rows.length === 0 ? (
        <Empty text={t("emptyInbound")} />
      ) : (
        <div className="flex flex-col gap-4">
          {r.rows.map((b) => (
            <article key={b.id} className="rounded-[10px] border border-line p-3">
              <header className="mb-2 flex flex-wrap items-center gap-3">
                <span className="font-mono font-semibold">{b.externalRef}</span>
                <span className="text-sm text-muted">
                  {t("requestId")}: <span className="font-mono">{b.vendorId ?? "—"}</span>
                </span>
                <span className="rounded-full bg-hover px-2 py-0.5 text-xs font-semibold">
                  {t.has(`bookingStatus.${b.status}`) ? t(`bookingStatus.${b.status}`) : b.status}
                </span>
              </header>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={thCls}>{t("masterProduct")}</th>
                    <th className={thCls}>{t("expected")}</th>
                    <th className={thCls}>{t("accepted")}</th>
                    <th className={thCls}>{t("warehouseComment")}</th>
                  </tr>
                </thead>
                <tbody>
                  {b.lines.map((l) => {
                    const diff = l.receivedQty != null && l.receivedQty !== l.expectedQty;
                    return (
                      <tr key={l.id}>
                        <td className={mono}>{l.product.sku}</td>
                        <td className={mono}>{l.expectedQty}</td>
                        <td className={`${mono} ${diff ? "font-semibold text-warn" : ""}`}>
                          {l.receivedQty ?? "—"}
                          {diff && <span className="ml-1 text-xs">({t("difference")})</span>}
                        </td>
                        <td className={tdCls}>{l.comment ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </article>
          ))}
        </div>
      )}
      <Pager base={`/warehouses/eushipments/${connectionId}?tab=inbound`} page={page} total={r.total} />
    </Card>
  );
}

async function CodTab({ accountId, connectionId, search }: Props) {
  const t = await getTranslations("eushipments");
  const format = await getFormatter();
  const page = pageOf(search);
  const r = await mirrorCod(accountId, connectionId, { page });
  return (
    <Card>
      <p className="mt-0 text-sm">
        {t("codPaid")}: <strong>{r.paid}</strong> · {t("codOpen")}: <strong>{r.open}</strong>
      </p>
      {r.rows.length === 0 ? (
        <Empty text={t("emptyCod")} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>{t("reference")}</th>
                <th className={thCls}>AWB</th>
                <th className={thCls}>{t("codAmount")}</th>
                <th className={thCls}>{t("codProtocol")}</th>
                <th className={thCls}>{t("codPaidAt")}</th>
                <th className={thCls}>{t("lastSync")}</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((x) => (
                <tr key={x.id}>
                  <td className={mono}>{x.referenceNumber}</td>
                  <td className={mono}>{x.codAwb ?? "—"}</td>
                  <td className={mono}>{x.codAmount ?? t("codNotFound")}</td>
                  <td className={mono}>{x.codPaidNumber ?? "—"}</td>
                  <td className={tdCls}>
                    {x.codPaidAt ? (
                      <span className="rounded-full bg-ok-bg px-2 py-0.5 text-xs text-ok">
                        {format.dateTime(x.codPaidAt, { dateStyle: "short" })}
                      </span>
                    ) : x.codAmount ? (
                      <span className="rounded-full bg-warn-bg px-2 py-0.5 text-xs text-warn">
                        {t("codNotPaid")}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={tdCls}>
                    <Freshness at={x.codCheckedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mb-0 mt-3 text-xs text-muted">{t("codCurrencyNote")}</p>
      <Pager base={`/warehouses/eushipments/${connectionId}?tab=cod`} page={page} total={r.total} />
    </Card>
  );
}

async function CouriersTab({ accountId, connectionId, canSync, role, search }: Props) {
  const t = await getTranslations("eushipments");
  const tc = await getTranslations("eushipments.countryCourier");
  const r = await mirrorCouriers(accountId, connectionId, { q: search.q });
  const defaults = await countryCourierBoard(accountId, connectionId);
  const canManage = can(role, "connections.manage");
  return (
    <>
      <Card>
        <h2 className="mt-0 text-base font-semibold">{tc("title")}</h2>
        <p className="mt-0 text-sm text-muted">{tc("hint")}</p>
        {defaults.length === 0 ? (
          <Empty text={tc("empty")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={tc("title")}>
              <thead>
                <tr>
                  <th className={thCls}>{t("country")}</th>
                  <th className={thCls}>{tc("couriers")}</th>
                  <th className={thCls}>{tc("default")}</th>
                </tr>
              </thead>
              <tbody>
                {defaults.map((d) => (
                  <tr key={d.iso}>
                    <td className={tdCls}>
                      {d.name} <span className="font-mono text-[13px] text-muted">{d.iso}</span>
                      {d.needsChoice && <div className="text-xs text-block">{tc("needsChoice")}</div>}
                    </td>
                    <td className={mono}>{d.couriers.length}</td>
                    <td className={tdCls}>
                      <CountryCourierForm
                        id={connectionId}
                        country={d.iso}
                        couriers={d.couriers.map((c) => ({
                          courierId: c.courierId,
                          name: c.name,
                          toAddress: c.toAddress,
                          toOffice: c.toOffice,
                        }))}
                        courierId={d.courierId}
                        serviceName={d.serviceName}
                        services={SERVICE_NAMES}
                        disabled={!canManage}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("couriers")}</h2>
        {r.couriers.length === 0 ? (
          <Empty text={t("emptyCouriers")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>courierId</th>
                  <th className={thCls}>{t("name")}</th>
                  <th className={thCls}>{t("country")}</th>
                  <th className={thCls}>{t("currency")}</th>
                  <th className={thCls}>{t("toAddress")}</th>
                  <th className={thCls}>{t("toOffice")}</th>
                  <th className={thCls}>{t("offices")}</th>
                </tr>
              </thead>
              <tbody>
                {r.couriers.map((c) => (
                  <tr key={c.id}>
                    <td className={mono}>{c.courierId}</td>
                    <td className={tdCls}>{c.name}</td>
                    <td className={tdCls}>{c.country ?? "—"}</td>
                    <td className={mono}>{c.currency ?? "—"}</td>
                    <td className={tdCls}>{c.toAddress ? t("yes") : t("no")}</td>
                    <td className={tdCls}>{c.toOffice ? t("yes") : t("no")}</td>
                    <td className={mono}>{c.offices}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("officeSearch")}</h2>
        <SearchBox tab="couriers" q={search.q} />
        {search.q && r.offices.length === 0 && <Empty text={t("noOffices")} />}
        {r.offices.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>officeId</th>
                  <th className={thCls}>{t("name")}</th>
                  <th className={thCls}>{t("city")}</th>
                  <th className={thCls}>{t("address")}</th>
                  <th className={thCls}>{t("kind")}</th>
                  <th className={thCls}>{t("codSupport")}</th>
                </tr>
              </thead>
              <tbody>
                {r.offices.map((o) => (
                  <tr key={o.id}>
                    <td className={mono}>{o.officeId}</td>
                    <td className={tdCls}>{o.name}</td>
                    <td className={tdCls}>
                      {o.cityName ?? "—"}{" "}
                      <span className="font-mono text-[13px] text-muted">{o.postCode ?? ""}</span>
                    </td>
                    <td className={tdCls}>{o.address ?? "—"}</td>
                    <td className={tdCls}>{o.isStation ? t("locker") : t("office")}</td>
                    <td className={tdCls}>{o.codSupport ? t("yes") : t("no")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("countries")}</h2>
        {r.countries.length === 0 ? (
          <Empty text={t("emptyCountries")} />
        ) : (
          <>
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
              {r.countries.map((c) => (
                <li key={c.id} className="rounded-full border border-line px-3 py-1 text-sm">
                  <span className="font-mono">{c.isoCode ?? "—"}</span> {c.name} ·{" "}
                  <span className="text-muted">{t("cityCount", { count: c.cities })}</span>
                </li>
              ))}
            </ul>
            {canSync && (
              <div className="mt-3">
                <EuCitiesForm
                  id={connectionId}
                  countries={r.countries.map((c) => ({ countryId: c.countryId, name: c.name }))}
                />
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}

async function WarehousesTab({ accountId, connectionId }: Props) {
  const t = await getTranslations("eushipments");
  const rows = await mirrorWarehouses(accountId, connectionId);
  return (
    <Card>
      {rows.length === 0 ? (
        <Empty text={t("emptyWarehouses")} />
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={thCls}>warehouseId</th>
              <th className={thCls}>{t("name")}</th>
              <th className={thCls}>{t("country")}</th>
              <th className={thCls}>{t("lastSync")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.id}>
                <td className={mono}>{w.warehouseId}</td>
                <td className={tdCls}>{w.name}</td>
                <td className={tdCls}>
                  <span className="font-mono">{w.countryIso ?? ""}</span> {w.countryName ?? "—"}
                </td>
                <td className={tdCls}>
                  <Freshness at={w.syncedAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

async function DryRunTab({ accountId, connectionId, role, search }: Props) {
  const t = await getTranslations("eushipments");
  const format = await getFormatter();
  const page = pageOf(search);
  // The bodies carry customer data: only members who may review orders see them.
  if (!canSeeDryRuns(role))
    return (
      <Card>
        <Empty text={t("dryRunForbidden")} />
      </Card>
    );
  const r = await mirrorDryRuns(accountId, connectionId, role, { page });
  const tone: Record<string, string> = {
    validated: "bg-ok-bg text-ok",
    rejected: "bg-block-bg text-block",
    recorded: "bg-hover text-ink",
    pending: "bg-warn-bg text-warn",
  };
  return (
    <Card>
      <p className="mt-0 text-sm text-muted">{t("dryRunHelp")}</p>
      {r.rows.length === 0 ? (
        <Empty text={t("emptyDryRun")} />
      ) : (
        <div className="flex flex-col gap-3">
          {r.rows.map((x) => (
            <article key={x.id} className="rounded-[10px] border border-line p-3">
              <header className="mb-2 flex flex-wrap items-center gap-3">
                <span className="font-mono text-[13px] font-semibold">{x.idempotencyKey}</span>
                <span className="text-sm">
                  {t.has(`ops.${x.operation.replace(/^eushipments\./, "")}`)
                    ? t(`ops.${x.operation.replace(/^eushipments\./, "")}`)
                    : x.operation}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone[x.verdict]}`}>
                  {t(`verdict.${x.verdict}`)}
                </span>
                <span className="rounded-full border border-line px-2 py-0.5 font-mono text-xs">
                  {x.testMode ? "testMode: true" : t("notSent")}
                </span>
                <span className="ml-auto text-xs text-muted">
                  {format.dateTime(x.updatedAt, { dateStyle: "short", timeStyle: "short" })}
                </span>
              </header>
              {x.lastError && (
                <p role="status" className="my-2 rounded-lg bg-block-bg px-3 py-2 text-sm text-block">
                  {x.lastError}
                </p>
              )}
              <details>
                <summary className="cursor-pointer text-sm font-semibold">{t("payload")}</summary>
                <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-hover p-3 font-mono text-[12px]">
                  {JSON.stringify(x.body, null, 2)}
                </pre>
              </details>
              {x.lastResponse != null && (
                <details>
                  <summary className="cursor-pointer text-sm font-semibold">{t("vendorAnswer")}</summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-hover p-3 font-mono text-[12px]">
                    {JSON.stringify(x.lastResponse, null, 2)}
                  </pre>
                </details>
              )}
            </article>
          ))}
        </div>
      )}
      <Pager base={`/warehouses/eushipments/${connectionId}?tab=dryrun`} page={page} total={r.total} />
    </Card>
  );
}
