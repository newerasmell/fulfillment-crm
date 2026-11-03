import Link from "next/link";
import { cookies } from "next/headers";
import { getFormatter, getTranslations } from "next-intl/server";
import { isScope, SCOPE_COOKIE, SCOPE_TYPES } from "@/components/shell/scope";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, inputCls, labelCls, tdCls, thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import {
  DIRECTORY_TABS,
  directoryConnections,
  getOffice,
  listCities,
  listCouriers,
  listOffices,
  listSenders,
  OFFICE_TYPES,
  syncInfo,
  type DirectoryCtx,
  type DirectoryTab,
} from "@/server/directory/directory";
import { CopyButton, RefreshButton } from "./ui";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const ZOE_URL = "https://zoe2.fhb.sk";
const mono = `${tdCls} font-mono text-[13px]`;

/** Warehouse identity: colour always with the name next to it (DESIGN.md principle 3). */
function VendorChip({ type, name }: { type: string; name: string }) {
  const eu = type === "EUSHIPMENTS" || type === "eu";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${
        eu ? "bg-eu-chip text-eu-text" : "bg-fhb-chip text-fhb-text"
      }`}
    >
      <span aria-hidden className={`size-2 rounded-full ${eu ? "bg-eu" : "bg-fhb"}`} />
      {name}
    </span>
  );
}

async function When({ at }: { at: Date | null }) {
  const t = await getTranslations("directory");
  const format = await getFormatter();
  if (!at) return <span className="text-muted">{t("never")}</span>;
  return (
    <time dateTime={at.toISOString()} title={format.dateTime(at, { dateStyle: "short", timeStyle: "short" })}>
      {format.relativeTime(at)}
    </time>
  );
}

/** Офиси, PUDO, потребители (P10-03): what the read syncs mirrored, searchable; never a vendor call. */
export default async function DirectoryPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const ctx = await requireAccountContext("account.read");
  const t = await getTranslations("directory");
  const rawScope = (await cookies()).get(SCOPE_COOKIE)?.value;
  const scope = isScope(rawScope) ? rawScope : "all";
  const types = scope === "all" ? undefined : SCOPE_TYPES[scope];
  const tabRaw = one(sp.tab);
  const tab: DirectoryTab = (DIRECTORY_TABS as readonly string[]).includes(tabRaw ?? "")
    ? (tabRaw as DirectoryTab)
    : "offices";
  const dctx: DirectoryCtx = {
    ...actorFrom(ctx),
    activeCompanyId: ctx.activeCompanyId,
    lineCompanyIds: ctx.lineCompanyIds,
  };
  const conns = await directoryConnections(dctx, types);
  const sync = syncInfo(conns, tab);
  const canRefresh = can(ctx.role, "eushipments.sync") || can(ctx.role, "connections.sync");

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <nav aria-label={t("tabsLabel")} className="flex flex-wrap gap-2">
        {DIRECTORY_TABS.map((k) => (
          <Link
            key={k}
            href={`/directory?tab=${k}`}
            data-testid={`directory-tab-${k}`}
            aria-current={tab === k ? "page" : undefined}
            className={`flex min-h-11 flex-col justify-center rounded-[12px] border px-3 py-1 leading-tight no-underline ${
              tab === k
                ? "border-accent bg-accent-soft text-accent-strong"
                : "border-line bg-surface text-ink"
            }`}
          >
            <span className="font-medium">{t(`tabs.${k}`)}</span>
            <span className="text-[11px] text-muted">{t(`original.${k}`)}</span>
          </Link>
        ))}
      </nav>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3" data-testid="directory-sync">
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-semibold">{t("lastSync")}</span>
            {sync.length === 0 ? (
              <span className="text-muted">{t(conns.length ? "syncNone" : "noConnections")}</span>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {sync.map((s) => (
                  <li key={s.connectionId} className="flex flex-wrap items-center gap-2">
                    <VendorChip type={s.type} name={s.name} />
                    <When at={s.lastOkAt} />
                    <span className="font-mono text-[11px] text-muted">{s.kind}</span>
                    {s.lastError && <span className="text-block">{s.lastError}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {canRefresh && sync.length > 0 && <RefreshButton tab={tab} />}
        </div>
        <p className="mb-0 mt-2 text-xs text-muted">{t(`syncHelp.${tab}`)}</p>
      </Card>

      {tab === "offices" && <OfficesTab ctx={dctx} sp={sp} types={types} />}
      {tab === "couriers" && <CouriersTab ctx={dctx} types={types} />}
      {tab === "cities" && <CitiesTab ctx={dctx} sp={sp} types={types} />}
      {tab === "senders" && <SendersTab ctx={dctx} types={types} />}
    </>
  );
}

type TabProps = { ctx: DirectoryCtx; types?: readonly string[] };

async function Pager({ href, page, pages }: { href: (p: number) => string; page: number; pages: number }) {
  const t = await getTranslations("directory");
  if (pages <= 1) return null;
  return (
    <nav aria-label={t("pages")} className="mt-3 flex items-center gap-3 text-sm">
      {page > 1 && (
        <Link href={href(page - 1)} className="text-accent hover:underline">
          ← {t("prev")}
        </Link>
      )}
      <span>{t("pageOf", { page, pages })}</span>
      {page < pages && (
        <Link href={href(page + 1)} className="text-accent hover:underline">
          {t("next")} →
        </Link>
      )}
    </nav>
  );
}

async function OfficesTab({ ctx, sp, types }: TabProps & { sp: Search }) {
  const t = await getTranslations("directory");
  const raw = {
    vendor: one(sp.vendor),
    courier: one(sp.courier),
    country: one(sp.country),
    city: one(sp.city),
    type: one(sp.type),
    q: one(sp.q),
    page: one(sp.page),
  };
  const data = await listOffices(ctx, raw, types);
  const f = data.filter;
  const openKey = one(sp.office);
  const detail = openKey ? await getOffice(ctx, openKey, types) : null;
  const href = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams({ tab: "offices" });
    const all = {
      vendor: f.vendor,
      courier: f.courier,
      country: f.country,
      city: f.city,
      type: f.type,
      q: f.q,
      ...over,
    };
    for (const [k, v] of Object.entries(all)) if (v !== undefined && v !== "") p.set(k, String(v));
    return `/directory?${p.toString()}`;
  };
  return (
    <>
      <form
        method="get"
        action="/directory"
        className="flex flex-wrap items-end gap-2"
        aria-label={t("filters")}
      >
        <input type="hidden" name="tab" value="offices" />
        <label className={labelCls}>
          {t("f.q")}
          <input
            name="q"
            defaultValue={f.q ?? ""}
            placeholder={t("f.qHint")}
            className={`${inputCls} min-w-64`}
          />
        </label>
        <label className={labelCls}>
          {t("f.vendor")}
          <select name="vendor" defaultValue={f.vendor ?? ""} className={inputCls}>
            <option value="">{t("f.all")}</option>
            <option value="eu">euShipments</option>
            <option value="fhb">FHB</option>
          </select>
        </label>
        <label className={labelCls}>
          {t("f.courier")}
          <select name="courier" defaultValue={f.courier ?? ""} className={inputCls}>
            <option value="">{t("f.all")}</option>
            {data.options.couriers.map((c) => (
              <option key={c.value} value={c.value}>
                {c.vendor === "eu" ? "euShipments" : "FHB"} · {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          {t("f.country")}
          <select name="country" defaultValue={f.country ?? ""} className={inputCls}>
            <option value="">{t("f.all")}</option>
            {data.options.countries.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          {t("f.city")}
          <input name="city" defaultValue={f.city ?? ""} className={`${inputCls} w-40`} />
        </label>
        <label className={labelCls}>
          {t("f.type")}
          <select name="type" defaultValue={f.type ?? ""} className={inputCls}>
            <option value="">{t("f.all")}</option>
            {OFFICE_TYPES.map((k) => (
              <option key={k} value={k}>
                {t(`type.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={ghostButtonCls}>
          {t("apply")}
        </button>
        <Link
          href="/directory?tab=offices"
          className="min-h-10 self-end px-2 py-2 text-sm text-accent hover:underline"
        >
          {t("reset")}
        </Link>
      </form>

      {detail && <OfficeDetail d={detail} closeHref={href({ page: f.page })} />}

      <Card>
        <p className="mt-0 text-sm text-muted" data-testid="offices-total">
          {t("found", { count: data.total })} · euShipments {data.totals.eu} · FHB {data.totals.fhb}
        </p>
        {data.rows.length === 0 ? (
          <p className="m-0 text-muted">{t(data.connections.length ? "emptyOffices" : "noConnections")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("tabs.offices")}>
              <thead>
                <tr>
                  <th className={thCls}>{t("col.code")}</th>
                  <th className={thCls}>{t("col.name")}</th>
                  <th className={thCls}>{t("col.courier")}</th>
                  <th className={thCls}>{t("col.city")}</th>
                  <th className={thCls}>{t("col.address")}</th>
                  <th className={thCls}>{t("col.type")}</th>
                  <th className={thCls}>{t("col.lastSync")}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.key} data-testid={`office-${r.vendor}-${r.code}`}>
                    <td className={mono}>
                      <div className="flex items-center gap-2">
                        <span>{r.code}</span>
                        <CopyButton value={r.code} label={t("copyCode")} />
                      </div>
                      {r.courierCode && <div className="text-xs text-muted">{r.courierCode}</div>}
                    </td>
                    <td className={tdCls}>
                      <Link
                        href={href({ page: f.page, office: r.key })}
                        className="text-accent hover:underline"
                        scroll={false}
                      >
                        {r.name}
                      </Link>
                    </td>
                    <td className={tdCls}>
                      <div>{r.courier}</div>
                      <VendorChip type={r.vendor} name={r.connection.name} />
                    </td>
                    <td className={tdCls}>
                      {r.city ?? "—"}{" "}
                      <span className="font-mono text-[13px] text-muted">{r.postCode ?? ""}</span>
                      {r.country && <div className="font-mono text-xs text-muted">{r.country}</div>}
                    </td>
                    <td className={`${tdCls} text-sm`}>{r.address ?? "—"}</td>
                    <td className={tdCls}>
                      {t(`type.${r.type}`)}
                      {r.codSupport && <div className="text-xs text-muted">{t("codSupport")}</div>}
                    </td>
                    <td className={`${tdCls} text-sm`}>
                      <When at={r.lastSyncAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager href={(p) => href({ page: p })} page={data.page} pages={data.pages} />
        <p className="mb-0 mt-3 text-xs text-muted">{t("fhbPointsHelp")}</p>
      </Card>
    </>
  );
}

type Detail = NonNullable<Awaited<ReturnType<typeof getOffice>>>;

async function OfficeDetail({ d, closeHref }: { d: Detail; closeHref: string }) {
  const t = await getTranslations("directory");
  const format = await getFormatter();
  const rows: [string, React.ReactNode][] =
    d.vendor === "eu"
      ? [
          ["officeId", d.office.officeId],
          [t("d.courierCode"), d.office.code ?? "—"],
          [t("col.courier"), `${d.courier?.name ?? "—"} (courierId ${d.office.courierId})`],
          [t("col.name"), d.office.name],
          [
            t("col.city"),
            `${d.office.cityName ?? "—"}${d.office.cityId ? ` (cityId ${d.office.cityId})` : ""}`,
          ],
          [t("d.postCode"), d.office.postCode ?? "—"],
          [t("col.address"), d.office.address ?? "—"],
          [t("d.region"), d.office.region ?? "—"],
          [t("d.country"), d.courier?.iso ?? d.courier?.country ?? "—"],
          [t("col.type"), t(d.office.isStation ? "type.locker" : "type.office")],
          [t("codSupport"), d.office.codSupport ? t("yes") : t("no")],
          [
            t("d.coords"),
            d.office.latitude && d.office.longitude ? `${d.office.latitude}, ${d.office.longitude}` : "—",
          ],
          [t("d.weekday"), (d.workHours?.weekday ?? []).filter(Boolean).join(" – ") || "—"],
          [t("d.saturday"), (d.workHours?.saturday ?? []).filter(Boolean).join(" – ") || "—"],
          [
            t("col.lastSync"),
            format.dateTime(d.office.syncedAt, { dateStyle: "medium", timeStyle: "short" }),
          ],
        ]
      : [
          ["id", d.point.vendorId],
          ["external_code", d.point.externalCode ?? "—"],
          [t("col.courier"), `${d.carrier?.name ?? "—"} (${d.point.service})`],
          [t("col.name"), d.point.name ?? "—"],
          [t("col.address"), d.point.street ?? "—"],
          [t("col.city"), d.point.city ?? "—"],
          [t("d.postCode"), d.point.zip ?? "—"],
          [t("d.country"), d.point.country ?? "—"],
          [t("d.queryCountry"), d.point.queryCountry || "—"],
          [t("col.type"), t("type.pudo")],
          [
            t("col.lastSync"),
            format.dateTime(d.point.lastSyncAt, { dateStyle: "medium", timeStyle: "short" }),
          ],
        ];
  return (
    <Card>
      <section aria-label={t("detail")} data-testid="office-detail">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 flex items-center gap-2 text-lg font-semibold">
            <VendorChip type={d.connection.type} name={d.connection.name} />
            {d.vendor === "eu" ? d.office.name : (d.point.name ?? d.point.vendorId)}
          </h2>
          <Link href={closeHref} scroll={false} className="text-sm text-accent hover:underline">
            {t("close")}
          </Link>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-[10px] bg-accent-soft p-3">
          <span className="text-sm">{t(d.vendor === "eu" ? "d.pasteEu" : "d.pasteFhb")}</span>
          <span className="font-mono text-lg font-semibold" data-testid="office-detail-code">
            {d.code}
          </span>
          <CopyButton value={d.code} label={t("copyCode")} />
        </div>
        <dl className="m-0 grid gap-x-6 gap-y-2 sm:grid-cols-[200px_1fr]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-[13px] text-label">{k}</dt>
              <dd className="m-0 font-mono text-[13px]">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
    </Card>
  );
}

async function CouriersTab({ ctx, types }: TabProps) {
  const t = await getTranslations("directory");
  const data = await listCouriers(ctx, types);
  return (
    <>
      <Card>
        <h2 className="mt-0 text-base font-semibold">
          euShipments <span className="text-xs font-normal text-muted">GET /couriers</span>
        </h2>
        {data.eu.length === 0 ? (
          <p className="m-0 text-muted">{t("emptyCouriers")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("euCouriers")}>
              <thead>
                <tr>
                  <th className={thCls}>courierId</th>
                  <th className={thCls}>{t("col.name")}</th>
                  <th className={thCls}>{t("d.country")}</th>
                  <th className={thCls}>{t("currency")}</th>
                  <th className={thCls}>{t("toAddress")}</th>
                  <th className={thCls}>{t("toOffice")}</th>
                  <th className={thCls}>{t("offices")}</th>
                  <th className={thCls}>{t("col.lastSync")}</th>
                </tr>
              </thead>
              <tbody>
                {data.eu.map((c) => (
                  <tr key={c.id} data-testid={`courier-eu-${c.courierId}`}>
                    <td className={mono}>
                      <div className="flex items-center gap-2">
                        {c.courierId} <CopyButton value={String(c.courierId)} label={t("copyCode")} />
                      </div>
                    </td>
                    <td className={tdCls}>
                      {c.name}
                      <div className="text-xs text-muted">{c.connection.name}</div>
                    </td>
                    <td className={tdCls}>
                      {c.iso ?? "—"} <span className="text-xs text-muted">{c.country ?? ""}</span>
                    </td>
                    <td className={mono}>{c.currency ?? "—"}</td>
                    <td className={tdCls}>{c.toAddress ? t("yes") : t("no")}</td>
                    <td className={tdCls}>{c.toOffice ? t("yes") : t("no")}</td>
                    <td className={mono}>
                      {c.offices > 0 ? (
                        <Link
                          href={`/directory?tab=offices&courier=eu:${c.courierId}`}
                          className="text-accent hover:underline"
                        >
                          {c.offices}
                        </Link>
                      ) : (
                        0
                      )}
                    </td>
                    <td className={`${tdCls} text-sm`}>
                      <When at={c.syncedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card>
        <h2 className="mt-0 text-base font-semibold">
          FHB <span className="text-xs font-normal text-muted">GET /parcel-service</span>
        </h2>
        {data.fhb.length === 0 ? (
          <p className="m-0 text-muted">{t("emptyCouriers")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("fhbCarriers")}>
              <thead>
                <tr>
                  <th className={thCls}>{t("col.code")}</th>
                  <th className={thCls}>{t("col.name")}</th>
                  <th className={thCls}>{t("points")}</th>
                  <th className={thCls}>{t("col.lastSync")}</th>
                </tr>
              </thead>
              <tbody>
                {data.fhb.map((c) => (
                  <tr key={c.id} data-testid={`courier-fhb-${c.code}`}>
                    <td className={mono}>
                      <div className="flex items-center gap-2">
                        {c.code} <CopyButton value={c.code} label={t("copyCode")} />
                      </div>
                    </td>
                    <td className={tdCls}>
                      {c.name ?? "—"}
                      <div className="text-xs text-muted">{c.connection.name}</div>
                    </td>
                    <td className={mono}>
                      {c.points > 0 ? (
                        <Link
                          href={`/directory?tab=offices&courier=fhb:${encodeURIComponent(c.code)}`}
                          className="text-accent hover:underline"
                        >
                          {c.points}
                        </Link>
                      ) : (
                        <Link
                          href={`/warehouses/fhb/${c.connection.id}?tab=carriers`}
                          className="text-xs text-accent hover:underline"
                        >
                          {t("loadPoints")}
                        </Link>
                      )}
                    </td>
                    <td className={`${tdCls} text-sm`}>
                      <When at={c.syncedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

async function CitiesTab({ ctx, sp, types }: TabProps & { sp: Search }) {
  const t = await getTranslations("directory");
  const data = await listCities(ctx, { country: one(sp.country), q: one(sp.q), page: one(sp.page) }, types);
  const f = data.filter;
  const href = (p: number) => {
    const s = new URLSearchParams({ tab: "cities" });
    if (f.country) s.set("country", f.country);
    if (f.q) s.set("q", f.q);
    s.set("page", String(p));
    return `/directory?${s.toString()}`;
  };
  return (
    <>
      <form
        method="get"
        action="/directory"
        className="flex flex-wrap items-end gap-2"
        aria-label={t("filters")}
      >
        <input type="hidden" name="tab" value="cities" />
        <label className={labelCls}>
          {t("f.q")}
          <input
            name="q"
            defaultValue={f.q ?? ""}
            placeholder={t("f.cityHint")}
            className={`${inputCls} min-w-64`}
          />
        </label>
        <label className={labelCls}>
          {t("f.country")}
          <select name="country" defaultValue={f.country ?? ""} className={inputCls}>
            <option value="">{t("f.all")}</option>
            {data.countries.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={ghostButtonCls}>
          {t("apply")}
        </button>
      </form>
      <Card>
        {data.loaded.length > 0 && (
          <p className="mt-0 text-sm text-muted">
            {t("citiesLoaded")} {data.loaded.map((l) => `${l.iso ?? l.country} (${l.count})`).join(" · ")}
          </p>
        )}
        <p className="mt-0 text-sm text-muted">{t("found", { count: data.total })}</p>
        {data.rows.length === 0 ? (
          <p className="m-0 text-muted">{t("emptyCities")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("tabs.cities")}>
              <thead>
                <tr>
                  <th className={thCls}>cityId</th>
                  <th className={thCls}>{t("col.name")}</th>
                  <th className={thCls}>{t("nameEn")}</th>
                  <th className={thCls}>{t("d.postCode")}</th>
                  <th className={thCls}>{t("county")}</th>
                  <th className={thCls}>{t("d.country")}</th>
                  <th className={thCls}>{t("col.lastSync")}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((c) => (
                  <tr key={c.id} data-testid={`city-${c.cityId}`}>
                    <td className={mono}>
                      <div className="flex items-center gap-2">
                        {c.cityId} <CopyButton value={String(c.cityId)} label={t("copyCode")} />
                      </div>
                    </td>
                    <td className={tdCls}>
                      {c.nameLocal}
                      <div className="text-xs text-muted">{c.connection}</div>
                    </td>
                    <td className={tdCls}>{c.nameEn ?? "—"}</td>
                    <td className={mono}>{c.postalCode ?? "—"}</td>
                    <td className={tdCls}>{c.county ?? "—"}</td>
                    <td className={mono}>{c.country?.isoCode ?? c.country?.name ?? "—"}</td>
                    <td className={`${tdCls} text-sm`}>
                      <When at={c.syncedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager href={href} page={data.page} pages={data.pages} />
        <p className="mb-0 mt-3 text-xs text-muted">{t("citiesHelp")}</p>
      </Card>
    </>
  );
}

async function SendersTab({ ctx, types }: TabProps) {
  const t = await getTranslations("directory");
  const data = await listSenders(ctx, types);
  return (
    <>
      {data.eu.map((e) => (
        <Card key={e.connection.id}>
          <section aria-label={e.connection.name} data-testid={`sender-${e.connection.id}`}>
            <h2 className="mt-0 flex flex-wrap items-center gap-2 text-base font-semibold">
              <VendorChip type="EUSHIPMENTS" name={e.connection.name} />
              <span className="text-sm font-normal text-muted">{e.connection.company?.name ?? "—"}</span>
              <Link
                href={`/warehouses/eushipments/${e.connection.id}`}
                className="text-sm font-normal text-accent hover:underline"
              >
                {t("openConnection")}
              </Link>
            </h2>
            <p className="mt-0 text-sm">
              {t("senderId")}:{" "}
              <span className="font-mono font-semibold">{e.senderId ?? t("senderMissing")}</span>
              {e.senderId && (
                <span className="ml-2">
                  <CopyButton value={String(e.senderId)} label={t("copyCode")} />
                </span>
              )}
            </p>
            <h3 className="mb-1 text-sm font-semibold">
              {t("vendorCompanies")} <span className="font-normal text-muted">GET /get-user-companies</span>
            </h3>
            {e.companies.length === 0 ? (
              <p className="m-0 text-sm text-muted">{t("emptyCompanies")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse" aria-label={t("vendorCompanies")}>
                  <thead>
                    <tr>
                      <th className={thCls}>companyId</th>
                      <th className={thCls}>{t("col.name")}</th>
                      <th className={thCls}>{t("bulstat")}</th>
                      <th className={thCls}>{t("col.lastSync")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.companies.map((c) => (
                      <tr key={c.id}>
                        <td className={mono}>{c.vendorCompanyId}</td>
                        <td className={tdCls}>
                          {c.name}{" "}
                          {c.isSender && (
                            <span className="ml-1 rounded-full bg-ok-bg px-2 py-0.5 text-xs text-ok">
                              {t("isSender")}
                            </span>
                          )}
                        </td>
                        <td className={mono}>{c.bulstat ?? "—"}</td>
                        <td className={`${tdCls} text-sm`}>
                          <When at={c.syncedAt} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h3 className="mb-1 text-sm font-semibold">
              {t("warehouses")} <span className="font-normal text-muted">POST /fulfilment/warehouses</span>
            </h3>
            {e.warehouses.length === 0 ? (
              <p className="m-0 text-sm text-muted">—</p>
            ) : (
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {e.warehouses.map((w) => (
                  <li key={w.id} className="rounded-full border border-line px-3 py-1 text-sm">
                    <span className="font-mono">{w.warehouseId}</span> {w.name}{" "}
                    <span className="text-muted">{w.countryIso ?? ""}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mb-0 mt-3 text-xs text-muted">{t("euCabinetOnly")}</p>
          </section>
        </Card>
      ))}
      {data.fhb.map((f) => (
        <Card key={f.connection.id}>
          <section aria-label={f.connection.name} data-testid={`sender-${f.connection.id}`}>
            <h2 className="mt-0 flex flex-wrap items-center gap-2 text-base font-semibold">
              <VendorChip type="FHB_V3" name={f.connection.name} />
              <span className="text-sm font-normal text-muted">{f.connection.company?.name ?? "—"}</span>
              <Link
                href={`/warehouses/fhb/${f.connection.id}`}
                className="text-sm font-normal text-accent hover:underline"
              >
                {t("openConnection")}
              </Link>
              <a
                href={ZOE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-normal text-accent hover:underline"
              >
                {t("inZoe")}
              </a>
            </h2>
            <dl className="m-0 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[200px_1fr]">
              <dt className="text-label">{t("fhbAccount")}</dt>
              <dd className="m-0 font-mono">{f.connection.credential?.hint ?? t("noCredential")}</dd>
              <dt className="text-label">{t("mode")}</dt>
              <dd className="m-0 font-mono">{f.connection.liveMode}</dd>
              <dt className="text-label">{t("lastSync")}</dt>
              <dd className="m-0">
                <When at={f.lastOk} />
                {f.errors.length > 0 && (
                  <span className="ml-2 text-block">
                    {t("syncErrors")}: {f.errors.join(", ")}
                  </span>
                )}
              </dd>
            </dl>
            <p className="mb-0 mt-3 text-xs text-muted">{t("fhbSenderHelp")}</p>
          </section>
        </Card>
      ))}
      {data.eu.length === 0 && data.fhb.length === 0 && (
        <Card>
          <p className="m-0 text-muted">{t("noConnections")}</p>
        </Card>
      )}
    </>
  );
}
