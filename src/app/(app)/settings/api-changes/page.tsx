import { getFormatter, getTranslations } from "next-intl/server";
import { resolveApiAlertAction } from "@/app/actions/api-watcher";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, tdCls, thCls } from "@/components/ui/form";
import { apiWatchOverview } from "@/server/api-watcher/view";
import { requireAccountContext } from "@/server/auth/session";

const SEVERITY_CLS: Record<string, string> = {
  CRITICAL: "bg-block-bg text-block",
  WARNING: "bg-warn-bg text-warn",
  INFO: "bg-hover text-muted",
};

export default async function ApiChangesPage() {
  const ctx = await requireAccountContext("apiWatch.read");
  const t = await getTranslations("apiWatch");
  const format = await getFormatter();
  const { sources, versions, alerts } = await apiWatchOverview(ctx.accountId, ctx.companyScope);
  const when = (d: Date) => format.dateTime(d, { dateStyle: "short", timeStyle: "short" });

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("intro")} />

      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("alerts")}</h2>
        {alerts.length === 0 ? (
          <p className="m-0 text-muted">{t("noAlerts")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label={t("alerts")}>
            {alerts.map((a) => (
              <li key={a.id} className="rounded-[10px] border border-line-soft p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${SEVERITY_CLS[a.severity] ?? ""}`}>
                    {t.has(`severities.${a.severity}`) ? t(`severities.${a.severity}`) : a.severity}
                  </span>
                  <span className="text-xs text-label">
                    {t.has(`kinds.${a.kind}`) ? t(`kinds.${a.kind}`) : a.kind} · {when(a.createdAt)}
                  </span>
                  <form action={resolveApiAlertAction.bind(null, a.id)} className="ml-auto">
                    <button type="submit" className={ghostButtonCls}>
                      {t("resolve")}
                    </button>
                  </form>
                </div>
                <p className="mt-2 mb-0 font-medium">{a.title}</p>
                {a.body && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-sm text-muted">{t("brief")}</summary>
                    <pre className="mt-2 max-h-96 overflow-auto rounded-[8px] bg-hover p-3 text-[12px] whitespace-pre-wrap">
                      {a.body}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("sources")}</h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>{t("source")}</th>
                <th className={thCls}>{t("lastChecked")}</th>
                <th className={thCls}>{t("state")}</th>
                <th className={thCls}>{t("latest")}</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id}>
                  <td className={tdCls}>
                    <div className="font-medium">{s.label}</div>
                    {s.url && (
                      <div className="max-w-xs truncate font-mono text-[12px] text-muted">{s.url}</div>
                    )}
                  </td>
                  <td className={`${tdCls} font-mono text-[13px] whitespace-nowrap`}>
                    {s.lastCheckedAt ? when(s.lastCheckedAt) : t("never")}
                  </td>
                  <td className={tdCls}>
                    {!s.lastCheckedAt ? (
                      "—"
                    ) : s.failures > 0 ? (
                      <span
                        className="rounded-full bg-block-bg px-2 py-0.5 text-xs text-block"
                        title={s.lastError ?? ""}
                      >
                        {t("failing", { count: s.failures })}
                      </span>
                    ) : (
                      <span className="rounded-full bg-ok-bg px-2 py-0.5 text-xs text-ok">{t("ok")}</span>
                    )}
                  </td>
                  <td className={`${tdCls} font-mono text-[13px]`}>
                    {s.latestVersion
                      ? `${s.latestVersion.hash.slice(0, 12)} · ${when(s.latestVersion.fetchedAt)}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("versions")}</h2>
        {versions.length === 0 ? (
          <p className="m-0 text-muted">{t("noVersions")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>{t("source")}</th>
                  <th className={thCls}>{t("fetched")}</th>
                  <th className={thCls}>{t("hash")}</th>
                  <th className={thCls}>{t("changes")}</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id}>
                    <td className={`${tdCls} font-medium`}>{v.label}</td>
                    <td className={`${tdCls} font-mono text-[13px] whitespace-nowrap`}>
                      {when(v.fetchedAt)}
                    </td>
                    <td className={`${tdCls} font-mono text-[13px]`}>{v.hash.slice(0, 12)}</td>
                    <td className={tdCls}>
                      {v.baseline ? (
                        <span className="text-muted">{t("baseline")}</span>
                      ) : v.counts ? (
                        <>
                          <span className={v.counts.breaking ? "font-semibold text-block" : ""}>
                            {t("counts", v.counts)}
                          </span>
                          {v.brief && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-sm text-muted">{t("brief")}</summary>
                              <pre className="mt-2 max-h-96 overflow-auto rounded-[8px] bg-hover p-3 text-[12px] whitespace-pre-wrap">
                                {v.brief}
                              </pre>
                            </details>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
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
