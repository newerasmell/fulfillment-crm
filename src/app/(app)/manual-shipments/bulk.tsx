"use client";

import { useTranslations } from "next-intl";
import { createContext, useContext, useMemo, useState, useTransition, type ReactNode } from "react";
import { bulkLabelsAction, bulkStatusAction } from "@/app/actions/labels";

/**
 * Selection + sticky dark bulk bar for "one PDF with all labels" (DESIGN.md). The worker builds it with the
 * vendor's bulk endpoint (Joy GET /labels ≤ 100, euShipments merged/print ≤ 50) — one PDF per warehouse account.
 */

interface Sel {
  selected: ReadonlySet<string>;
  toggle: (id: string, on: boolean) => void;
  setAll: (on: boolean) => void;
  ids: readonly string[];
}
const Ctx = createContext<Sel | null>(null);
const useSel = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("LabelSelection missing");
  return s;
};

export function LabelSelection({ ids, children }: { ids: string[]; children: ReactNode }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const value = useMemo<Sel>(
    () => ({
      selected,
      ids,
      toggle: (id, on) =>
        setSelected((p) => {
          const n = new Set(p);
          if (on) n.add(id);
          else n.delete(id);
          return n;
        }),
      setAll: (on) => setSelected(on ? new Set(ids) : new Set()),
    }),
    [selected, ids],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const box = "size-5 cursor-pointer accent-[var(--color-accent)]";

export function SelectAllLabels() {
  const t = useTranslations("manual");
  const { selected, ids, setAll } = useSel();
  if (ids.length === 0) return null;
  return (
    <input
      type="checkbox"
      className={box}
      aria-label={t("bulk.selectAll")}
      checked={ids.every((i) => selected.has(i))}
      onChange={(e) => setAll(e.target.checked)}
    />
  );
}

export function LabelCheckbox({ id, number }: { id: string; number: string }) {
  const t = useTranslations("manual");
  const { selected, toggle } = useSel();
  return (
    <input
      type="checkbox"
      className={box}
      aria-label={t("bulk.select", { number })}
      checked={selected.has(id)}
      onChange={(e) => toggle(id, e.target.checked)}
    />
  );
}

type Job = Awaited<ReturnType<typeof bulkStatusAction>>[number];

export function BulkLabelBar() {
  const t = useTranslations("manual");
  const { selected, setAll } = useSel();
  const [pending, start] = useTransition();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(0);

  const poll = async (ids: string[], left = 30) => {
    const rows = await bulkStatusAction(ids);
    setJobs(rows);
    if (left > 0 && rows.some((r) => r.status === "QUEUED" || r.status === "RUNNING"))
      setTimeout(() => void poll(ids, left - 1), 2000);
  };
  const run = () =>
    start(async () => {
      setError(null);
      const r = await bulkLabelsAction([...selected]);
      if ("error" in r)
        return setError(t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : t("errors.generic"));
      setSkipped(r.skipped);
      await poll(r.jobIds);
    });

  if (selected.size === 0 && jobs.length === 0) return null;
  return (
    <div
      role="region"
      aria-label={t("bulk.bar")}
      className="sticky bottom-4 z-20 mt-4 flex flex-wrap items-center gap-3 rounded-[14px] bg-dark px-4 py-3 text-white shadow-lg"
    >
      {selected.size > 0 && (
        <span className="font-semibold">{t("bulk.selected", { count: selected.size })}</span>
      )}
      {selected.size > 0 && (
        <button
          type="button"
          onClick={run}
          disabled={pending}
          className="min-h-11 rounded-[10px] bg-white px-4 font-semibold text-ink hover:bg-accent-soft disabled:opacity-60"
        >
          {pending ? t("bulk.running") : t("bulk.print")}
        </button>
      )}
      {jobs.map((j, i) => (
        <span key={j.id} role="status" className="flex items-center gap-2">
          {j.status === "DONE" && j.labelId ? (
            <a
              href={`/api/labels/${j.labelId}`}
              target="_blank"
              rel="noopener"
              className="font-semibold text-white underline"
            >
              {t("bulk.download", { n: i + 1 })}
            </a>
          ) : j.status === "FAILED" ? (
            <span className="text-[#FFB4AB]">{t("bulk.failed", { error: j.error ?? "" })}</span>
          ) : (
            <span>{t("bulk.waiting")}</span>
          )}
        </span>
      ))}
      {skipped > 0 && <span className="text-white/80">{t("bulk.skipped", { count: skipped })}</span>}
      <button
        type="button"
        onClick={() => {
          setAll(false);
          setJobs([]);
        }}
        className="min-h-11 rounded-[10px] border border-white/30 px-4 hover:bg-white/10"
      >
        {t("bulk.clear")}
      </button>
      {error && (
        <span role="alert" className="text-[#FFB4AB]">
          {error}
        </span>
      )}
    </div>
  );
}
