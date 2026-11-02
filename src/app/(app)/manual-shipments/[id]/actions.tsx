"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { confirmCanaryAction } from "@/app/actions/fulfill";
import { refetchLabelAction, resendLabelAction, voidLabelAction } from "@/app/actions/labels";
import { buttonCls, ghostButtonCls } from "@/components/ui/form";
import type { Finding } from "@/server/checks/findings";

function useRun() {
  const t = useTranslations("manual");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<{ ok: true } | { error: string }>, okText: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r)
        setMsg({
          ok: false,
          text: t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : t("errors.generic"),
        });
      else {
        setMsg({ ok: true, text: okText });
        router.refresh();
      }
    });
  const Note = () =>
    msg ? (
      <span role="status" className={`text-sm ${msg.ok ? "text-ok" : "text-block"}`}>
        {msg.text}
      </span>
    ) : null;
  return { pending, run, Note };
}

export function ResendButton({ id, codes }: { id: string; codes: string[] }) {
  const t = useTranslations("manual");
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [warnings, setWarnings] = useState<Finding[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const send = (ack: string[]) =>
    start(async () => {
      const r = await resendLabelAction(id, ack);
      if ("error" in r) {
        // New warnings: show them; only these exact codes can be acknowledged with the second button.
        if (r.error === "manual_preflight_needs_ack" && r.findings) setWarnings(r.findings);
        setMsg({
          ok: false,
          text: t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : t("errors.generic"),
        });
        return;
      }
      setWarnings([]);
      setMsg({ ok: true, text: t("detail.resent") });
      router.refresh();
    });
  const soft = warnings.filter((f) => f.severity === "soft");
  return (
    <span className="inline-flex flex-col gap-2">
      <span className="inline-flex flex-wrap items-center gap-3">
        <button type="button" disabled={pending} className={buttonCls} onClick={() => send(codes)}>
          {t("detail.resend")}
        </button>
        {soft.length > 0 && !warnings.some((f) => f.severity === "hard") && (
          <button
            type="button"
            disabled={pending}
            className={ghostButtonCls}
            onClick={() => send([...codes, ...soft.map((f) => f.code)])}
          >
            {t("detail.resendAnyway")}
          </button>
        )}
        {msg && (
          <span role="status" className={`text-sm ${msg.ok ? "text-ok" : "text-block"}`}>
            {msg.text}
          </span>
        )}
      </span>
      {warnings.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {warnings.map((f) => (
            <li
              key={f.code}
              className={`rounded-lg px-3 py-1 text-sm ${f.severity === "hard" ? "bg-block-bg text-block" : "bg-warn-bg text-warn"}`}
            >
              {locale === "en" ? f.message_en : f.message_bg}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

export function RefetchButton({ fulfillmentId, id }: { fulfillmentId: string; id: string }) {
  const t = useTranslations("manual.detail");
  const { pending, run, Note } = useRun();
  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={pending}
        className={ghostButtonCls}
        onClick={() => run(() => refetchLabelAction(fulfillmentId, id), t("refetchQueued"))}
      >
        {t("refetch")}
      </button>
      <Note />
    </span>
  );
}

export function VoidButton({ id }: { id: string }) {
  const t = useTranslations("manual.detail");
  const { pending, run, Note } = useRun();
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <button
        type="button"
        className="min-h-11 rounded-[10px] bg-block px-4 font-semibold text-white"
        onClick={() => setAsking(true)}
      >
        {t("void")}
      </button>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-3" role="group" aria-label={t("voidPrompt")}>
      <span className="font-medium">{t("voidPrompt")}</span>
      <button
        type="button"
        disabled={pending}
        className="min-h-11 rounded-[10px] bg-block px-4 font-semibold text-white"
        onClick={() => run(() => voidLabelAction(id), t("voidQueued"))}
      >
        {t("voidConfirm")}
      </button>
      <button type="button" className={ghostButtonCls} onClick={() => setAsking(false)}>
        {t("cancel")}
      </button>
      <Note />
    </span>
  );
}

export function CanaryConfirm({ requestId, payloadHash }: { requestId: string; payloadHash: string }) {
  const t = useTranslations("manual.detail");
  const { pending, run, Note } = useRun();
  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={pending}
        className={buttonCls}
        onClick={() => run(() => confirmCanaryAction(requestId, payloadHash), t("canaryConfirmed"))}
      >
        {t("canaryConfirm")}
      </button>
      <Note />
    </span>
  );
}
