import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { tdCls, thCls } from "@/components/ui/form";
import { ALERT_CATEGORIES, alertCounts, listOpenAlerts, type AlertCategory } from "@/server/alerts";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { AlertActions } from "./actions";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

const SEVERITY_TONE: Record<string, string> = {
  CRITICAL: "bg-block-bg text-block",
  WARNING: "bg-warn-bg text-warn",
  INFO: "bg-accent-soft text-accent-strong",
};

/** Сигнали и задачи (P4-08): every open alert/task in one list, filter by category, assign, resolve with note. */
export default async function AlertsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const ctx = await requireAccountContext();
  const t = await getTranslations("alerts");
  const format = await getFormatter();
  const actor = { ...actorFrom(ctx), activeCompanyId: ctx.activeCompanyId };
  const c = one(sp.category);
  const category = (ALERT_CATEGORIES as readonly string[]).includes(c ?? "")
    ? (c as AlertCategory)
    : undefined;
  const mine = one(sp.mine) === "1";
  const [rows, counts] = await Promise.all([listOpenAlerts(actor, { category, mine }), alertCounts(actor)]);
  const manage = can(ctx.role, "alerts.manage");
  const chip = (href: string, label: string, n: number, active: boolean) => (
    <Link
      key={href}
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-10 items-center gap-2 rounded-full border px-3 no-underline ${
        active ? "border-accent bg-accent-soft text-accent-strong" : "border-line bg-surface text-ink"
      }`}
    >
      {label}
      <span className="font-mono text-xs">{n}</span>
    </Link>
  );
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <nav aria-label={t("filters")} className="flex flex-wrap gap-2">
        {chip("/alerts", t("all"), counts.total, !category && !mine)}
        {chip("/alerts?mine=1", t("mine"), counts.mine, mine)}
        {ALERT_CATEGORIES.filter((k) => counts.byCategory[k] > 0 || k === category).map((k) =>
          chip(`/alerts?category=${k}`, t(`category.${k}`), counts.byCategory[k], category === k),
        )}
      </nav>
      <Card>
        {rows.length === 0 ? (
          <p className="m-0 text-muted">{t("empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("title")}>
              <thead>
                <tr>
                  <th className={thCls}>{t("col.severity")}</th>
                  <th className={thCls}>{t("col.title")}</th>
                  <th className={thCls}>{t("col.category")}</th>
                  <th className={thCls}>{t("col.order")}</th>
                  <th className={thCls}>{t("col.created")}</th>
                  <th className={thCls}>{t("col.assignee")}</th>
                  {manage && <th className={thCls}>{t("col.actions")}</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} data-testid={`alert-${a.kind}`}>
                    <td className={tdCls}>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${SEVERITY_TONE[a.severity] ?? ""}`}>
                        {t(`severity.${a.severity}`)}
                      </span>
                      {a.isTask && <span className="ml-2 text-xs text-muted">{t("task")}</span>}
                    </td>
                    <td className={tdCls}>{a.title}</td>
                    <td className={tdCls}>{t(`category.${a.category}`)}</td>
                    <td className={tdCls}>
                      {a.order ? (
                        <Link
                          href={`/orders/${a.order.id}`}
                          className="font-mono text-accent hover:underline"
                        >
                          {a.order.number}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={`${tdCls} text-muted`}>
                      {format.dateTime(a.createdAt, { dateStyle: "short", timeStyle: "short" })}
                    </td>
                    <td className={tdCls}>{a.assigneeName ?? "—"}</td>
                    {manage && (
                      <td className={tdCls}>
                        <AlertActions alertId={a.id} title={a.title} mine={a.assigneeId === ctx.user.id} />
                      </td>
                    )}
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
