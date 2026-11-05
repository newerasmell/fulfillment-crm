"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { applyAiFixesAction, requestAiReviewAction } from "@/app/actions/ai";

export function AiCardActions({
  orderId,
  suggestionId,
  canApply,
  canRequest,
}: {
  orderId: string;
  suggestionId: string | null;
  canApply: boolean;
  canRequest: boolean;
}) {
  const t = useTranslations("ai");
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<{ ok?: boolean; error?: string }>, okText: string) =>
    start(async () => {
      const r = await fn();
      setMessage(
        r.error
          ? { ok: false, text: t.has(`error.${r.error}`) ? t(`error.${r.error}`) : r.error }
          : { ok: true, text: okText },
      );
    });
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {canApply && suggestionId && (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => applyAiFixesAction(orderId, suggestionId), t("card.applied"))}
          className="min-h-10 rounded-[10px] border border-current bg-white px-3 font-semibold text-ink disabled:opacity-60"
        >
          {t("card.apply")}
        </button>
      )}
      {canRequest && (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => requestAiReviewAction(orderId), t("card.requested"))}
          className="min-h-10 rounded-[10px] border border-current px-3 disabled:opacity-60"
        >
          {t("card.request")}
        </button>
      )}
      {message && (
        <span role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "" : "text-block"}`}>
          {message.text}
        </span>
      )}
    </div>
  );
}
