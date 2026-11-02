import Link from "next/link";
import { cookies } from "next/headers";
import { getFormatter, getTranslations } from "next-intl/server";
import { isScope, SCOPE_COOKIE, SCOPE_TYPES } from "@/components/shell/scope";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, inputCls, tdCls, thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import {
  listReturns,
  RETURN_SOURCES,
  RETURN_TABS,
  type ReturnSource,
  type ReturnTab,
} from "@/server/returns";
import { ReturnActions, ReturnsSettingsForm } from "./ui";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

const SOURCE_CHIP: Record<ReturnSource, string> = {
  FHB_RMA: "bg-fhb-chip text-fhb-text",
  FHB_LOCAL: "bg-fhb-chip text-fhb-text",
  EUSHIPMENTS: "bg-eu-chip text-eu-text",
};
const SOURCE_DOT: Record<ReturnSource, string> = {
  FHB_RMA: "bg-fhb",
  FHB_LOCAL: "bg-fhb",
  EUSHIPMENTS: "bg-eu",
};

/** Връщания (P6-01): every return from both warehouses, with the operator's "processed" mark. */
export default async function ReturnsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const ctx = await requireAccountContext();
  const t = await getTranslations("returns");
  const format = await getFormatter();
  const rawScope = (await cookies()).get(SCOPE_COOKIE)?.value;
  const scope = isScope(rawScope) ? rawScope : "all";
  const tabRaw = one(sp.tab);
  const tab: ReturnTab = (RETURN_TABS as readonly string[]).includes(tabRaw ?? "")
    ? (tabRaw as ReturnTab)
    : "todo";
  const srcRaw = one(sp.source);
  const source = (RETURN_SOURCES as readonly string[]).includes(srcRaw ?? "")
    ? (srcRaw as ReturnSource)
    : undefined;
  const q = one(sp.q)?.slice(0, 80);
  const caseId = one(sp.case)?.slice(0, 64);
  const actor = {
    ...actorFrom(ctx),
    activeCompanyId: ctx.activeCompanyId,
    lineCompanyIds: ctx.lineCompanyIds,
  };
  const data = await listReturns(actor, {
    tab,
    source,
    q,
    caseId,
    connectionTypes: scope === "all" ? undefined : SCOPE_TYPES[scope],
  });
  const manage = can(ctx.role, "returns.manage");
  const href = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { tab, source, q, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `/returns?${p.toString()}`;
  };
  const date = (d: Date) => format.dateTime(d, { dateStyle: "medium" });

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      {caseId ? (
        <Link href="/returns" className="text-accent hover:underline">
          {t("backToList")}
        </Link>
      ) : (
        <>
          <nav aria-label={t("filters")} className="flex flex-wrap gap-2">
            {RETURN_TABS.map((k) => (
              <Link
                key={k}
                href={href({ tab: k })}
                aria-current={tab === k ? "page" : undefined}
                data-testid={`returns-tab-${k}`}
                className={`flex min-h-10 items-center gap-2 rounded-full border px-3 no-underline ${
                  tab === k
                    ? "border-accent bg-accent-soft text-accent-strong"
                    : "border-line bg-surface text-ink"
                } ${k === "overdue" && data.counts.overdue > 0 ? "text-warn" : ""}`}
              >
                {t(`tabs.${k}`)}
                <span className="font-mono text-xs">{data.counts[k]}</span>
              </Link>
            ))}
          </nav>
          <form
            method="get"
            action="/returns"
            className="flex flex-wrap items-end gap-2"
            aria-label={t("filters")}
          >
            <input type="hidden" name="tab" value={tab} />
            <select
              name="source"
              defaultValue={source ?? ""}
              aria-label={t("source.label")}
              className={inputCls}
            >
              <option value="">{t("source.all")}</option>
              {RETURN_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {t(`source.${s}`)}
                </option>
              ))}
            </select>
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
        </>
      )}
      <Card>
        {data.rows.length === 0 ? (
          <p className="m-0 text-muted">{t("empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("title")}>
              <thead>
                <tr>
                  <th className={thCls}>{t("col.source")}</th>
                  <th className={thCls}>{t("col.order")}</th>
                  <th className={thCls}>{t("col.status")}</th>
                  <th className={thCls}>{t("col.dates")}</th>
                  <th className={thCls}>{t("col.items")}</th>
                  <th className={thCls}>{t("col.tracking")}</th>
                  <th className={thCls}>{t("col.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} data-testid={`return-${r.reference}`} className="align-top">
                    <td className={tdCls}>
                      <div className="flex flex-col gap-1">
                        {r.sources.map((s) => (
                          <span
                            key={s}
                            className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${SOURCE_CHIP[s]}`}
                          >
                            <span aria-hidden className={`size-2 rounded-full ${SOURCE_DOT[s]}`} />
                            {t(`source.${s}`)}
                          </span>
                        ))}
                        <span className="text-xs text-muted">{r.connection.name}</span>
                      </div>
                    </td>
                    <td className={tdCls}>
                      {r.orderId ? (
                        <Link href={`/orders/${r.orderId}`} className="font-mono text-accent hover:underline">
                          {r.reference}
                        </Link>
                      ) : (
                        <span className="font-mono">{r.reference}</span>
                      )}
                      {!r.orderId && <div className="text-xs text-muted">{t("noOrder")}</div>}
                      {r.company && <div className="text-xs text-muted">{r.company}</div>}
                      {r.localReturnUid && (
                        <div className="font-mono text-xs text-muted">
                          {t("localUid", { uid: r.localReturnUid })}
                        </div>
                      )}
                    </td>
                    <td className={tdCls}>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          r.state === "RECEIVED" ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn"
                        }`}
                      >
                        {t(`state.${r.state}`)}
                      </span>
                      {r.rawStatus && <div className="mt-1 text-xs text-muted">{r.rawStatus}</div>}
                      {r.returnType && (
                        <div className="text-xs text-muted">
                          {t.has(`returnType.${r.returnType}`)
                            ? t(`returnType.${r.returnType}`)
                            : r.returnType}
                        </div>
                      )}
                      {r.overdue && r.daysOnTheWay != null && (
                        <div className="mt-1 text-xs font-semibold text-warn" data-testid="case-overdue">
                          {t("overdue", { days: r.daysOnTheWay })}
                        </div>
                      )}
                    </td>
                    <td className={`${tdCls} text-sm`}>
                      {r.returningSince && <div>{t("returningSince", { date: date(r.returningSince) })}</div>}
                      {r.state === "RECEIVED" && (
                        <div>
                          {r.receivedAt ? t("receivedAt", { date: date(r.receivedAt) }) : t("noDate")}
                        </div>
                      )}
                    </td>
                    <td className={`${tdCls} text-sm`}>
                      <ul className="m-0 flex list-none flex-col gap-1 p-0">
                        {r.items.slice(0, 8).map((i, n) => (
                          <li key={n}>
                            <span className="font-mono">{i.quantity}×</span> {i.title}
                            {i.sku && i.sku !== i.title && (
                              <span className="font-mono text-xs text-muted"> {i.sku}</span>
                            )}
                            {i.condition && (
                              <div className="text-xs text-warn">
                                {t("condition", { value: i.condition })}
                              </div>
                            )}
                            {i.action && (
                              <div className="text-xs text-muted">{t("action", { value: i.action })}</div>
                            )}
                          </li>
                        ))}
                      </ul>
                      {r.photos.length > 0 && (
                        <div className="mt-2 flex flex-col gap-1">
                          <span className="text-xs font-semibold">
                            {t("photos", { count: r.photos.length })}
                          </span>
                          <div className="flex flex-wrap gap-2">
                            {r.photoFiles
                              .filter((p) => p.status === "READY")
                              .map((p) => (
                                <a
                                  key={p.id}
                                  href={`/api/returns/photos/${p.id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-accent hover:underline"
                                >
                                  {p.type && t.has(`photoType.${p.type}`)
                                    ? t(`photoType.${p.type}`)
                                    : p.photoId}{" "}
                                  ↗
                                </a>
                              ))}
                            {r.photoFiles
                              .filter((p) => p.status === "FAILED")
                              .map((p) => (
                                <span key={p.id} className="text-xs text-block">
                                  {p.photoId}: {t("photoFailed")}
                                </span>
                              ))}
                          </div>
                        </div>
                      )}
                    </td>
                    <td className={`${tdCls} font-mono text-xs`}>
                      {r.trackingNumbers.map((n) => (
                        <div key={n}>{n}</div>
                      ))}
                      {r.returnTracking.length > 0 && (
                        <div className="text-muted">
                          {t("returnTracking", { numbers: r.returnTracking.join(", ") })}
                        </div>
                      )}
                    </td>
                    <td className={tdCls}>
                      {r.processedAt ? (
                        <div className="flex flex-col gap-1 text-sm" data-testid="case-processed">
                          <span className="text-ok">
                            ✓ {t("processedBy", { name: r.processedBy ?? "—", date: date(r.processedAt) })}
                          </span>
                          {r.processedNote && (
                            <span className="text-muted">
                              {t("processedNote", { note: r.processedNote })}
                            </span>
                          )}
                        </div>
                      ) : null}
                      {r.supportNotifiedAt && (
                        <div className="text-xs text-muted">
                          {t("notified", { date: date(r.supportNotifiedAt) })}
                        </div>
                      )}
                      {r.notifications.length > 0 && (
                        <div className="text-xs text-muted">
                          {r.notifications
                            .map(
                              (n) =>
                                `${t.has(`channel.${n.channel}`) ? t(`channel.${n.channel}`) : n.channel}: ${
                                  t.has(`channelStatus.${n.status}`)
                                    ? t(`channelStatus.${n.status}`)
                                    : n.status
                                }`,
                            )
                            .join(" · ")}
                        </div>
                      )}
                      {manage && (
                        <ReturnActions
                          caseId={r.id}
                          reference={r.reference}
                          processed={!!r.processedAt}
                          received={r.state === "RECEIVED"}
                          notifyRequested={r.supportNotifyRequested}
                          canLoadPhotos={
                            r.photos.length > 0 &&
                            r.photoFiles.filter((p) => p.status === "READY").length < r.photos.length
                          }
                          photosPending={r.photoFiles.some((p) => p.status === "PENDING")}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {can(ctx.role, "account.settings") && !caseId && (
        <Card>
          <h2 className="mt-0 mb-3 text-lg font-semibold">{t("settings.title")}</h2>
          <ReturnsSettingsForm settings={data.settings} />
        </Card>
      )}
    </>
  );
}
