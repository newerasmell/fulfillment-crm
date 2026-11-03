"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { reviewTicketAction } from "@/app/actions/shipments";

/** "Прегледан" with a required note (audited on the server). */
export function TicketReview({ ticketId, reference }: { ticketId: string; reference: string }) {
  const t = useTranslations("tickets");
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="min-h-10 rounded-[10px] bg-accent px-3 font-semibold text-white hover:bg-accent-strong"
        >
          {t("markReviewed")}
        </button>
      </div>
    );
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      aria-label={t("reviewForm", { reference })}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const r = await reviewTicketAction(ticketId, note);
          if (r.error) setError(t.has(`error.${r.error}`) ? t(`error.${r.error}`) : r.error);
          else setOpen(false);
        });
      }}
    >
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-label={t("noteLabel")}
        placeholder={t("notePlaceholder")}
        className="min-h-10 min-w-56 flex-1 rounded-[10px] border border-line bg-surface px-3 outline-none focus:border-accent"
      />
      <button
        type="submit"
        disabled={pending}
        className="min-h-10 rounded-[10px] bg-ok px-3 font-semibold text-white disabled:opacity-60"
      >
        {t("confirmReviewed")}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="min-h-10 px-2 text-muted">
        {t("cancel")}
      </button>
      {error && (
        <span role="alert" className="w-full text-sm text-block">
          {error}
        </span>
      )}
    </form>
  );
}
