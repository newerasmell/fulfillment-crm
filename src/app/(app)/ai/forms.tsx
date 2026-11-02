"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState, useTransition } from "react";
import {
  decideAuditAction,
  decideProposalAction,
  demotePolicyAction,
  interactionDetailAction,
  promotePolicyAction,
  saveThresholdsAction,
  setKillSwitchAction,
  setPolicyEnabledAction,
  type AiActionResult,
} from "@/app/actions/ai";
import { buttonCls, ghostButtonCls, inputCls, labelCls } from "@/components/ui/form";

function useAiAction() {
  const t = useTranslations("ai");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<AiActionResult>, onOk?: () => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (r.error) setError(t.has(`error.${r.error}`) ? t(`error.${r.error}`) : r.error);
      else onOk?.();
    });
  const errorEl = error ? (
    <span role="alert" className="text-sm text-block">
      {error}
    </span>
  ) : null;
  return { t, pending, run, errorEl };
}

export function KillSwitch({ on }: { on: boolean }) {
  const { t, pending, run, errorEl } = useAiAction();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  if (!asking)
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setAsking(true)}
          className={`min-h-11 rounded-[10px] px-4 font-semibold text-white ${on ? "bg-accent" : "bg-block"}`}
        >
          {on ? t("kill.off") : t("kill.on")}
        </button>
        {errorEl}
      </div>
    );
  return (
    <form
      role="group"
      aria-label={on ? t("kill.promptOff") : t("kill.prompt")}
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () => setKillSwitchAction(!on, note),
          () => setAsking(false),
        );
      }}
    >
      <span className="font-medium">{on ? t("kill.promptOff") : t("kill.prompt")}</span>
      {!on && (
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-label={t("kill.note")}
          placeholder={t("kill.note")}
          className={inputCls}
        />
      )}
      <button
        type="submit"
        disabled={pending}
        className={`min-h-11 rounded-[10px] px-4 font-semibold text-white ${on ? "bg-accent" : "bg-block"}`}
      >
        {t("kill.confirm")}
      </button>
      <button type="button" onClick={() => setAsking(false)} className={ghostButtonCls}>
        {t("kill.cancel")}
      </button>
      {errorEl}
    </form>
  );
}

export function PolicyActions({
  type,
  enabled,
  level,
  next,
  eligible,
}: {
  type: string;
  enabled: boolean;
  level: string;
  next: string | null;
  eligible: boolean;
}) {
  const { t, pending, run, errorEl } = useAiAction();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        className={enabled ? ghostButtonCls : buttonCls}
        onClick={() => run(() => setPolicyEnabledAction(type, !enabled))}
      >
        {enabled ? t("disable") : t("enable")}
      </button>
      {next && (
        <button
          type="button"
          disabled={pending || !eligible}
          className={buttonCls}
          onClick={() => run(() => promotePolicyAction(type))}
        >
          {t("promote", { level: next })}
        </button>
      )}
      {level !== "L0" && (
        <button
          type="button"
          disabled={pending}
          className={ghostButtonCls}
          onClick={() => run(() => demotePolicyAction(type, "L0"))}
        >
          {t("demote")}
        </button>
      )}
      {errorEl}
    </div>
  );
}

export function ThresholdsForm({
  type,
  values,
}: {
  type: string;
  values: {
    windowDays: number;
    minDecisions: number;
    minAgreement: number;
    autoConfidence: number;
    auditRate: number;
    demoteMinSample: number;
    highValue: Record<string, number>;
  };
}) {
  const t = useTranslations("ai");
  const [state, action, pending] = useActionState(saveThresholdsAction, undefined);
  const pct = (v: number) => String(Math.round(v * 1000) / 10);
  const field = (name: string, label: string, value: string) => (
    <label className={labelCls}>
      {label}
      <input name={name} defaultValue={value} inputMode="decimal" className={inputCls} />
    </label>
  );
  return (
    <form action={action} className="grid gap-3 md:grid-cols-3" aria-label={t("thresholds.title")}>
      <input type="hidden" name="decisionType" value={type} />
      {field("windowDays", t("thresholds.windowDays"), String(values.windowDays))}
      {field("minDecisions", t("thresholds.minDecisions"), String(values.minDecisions))}
      {field("minAgreement", t("thresholds.minAgreement"), pct(values.minAgreement))}
      {field("autoConfidence", t("thresholds.autoConfidence"), pct(values.autoConfidence))}
      {field("auditRate", t("thresholds.auditRate"), pct(values.auditRate))}
      {field("demoteMinSample", t("thresholds.demoteMinSample"), String(values.demoteMinSample))}
      <label className={`${labelCls} md:col-span-3`}>
        {t("thresholds.highValue")}
        <textarea
          name="highValue"
          rows={2}
          defaultValue={Object.entries(values.highValue)
            .map(([c, v]) => `${c}: ${v}`)
            .join(", ")}
          className={`${inputCls} py-2 font-mono`}
        />
      </label>
      <p className="m-0 text-sm text-muted md:col-span-2">{t("thresholds.hint")}</p>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className={buttonCls}>
          {t("thresholds.save")}
        </button>
        {state?.error && (
          <span role="alert" className="text-sm text-block">
            {t.has(`error.${state.error}`) ? t(`error.${state.error}`) : state.error}
          </span>
        )}
      </div>
    </form>
  );
}

