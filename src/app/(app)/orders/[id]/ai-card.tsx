import { getFormatter, getTranslations } from "next-intl/server";
import { can } from "@/server/auth/rbac";
import type { ScopedActor } from "@/server/stores";
import { orderAiCard } from "@/ai/views";
import { AiCardActions } from "./ai-card-actions";

const FIELD_KEY: Record<string, string> = {
  phone: "phone",
  "shippingAddress.company": "company",
  "shippingAddress.address1": "address1",
  "shippingAddress.address2": "address2",
  "shippingAddress.city": "city",
  "shippingAddress.zip": "zip",
  "shippingAddress.province": "province",
};

/** The AI card on the order detail (DESIGN.md: dark panel). Shows the latest suggestion; it never acts itself. */
export async function AiCard({ actor, orderId }: { actor: ScopedActor; orderId: string }) {
  if (!can(actor.role, "ai.read")) return null;
  const t = await getTranslations("ai");
  const r = await getTranslations("review.address.field");
  const format = await getFormatter();
  const card = await orderAiCard(actor, orderId);
  const s = card.suggestion;
  const note = !card.status.enabled
    ? card.status.reason === "no_api_key"
      ? t("card.off")
      : t("status.off_global_kill_switch")
    : card.stopped
      ? t("card.stopped")
      : !card.approvalPolicy.enabled
        ? t("card.policyOff")
        : null;
  const fieldLabel = (f: string) => (FIELD_KEY[f] ? r(FIELD_KEY[f]!) : f);
  const guardrail = (g: string) =>
    g.startsWith("fix_dropped:")
      ? t("guardrail.fix_dropped", { field: g.slice("fix_dropped:".length) })
      : t.has(`guardrail.${g}`)
        ? t(`guardrail.${g}`)
        : g;
  // Colour by confidence (owner request 2026-11-05): ≥ 80 % green, 50–79 % amber, below 50 % red; none = neutral.
  const tone = !s ? "none" : s.confidence >= 0.8 ? "high" : s.confidence >= 0.5 ? "mid" : "low";
  const TONE = {
    high: { card: "border-[#b9e0c7] bg-[#e9f6ee] text-[#103d24]", pill: "bg-ok text-white" },
    mid: { card: "border-[#f0d9ad] bg-[#fdf6e9] text-[#4a2a05]", pill: "bg-[#b45309] text-white" },
    low: { card: "border-[#f3c3be] bg-block-bg text-[#5a120c]", pill: "bg-block text-white" },
    none: { card: "border-line bg-surface text-ink", pill: "bg-hover text-ink" },
  }[tone];
  return (
    <section
      aria-label={t("card.title")}
      data-testid="ai-card"
      data-tone={tone}
      className={`rounded-[var(--radius-card)] border p-5 ${TONE.card}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-base font-semibold">✦ {t("card.title")}</h2>
        {s && (
          <span className={`rounded-full px-2.5 py-0.5 text-sm font-semibold ${TONE.pill}`}>
            {t(`decision.${s.decision}`)} ·{" "}
            {t("card.confidence", { value: format.number(s.confidence, { style: "percent" }) })}
          </span>
        )}
      </div>
      {note && <p className="mt-2 mb-0 text-sm opacity-80">{note}</p>}
      {!s ? (
        <p className="mt-2 mb-0 text-sm opacity-80">{t("card.none")}</p>
      ) : (
        <div className={`mt-2 flex flex-col gap-2 ${s.stale ? "opacity-70" : ""}`}>
          {s.stale && (
            <p className="m-0 rounded-lg bg-warn-bg px-2 py-1 text-sm text-warn" role="status">
              {t("card.stale")}
            </p>
          )}
          <p className="m-0">{s.explanationBg}</p>
          {s.fixes.length > 0 && (
            <div>
              <h3 className="m-0 text-xs font-semibold tracking-wide opacity-75 uppercase">
                {t("card.fixes")}
              </h3>
              <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0 text-sm">
                {s.fixes.map((f) => (
                  <li key={f.field}>
                    <span className="opacity-75">{fieldLabel(f.field)}: </span>
                    <span className="line-through opacity-70">{f.from ?? "∅"}</span> →{" "}
                    <strong className="font-mono">{f.to}</strong>
                    {f.reason && <span className="opacity-75"> — {f.reason}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {s.flags.length > 0 && (
            <p className="m-0 text-sm">
              <span className="opacity-75">{t("card.flags")}: </span>
              {s.flags.map((f) => (t.has(`flag.${f}`) ? t(`flag.${f}`) : f)).join(", ")}
            </p>
          )}
          {s.guardrails.length > 0 && (
            <p className="m-0 text-sm">
              <span className="opacity-75">{t("card.guardrails")}: </span>
              {s.guardrails.map(guardrail).join(", ")}
            </p>
          )}
          {s.autoApprovedAt && (
            <p className="m-0 text-sm font-semibold">
              {t("card.autopilot", {
                at: format.dateTime(s.autoApprovedAt, { dateStyle: "short", timeStyle: "short" }),
              })}
            </p>
          )}
          {s.humanDecision && (
            <p className="m-0 text-sm">
              {t("card.outcome", {
                decision: t.has(`decision.${s.humanDecision}`)
                  ? t(`decision.${s.humanDecision}`)
                  : s.humanDecision,
                agreed: s.decisionAgreed ? t("card.agreed") : t("card.disagreed"),
              })}
            </p>
          )}
          <p className="m-0 text-xs opacity-60">
            {t("card.model", {
              model: s.model,
              at: format.dateTime(s.createdAt, { dateStyle: "short", timeStyle: "short" }),
            })}{" "}
            · {t("card.similar", { n: s.similarCount })}
          </p>
        </div>
      )}
      {(card.canApplyFixes || (card.canRequest && card.status.enabled && !card.stopped)) && (
        <AiCardActions
          orderId={orderId}
          suggestionId={s?.id ?? null}
          canApply={card.canApplyFixes}
          canRequest={card.canRequest && card.status.enabled && !card.stopped}
        />
      )}
    </section>
  );
}
