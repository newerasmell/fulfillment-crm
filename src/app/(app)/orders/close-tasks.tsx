"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { resolveOrderTasksAction } from "@/app/actions/alerts";
import { inputCls } from "@/components/ui/form";

const PRESETS = ["moving", "test", "cancelled", "solved"] as const;

/**
 * „Затвори задачите“ (owner 2026-11-24): closes the open tasks of one order (a row in „С грешки“) or of the selected
 * orders (bulk bar) with a short reason — a preset or the person's own words. The note goes to each task's history.
 */
export function CloseTasks({
  orderIds,
  variant = "row",
  onDone,
}: {
  orderIds: string[];
  variant?: "row" | "bar";
  onDone?: () => void;
}) {
  const t = useTranslations("orders.closeTasks");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<(typeof PRESETS)[number] | "other">("moving");
  const [other, setOther] = useState("");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const dark = variant === "bar";
  const btn = dark
    ? "min-h-11 rounded-[10px] border border-white/30 px-4 hover:bg-white/10"
    : "text-xs text-accent-strong underline";

  if (!open)
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <button type="button" className={btn} onClick={() => setOpen(true)} data-testid="close-tasks-open">
          {variant === "bar" ? t("bulk", { n: orderIds.length }) : t("button")}
        </button>
        {msg && <span className={`text-xs ${dark ? "" : "text-ok"}`}>{msg}</span>}
      </span>
    );

  const note = preset === "other" ? other.trim() : t(`presets.${preset}`);
  return (
    <span className={`inline-flex flex-wrap items-center gap-2 text-xs ${dark ? "" : "text-ink"}`}>
      <select
        aria-label={t("reason")}
        value={preset}
        onChange={(e) => setPreset(e.target.value as typeof preset)}
        className={`${inputCls} !min-h-8 !py-1 text-xs ${dark ? "text-ink" : ""}`}
      >
        {PRESETS.map((p) => (
          <option key={p} value={p}>
            {t(`presets.${p}`)}
          </option>
        ))}
        <option value="other">{t("other")}</option>
      </select>
      {preset === "other" && (
        <input
          aria-label={t("note")}
          value={other}
          onChange={(e) => setOther(e.target.value)}
          maxLength={500}
          placeholder={t("notePlaceholder")}
          className={`${inputCls} !min-h-8 !py-1 text-xs ${dark ? "text-ink" : ""}`}
        />
      )}
      <button
        type="button"
        disabled={pending || note.length < 2}
        className={
          dark ? btn : "rounded-[8px] bg-accent px-2 py-1 font-semibold text-white disabled:opacity-60"
        }
        onClick={() =>
          start(async () => {
            const r = await resolveOrderTasksAction(orderIds, note);
            if (r.error) {
              setMsg(t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : t("errors.other"));
              return;
            }
            setOpen(false);
            setMsg(t("closed", { n: r.closed ?? 0 }));
            onDone?.();
            router.refresh();
          })
        }
      >
        {pending ? t("closing") : t("confirm")}
      </button>
      <button type="button" className={dark ? btn : "underline"} onClick={() => setOpen(false)}>
        {t("cancel")}
      </button>
      {msg && <span>{msg}</span>}
    </span>
  );
}
