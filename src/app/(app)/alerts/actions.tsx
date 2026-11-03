"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { assignAlertAction, resolveAlertAction } from "@/app/actions/alerts";

/** Assign to me / unassign and resolve with a (required) note for one alert row. */
export function AlertActions({ alertId, title, mine }: { alertId: string; title: string; mine: boolean }) {
  const t = useTranslations("alerts");
  const [pending, start] = useTransition();
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok?: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (r.error) setError(t.has(`error.${r.error}`) ? t(`error.${r.error}`) : r.error);
      else setResolving(false);
    });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => assignAlertAction(alertId, !mine))}
          className="min-h-10 rounded-[10px] border border-line bg-surface px-3 hover:bg-hover disabled:opacity-60"
        >
          {mine ? t("unassign") : t("assignToMe")}
        </button>
        {!resolving && (
          <button
            type="button"
            onClick={() => setResolving(true)}
            className="min-h-10 rounded-[10px] bg-accent px-3 font-semibold text-white hover:bg-accent-strong"
          >
            {t("resolve")}
          </button>
        )}
      </div>
      {resolving && (
        <form
          className="flex flex-wrap items-center gap-2"
          aria-label={t("resolveForm", { title })}
          onSubmit={(e) => {
            e.preventDefault();
            run(() => resolveAlertAction(alertId, note));
          }}
        >
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label={t("note")}
            placeholder={t("notePlaceholder")}
            className="min-h-10 min-w-56 flex-1 rounded-[10px] border border-line bg-surface px-3 outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={pending}
            className="min-h-10 rounded-[10px] bg-ok px-3 font-semibold text-white disabled:opacity-60"
          >
            {t("confirmResolve")}
          </button>
          <button type="button" onClick={() => setResolving(false)} className="min-h-10 px-2 text-muted">
            {t("cancel")}
          </button>
        </form>
      )}
      {error && (
        <span role="alert" className="text-sm text-block">
          {error}
        </span>
      )}
    </div>
  );
}