function VerdictActions({
  ok,
  no,
  noteLabel,
  noteRequired,
  onDecide,
}: {
  ok: string;
  no: string;
  noteLabel: string;
  noteRequired: boolean;
  onDecide: (verdict: "yes" | "no", note: string) => Promise<AiActionResult>;
}) {
  const { t, pending, run, errorEl } = useAiAction();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  return (
    <div className="flex flex-col gap-2">
      {!rejecting ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending}
            className="min-h-10 rounded-[10px] bg-ok px-3 font-semibold text-white disabled:opacity-60"
            onClick={() => run(() => onDecide("yes", ""))}
          >
            {ok}
          </button>
          <button type="button" className={ghostButtonCls} onClick={() => setRejecting(true)}>
            {no}
          </button>
        </div>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => onDecide("no", note));
          }}
        >
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label={noteLabel}
            placeholder={noteLabel}
            required={noteRequired}
            className={`${inputCls} min-w-56 flex-1`}
          />
          <button
            type="submit"
            disabled={pending}
            className="min-h-10 rounded-[10px] bg-block px-3 font-semibold text-white disabled:opacity-60"
          >
            {no}
          </button>
          <button type="button" className="min-h-10 px-2 text-muted" onClick={() => setRejecting(false)}>
            {t("audit.cancel")}
          </button>
        </form>
      )}
      {errorEl}
    </div>
  );
}

export function AuditActions({ id }: { id: string }) {
  const t = useTranslations("ai");
  return (
    <VerdictActions
      ok={t("audit.confirm")}
      no={t("audit.reject")}
      noteLabel={t("audit.note")}
      noteRequired
      onDecide={(v, note) => decideAuditAction(id, v === "yes" ? "confirm" : "reject", note)}
    />
  );
}

export function ProposalActions({ id }: { id: string }) {
  const t = useTranslations("ai");
  return (
    <VerdictActions
      ok={t("rules.accept")}
      no={t("rules.reject")}
      noteLabel={t("rules.note")}
      noteRequired={false}
      onDecide={(v, note) => decideProposalAction(id, v === "yes" ? "accept" : "reject", note)}
    />
  );
}

export function InteractionDetails({ id }: { id: string }) {
  const t = useTranslations("ai");
  const [data, setData] = useState<{ request?: unknown; response?: unknown; error?: string } | null>(null);
  const [pending, start] = useTransition();
  if (!data)
    return (
      <button
        type="button"
        disabled={pending}
        className={ghostButtonCls}
        onClick={() => start(async () => setData(await interactionDetailAction(id)))}
      >
        {t("log.show")}
      </button>
    );
  return (
    <div className="flex flex-col gap-2">
      <button type="button" className={ghostButtonCls} onClick={() => setData(null)}>
        {t("log.hide")}
      </button>
      {data.error ? (
        <span role="alert" className="text-sm text-block">
          {data.error}
        </span>
      ) : (
        <>
          <span className="text-xs font-semibold text-label uppercase">{t("log.request")}</span>
          <pre className="max-h-80 overflow-auto rounded-lg bg-hover p-3 font-mono text-xs whitespace-pre-wrap">
            {JSON.stringify(data.request, null, 2)}
          </pre>
          <span className="text-xs font-semibold text-label uppercase">{t("log.response")}</span>
          <pre className="max-h-80 overflow-auto rounded-lg bg-hover p-3 font-mono text-xs whitespace-pre-wrap">
            {JSON.stringify(data.response, null, 2)}
          </pre>
        </>
      )}
    </div>
  );
}
