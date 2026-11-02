import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { toggleReasonCodeAction } from "@/app/actions/review";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, inputCls, tdCls, thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { requireAccountContext } from "@/server/auth/session";
import { listReasonCodes, listReviews } from "@/server/review";
import { StatusChip } from "../status";
import { ReasonCodeForm } from "./reason-form";

/** Review records (P4-05): every human decision, filterable; plus the configurable reason codes (admins). */

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const DECISIONS = ["APPROVE", "EDIT_AND_APPROVE", "HOLD", "CANCEL"] as const;
const day = (v: string | undefined) =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : undefined;

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const ctx = await requireAccountContext("reviews.read");
  const r = await getTranslations("review");
  const locale = await getLocale();
  const format = await getFormatter();
  const filters = {
    decision: one(sp.decision),
    reasonCode: one(sp.reason),
    reviewerId: one(sp.reviewer),
    q: one(sp.q),
    from: one(sp.from),
    to: one(sp.to),
  };
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const to = day(filters.to);
  const [result, codes] = await Promise.all([
    listReviews(ctx, {
      ...filters,
      from: day(filters.from),
      to: to ? new Date(to.getTime() + 86_400_000) : undefined,
      page,
    }),
    listReasonCodes(ctx.accountId, { includeInactive: true }),
  ]);
  const label = (code: string | null) => {
    const c = codes.find((x) => x.code === code);
    return c ? (locale === "en" ? c.labelEn : c.labelBg) : (code ?? "—");
  };
  const href = (patch: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const merged = {
      decision: filters.decision,
      reason: filters.reasonCode,
      reviewer: filters.reviewerId,
      q: filters.q,
      from: filters.from,
      to: filters.to,
      ...patch,
    };
    for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== "") p.set(k, String(v));
    return `/orders/reviews?${p.toString()}`;
  };
  const seconds = (ms: number | null | undefined) =>
    ms == null
      ? "—"
      : ms < 60_000
        ? `${Math.round(ms / 1000)} s`
        : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
  const isAdmin = can(ctx.role, "reviews.reasonCodes");

  return (
    <>
      <PageHeader
        title={r("list.title")}
        subtitle={r("list.subtitle")}
        actions={
          <Link href="/orders" className={ghostButtonCls + " inline-flex items-center"}>
            ← {r("list.order")}
          </Link>
        }
      />
      <div className="flex flex-wrap gap-2 text-sm">
        {DECISIONS.map((d) => (
          <Link
            key={d}
            href={href({ decision: filters.decision === d ? undefined : d })}
            aria-current={filters.decision === d ? "true" : undefined}
            className={`rounded-full px-3 py-1 no-underline ${filters.decision === d ? "bg-accent text-white" : "bg-hover text-ink"}`}
          >
            {r(`decision.${d}`)} <span className="font-mono">{result.byDecision[d] ?? 0}</span>
          </Link>
        ))}
        <span className="ml-auto text-muted">{r("list.avg", { time: seconds(result.avgTimeMs) })}</span>
      </div>
      <Card>
        <form className="mb-4 flex flex-wrap items-end gap-3" role="search">
          <input
            name="q"
            defaultValue={filters.q}
            placeholder={r("list.search")}
            aria-label={r("list.search")}
            className={`${inputCls} w-48`}
          />
          <select
            name="decision"
            defaultValue={filters.decision ?? ""}
            aria-label={r("list.decision")}
            className={inputCls}
          >
            <option value="">{r("list.allDecisions")}</option>
            {DECISIONS.map((d) => (
              <option key={d} value={d}>
                {r(`decision.${d}`)}
              </option>
            ))}
          </select>
          <select
            name="reason"
            defaultValue={filters.reasonCode ?? ""}
            aria-label={r("list.reason")}
            className={inputCls}
          >
            <option value="">{r("list.allReasons")}</option>
            {codes.map((c) => (
              <option key={c.code} value={c.code}>
                {locale === "en" ? c.labelEn : c.labelBg}
              </option>
            ))}
          </select>
          <select
            name="reviewer"
            defaultValue={filters.reviewerId ?? ""}
            aria-label={r("list.reviewer")}
            className={inputCls}
          >
            <option value="">{r("list.allReviewers")}</option>
            {result.reviewers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
          <label className="flex flex-col gap-1 text-[13px] font-medium">
            {r("list.from")}
            <input type="date" name="from" defaultValue={filters.from} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-[13px] font-medium">
            {r("list.to")}
            <input type="date" name="to" defaultValue={filters.to} className={inputCls} />
          </label>
          <button className={ghostButtonCls}>{r("list.apply")}</button>
        </form>
        {result.rows.length === 0 ? (
          <p className="m-0 text-muted">{r("list.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={r("list.table")}>
              <thead>
                <tr>
                  <th className={thCls}>{r("list.decidedAt")}</th>
                  <th className={thCls}>{r("list.order")}</th>
                  <th className={thCls}>{r("list.decision")}</th>
                  <th className={thCls}>{r("list.reason")}</th>
                  <th className={thCls}>{r("list.changes")}</th>
                  <th className={thCls}>{r("list.findings")}</th>
                  <th className={thCls}>{r("list.reviewer")}</th>
                  <th className={`${thCls} text-right`}>{r("list.time")}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td className={`${tdCls} font-mono text-xs whitespace-nowrap`}>
                      {row.decidedAt
                        ? format.dateTime(row.decidedAt, { dateStyle: "short", timeStyle: "short" })
                        : "—"}
                    </td>
                    <td className={tdCls}>
                      <Link href={`/orders/${row.order.id}`} className="font-mono">
                        {row.order.number}
                      </Link>
                      <div className="mt-1">
                        <StatusChip status={row.order.status} />
                      </div>
                    </td>
                    <td className={tdCls}>{row.decision ? r(`decision.${row.decision}`) : "—"}</td>
                    <td className={tdCls}>
                      {label(row.reasonCode)}
                      {row.reasonText && <div className="text-xs text-muted">{row.reasonText}</div>}
                    </td>
                    <td className={`${tdCls} text-xs`}>
                      {row.changes.length === 0
                        ? "—"
                        : row.changes.map((c) => (
                            <div key={c.field} className="font-mono">
                              {c.field}: <del className="text-muted">{c.from ?? "∅"}</del> → {c.to ?? "∅"}
                            </div>
                          ))}
                    </td>
                    <td className={`${tdCls} text-xs whitespace-nowrap`}>
                      <span className="text-block">{row.hard}</span> /{" "}
                      <span className="text-warn">{row.soft}</span>
                    </td>
                    <td className={`${tdCls} text-sm`}>{row.reviewer ?? "—"}</td>
                    <td className={`${tdCls} text-right font-mono text-xs`}>{seconds(row.timeSpentMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.pages > 1 && (
          <nav aria-label={r("list.pagination")} className="mt-4 flex items-center gap-3">
            {result.page > 1 && (
              <Link href={href({ page: result.page - 1 })} className={ghostButtonCls}>
                ←
              </Link>
            )}
            <span className="text-muted">
              {r("list.pageOf", { page: result.page, pages: result.pages, total: result.total })}
            </span>
            {result.page < result.pages && (
              <Link href={href({ page: result.page + 1 })} className={ghostButtonCls}>
                →
              </Link>
            )}
          </nav>
        )}
      </Card>

      {isAdmin && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{r("reasons.title")}</h2>
          <p className="mt-0 text-sm text-muted">{r("reasons.hint")}</p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={r("reasons.table")}>
              <thead>
                <tr>
                  <th className={thCls}>{r("reasons.code")}</th>
                  <th className={thCls}>{r("reasons.labelBg")}</th>
                  <th className={thCls}>{r("reasons.labelEn")}</th>
                  <th className={thCls}>{r("reasons.decisions")}</th>
                  <th className={thCls}>{r("reasons.state")}</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody>
                {codes.map((c) => (
                  <tr key={c.code} className={c.active ? "" : "text-muted"}>
                    <td className={`${tdCls} font-mono text-[13px]`}>{c.code}</td>
                    <td className={tdCls}>{c.labelBg}</td>
                    <td className={tdCls}>{c.labelEn}</td>
                    <td className={`${tdCls} text-sm`}>
                      {c.decisions.map((k) => r(`kind.${k}`)).join(", ")}
                    </td>
                    <td className={tdCls}>{c.active ? r("reasons.active") : r("reasons.inactive")}</td>
                    <td className={tdCls}>
                      {c.code !== "other" && (
                        <form action={toggleReasonCodeAction.bind(null, c.code, !c.active)}>
                          <button
                            className={`${ghostButtonCls} text-sm`}
                            aria-label={`${c.active ? r("reasons.deactivate") : r("reasons.activate")} ${c.code}`}
                          >
                            {c.active ? r("reasons.deactivate") : r("reasons.activate")}
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ReasonCodeForm />
        </Card>
      )}
    </>
  );
}
