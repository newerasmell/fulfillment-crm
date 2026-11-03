import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { tdCls, thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { aiDashboard, listAuditSamples, listInteractions, listProposals } from "@/ai/views";
import {
  AuditActions,
  InteractionDetails,
  KillSwitch,
  PolicyActions,
  ProposalActions,
  ThresholdsForm,
} from "./forms";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const TABS = ["overview", "audit", "rules", "log"] as const;
type Tab = (typeof TABS)[number];

const PERMISSION: Record<Tab, Parameters<typeof can>[1]> = {
  overview: "ai.read",
  audit: "ai.audit",
  rules: "ai.rules",
  log: "ai.log",
};

const STATE_TONE: Record<string, string> = {
  PENDING: "bg-warn-bg text-warn",
  PROPOSED: "bg-warn-bg text-warn",
  CONFIRMED: "bg-ok-bg text-ok",
  ACCEPTED: "bg-ok-bg text-ok",
  REJECTED: "bg-block-bg text-block",
};

/** Настройки → AI асистент (P8-02…P8-04): status, autonomy per decision type, audit sample, proposals, log. */
export default async function AiPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const ctx = await requireAccountContext();
  const t = await getTranslations("ai");
  const format = await getFormatter();
  const actor = actorFrom(ctx);
  const allowed = TABS.filter((k) => can(ctx.role, PERMISSION[k]));
  const requested = one(sp.tab) as Tab | undefined;
  const tab: Tab | undefined = requested && allowed.includes(requested) ? requested : allowed[0];
  if (!tab)
    return (
      <>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <Card>
          <p className="m-0 text-muted">{t("error.forbidden")}</p>
        </Card>
      </>
    );

  // Every tab permission implies ai.read (rbac.ts), so the status banner and counts are always allowed here.
  const d = await aiDashboard(actor);
  const percent = (v: number | null) =>
    v == null ? t("stats.none") : format.number(v, { style: "percent", maximumFractionDigits: 1 });
  const when = (x: Date) => format.dateTime(x, { dateStyle: "short", timeStyle: "short" });
  const manage = can(ctx.role, "ai.manage");
  const banner = d.status.reason
    ? { tone: "bg-warn-bg text-warn", text: t(`status.off_${d.status.reason}`) }
    : d.control.killSwitch
      ? { tone: "bg-block-bg text-block", text: t("status.stopped") }
      : { tone: "bg-ok-bg text-ok", text: t("status.on", d.models) };

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <div
        role="status"
        data-testid="ai-status"
        className={`rounded-[var(--radius-card)] px-4 py-3 ${banner.tone}`}
      >
        <p className="m-0 font-semibold">{banner.text}</p>
        <p className="m-0 mt-1 text-sm">{t("status.neverSends")}</p>
      </div>
      <nav aria-label={t("tabs.label")} className="flex flex-wrap gap-2">
        {allowed.map((k) => (
          <Link
            key={k}
            href={`/ai?tab=${k}`}
            aria-current={tab === k ? "page" : undefined}
            className={`flex min-h-10 items-center gap-2 rounded-full border px-3 no-underline ${
              tab === k
                ? "border-accent bg-accent-soft text-accent-strong"
                : "border-line bg-surface text-ink"
            }`}
          >
            {t(`tabs.${k}`)}
            {k === "audit" && d.pendingAudit > 0 && (
              <span className="font-mono text-xs">{d.pendingAudit}</span>
            )}
            {k === "rules" && d.openProposals > 0 && (
              <span className="font-mono text-xs">{d.openProposals}</span>
            )}
          </Link>
        ))}
      </nav>

      {tab === "overview" && (
        <>
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="m-0 text-base font-semibold">{t("kill.title")}</h2>
                <p className="m-0 mt-1 text-sm text-muted">
                  {d.control.killSwitch && d.control.changedAt
                    ? t("kill.state", { at: when(d.control.changedAt) })
                    : t("kill.running")}
                  {d.control.note ? ` · ${d.control.note}` : ""}
                </p>
              </div>
              {manage && <KillSwitch on={d.control.killSwitch} />}
            </div>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            {d.policies.map((p) => (
              <Card key={p.decisionType}>
                <section aria-label={t(`type.${p.decisionType}`)} data-testid={`policy-${p.decisionType}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h2 className="m-0 text-base font-semibold">{t(`type.${p.decisionType}`)}</h2>
                      <p className="m-0 text-sm text-muted">{t(`typeHint.${p.decisionType}`)}</p>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-sm ${p.enabled ? "bg-ok-bg text-ok" : "bg-hover text-muted"}`}
                    >
                      {p.enabled ? t("enabled") : t("disabled")}
                    </span>
                  </div>
                  <ol
                    className="m-0 mt-3 flex list-none flex-wrap gap-2 p-0"
                    aria-label={t(`typeHint.${p.decisionType}`)}
                  >
                    {(["L0", "L1", "L2"] as const)
                      .filter((l) => l <= p.maxLevel)
                      .map((l) => (
                        <li
                          key={l}
                          aria-current={l === p.level ? "step" : undefined}
                          className={`rounded-full border px-3 py-1 text-sm ${
                            l === p.level
                              ? "border-accent bg-accent-soft font-semibold text-accent-strong"
                              : "border-line text-muted"
                          }`}
                        >
                          {t(`level.${l}`)}
                        </li>
                      ))}
                  </ol>
                  <p className="mt-2 mb-0 text-sm">{t(`levelHelp.${p.level}`)}</p>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
                    <div>
                      <dt className="text-label">{t("stats.decisions")}</dt>
                      <dd className="m-0 font-mono text-lg">{p.stats.decisions}</dd>
                    </div>
                    <div>
                      <dt className="text-label">{t("stats.agreement")}</dt>
                      <dd className="m-0 font-mono text-lg">{percent(p.stats.agreement)}</dd>
                    </div>
                    <div>
                      <dt className="text-label">{t("stats.critical")}</dt>
                      <dd className={`m-0 font-mono text-lg ${p.stats.criticalMisses ? "text-block" : ""}`}>
                        {p.stats.criticalMisses}
                      </dd>
                    </div>
                    {p.decisionType === "order_approval" && (
                      <div>
                        <dt className="text-label">{t("stats.autopilot")}</dt>
                        <dd className="m-0 font-mono text-lg">{p.stats.autopilot}</dd>
                      </div>
                    )}
                  </dl>
                  <p className="mt-1 mb-0 text-xs text-muted">
                    {t("stats.window", { days: p.stats.windowDays })}
                  </p>
                  <h3 className="mt-4 mb-1 text-sm font-semibold">{t("rule.title")}</h3>
                  <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                    {[
                      {
                        ok: !p.promotion.missing.includes("decisions"),
                        text: t("rule.decisions", { min: p.thresholds.minDecisions, n: p.stats.decisions }),
                      },
                      {
                        ok: !p.promotion.missing.includes("agreement"),
                        text: t("rule.agreement", {
                          min: percent(p.thresholds.minAgreement),
                          value: percent(p.stats.agreement),
                        }),
                      },
                      {
                        ok: !p.promotion.missing.includes("critical"),
                        text: t("rule.critical", { n: p.stats.criticalMisses }),
                      },
                    ].map((r) => (
                      <li key={r.text} className={r.ok ? "text-ok" : "text-ink"}>
                        <span aria-hidden>{r.ok ? "✓ " : "✗ "}</span>
                        <span className="sr-only">{r.ok ? "OK: " : "Липсва: "}</span>
                        {r.text}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 mb-0 text-sm text-muted">
                    {p.promotion.missing.includes("max_level")
                      ? t("rule.maxLevel")
                      : p.promotion.missing.includes("stopped")
                        ? t("rule.stopped")
                        : p.promotion.missing.includes("disabled")
                          ? t("rule.disabled")
                          : p.promotion.eligible
                            ? t("rule.eligible")
                            : t("rule.demotion")}
                  </p>
                  {manage && (
                    <div className="mt-3 flex flex-col gap-3">
                      <PolicyActions
                        type={p.decisionType}
                        enabled={p.enabled}
                        level={p.level}
                        next={p.promotion.next}
                        eligible={p.promotion.eligible}
                      />
                      <details>
                        <summary className="cursor-pointer text-sm text-accent">
                          {t("thresholds.title")}
                        </summary>
                        <div className="mt-3">
                          <ThresholdsForm type={p.decisionType} values={p.thresholds} />
                        </div>
                      </details>
                    </div>
                  )}
                </section>
              </Card>
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <h2 className="m-0 text-base font-semibold">{t("trend.title")}</h2>
              <table className="mt-2 w-full border-collapse text-sm" aria-label={t("trend.title")}>
                <thead>
                  <tr>
                    <th className={thCls}>{t("trend.week")}</th>
                    <th className={`${thCls} text-right`}>{t("trend.decisions")}</th>
                    <th className={`${thCls} text-right`}>{t("trend.agreement")}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.trend.map((w) => (
                    <tr key={w.start.toISOString()}>
                      <td className={tdCls}>
                        {format.dateTime(w.start, { day: "numeric", month: "short" })}
                      </td>
                      <td className={`${tdCls} text-right font-mono`}>{w.decisions}</td>
                      <td className={`${tdCls} text-right font-mono`}>{percent(w.agreement)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card>
              <h2 className="m-0 text-base font-semibold">{t("usage.title")}</h2>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <dt className="text-label">{t("usage.suggestions")}</dt>
                  <dd className="m-0 font-mono">{d.usage.suggestions24h}</dd>
                </div>
                <div>
                  <dt className="text-label">{t("usage.calls")}</dt>
                  <dd className="m-0 font-mono">
                    {d.usage.calls24h} · {t("usage.failed")} {d.usage.failed24h}
                  </dd>
                </div>
                <div>
                  <dt className="text-label">{t("usage.tokens")}</dt>
                  <dd className="m-0 font-mono">
                    {format.number(d.usage.inputTokens)} / {format.number(d.usage.outputTokens)}
                  </dd>
                </div>
                <div>
                  <dt className="text-label">{t("usage.embeddings")}</dt>
                  <dd className="m-0 font-mono">
                    {Object.entries(d.embeddings)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(" · ") || "0"}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-label">{t("usage.providers")}</dt>
                  <dd className="m-0 font-mono">
                    {d.providers.map((p) => `${p.name} (${p.model})`).join(", ")}
                  </dd>
                </div>
              </dl>
            </Card>
          </div>
        </>
      )}

      {tab === "audit" && <AuditTab actor={actor} rate={percent(d.policies[0]!.thresholds.auditRate)} />}
      {tab === "rules" && <RulesTab actor={actor} />}
      {tab === "log" && <LogTab actor={actor} />}
    </>
  );
}

type Actor = ReturnType<typeof actorFrom>;

async function AuditTab({ actor, rate }: { actor: Actor; rate: string }) {
  const t = await getTranslations("ai");
  const format = await getFormatter();
  const rows = await listAuditSamples(actor);
  return (
    <Card>
      <h2 className="m-0 text-base font-semibold">{t("audit.title")}</h2>
      <p className="mt-1 text-sm text-muted">{t("audit.subtitle", { rate })}</p>
      {rows.length === 0 ? (
        <p className="m-0 text-muted">{t("audit.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse" aria-label={t("audit.title")}>
            <thead>
              <tr>
                <th className={thCls}>{t("audit.day")}</th>
                <th className={thCls}>{t("audit.order")}</th>
                <th className={thCls}>{t("audit.confidence")}</th>
                <th className={thCls}>{t("audit.explanation")}</th>
                <th className={thCls}>{t("audit.status")}</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid="audit-row">
                  <td className={tdCls}>{format.dateTime(r.day, { dateStyle: "short" })}</td>
                  <td className={tdCls}>
                    <Link
                      href={`/orders/${r.suggestion.order.id}`}
                      className="font-mono text-accent hover:underline"
                    >
                      {r.suggestion.order.number}
                    </Link>
                  </td>
                  <td className={`${tdCls} font-mono`}>
                    {format.number(r.suggestion.confidence, { style: "percent" })}
                  </td>
                  <td className={tdCls}>{r.suggestion.explanationBg}</td>
                  <td className={tdCls}>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${STATE_TONE[r.status] ?? ""}`}>
                      {t(`audit.state.${r.status}`)}
                    </span>
                    {r.note && <p className="m-0 mt-1 text-xs text-muted">{r.note}</p>}
                  </td>
                  <td className={tdCls}>{r.status === "PENDING" && <AuditActions id={r.id} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

async function RulesTab({ actor }: { actor: Actor }) {
  const t = await getTranslations("ai");
  const format = await getFormatter();
  const rows = await listProposals(actor);
  return (
    <Card>
      <h2 className="m-0 text-base font-semibold">{t("rules.title")}</h2>
      <p className="mt-1 text-sm text-muted">{t("rules.subtitle")}</p>
      {rows.length === 0 ? (
        <p className="m-0 text-muted">{t("rules.empty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {rows.map((p) => (
            <li key={p.id} data-testid="proposal" className="rounded-xl border border-line p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <strong>{p.titleBg}</strong>
                  <span className="font-mono text-xs text-muted">{p.key}</span>
                  <span className="text-sm">
                    {t("rules.evidenceValue", { support: p.support, orders: p.distinctOrders })} ·{" "}
                    {t("rules.lastSeen")} {format.dateTime(p.lastSeenAt, { dateStyle: "short" })}
                  </span>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs ${STATE_TONE[p.status] ?? ""}`}>
                  {t(`rules.state.${p.status}`)}
                </span>
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-accent">{t("rules.brief")}</summary>
                <pre className="mt-2 overflow-auto rounded-lg bg-hover p-3 font-mono text-xs whitespace-pre-wrap">
                  {p.brief}
                </pre>
              </details>
              {p.decisionNote && <p className="m-0 mt-2 text-sm text-muted">{p.decisionNote}</p>}
              {p.status === "PROPOSED" && (
                <div className="mt-3">
                  <ProposalActions id={p.id} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

async function LogTab({ actor }: { actor: Actor }) {
  const t = await getTranslations("ai");
  const format = await getFormatter();
  const rows = await listInteractions(actor, 50);
  return (
    <Card>
      <h2 className="m-0 text-base font-semibold">{t("log.title")}</h2>
      <p className="mt-1 text-sm text-muted">{t("log.subtitle")}</p>
      {rows.length === 0 ? (
        <p className="m-0 text-muted">{t("log.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse" aria-label={t("log.title")}>
            <thead>
              <tr>
                <th className={thCls}>{t("log.time")}</th>
                <th className={thCls}>{t("log.order")}</th>
                <th className={thCls}>{t("log.model")}</th>
                <th className={thCls}>{t("log.status")}</th>
                <th className={`${thCls} text-right`}>{t("log.tokens")}</th>
                <th className={`${thCls} text-right`}>{t("log.latency")}</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid="ai-log-row">
                  <td className={`${tdCls} text-muted`}>
                    {format.dateTime(r.createdAt, { dateStyle: "short", timeStyle: "medium" })}
                  </td>
                  <td className={tdCls}>
                    {r.orderId ? (
                      <Link href={`/orders/${r.orderId}`} className="font-mono text-accent hover:underline">
                        {r.orderNumber ?? "—"}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={`${tdCls} font-mono text-sm`}>{r.model}</td>
                  <td className={tdCls}>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${r.status === "ok" ? "bg-ok-bg text-ok" : "bg-block-bg text-block"}`}
                    >
                      {t.has(`callStatus.${r.status}`) ? t(`callStatus.${r.status}`) : r.status}
                    </span>
                    {r.error && <p className="m-0 mt-1 text-xs text-muted">{r.error}</p>}
                  </td>
                  <td className={`${tdCls} text-right font-mono text-sm`}>
                    {r.inputTokens ?? "—"} / {r.outputTokens ?? "—"}
                  </td>
                  <td className={`${tdCls} text-right font-mono text-sm`}>
                    {r.latencyMs != null ? `${r.latencyMs} ms` : "—"}
                  </td>
                  <td className={tdCls}>
                    <InteractionDetails id={r.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
