"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createContext, useContext, useMemo, useState, useTransition, type ReactNode } from "react";
import { startFulfillAction } from "@/app/actions/fulfill";

/**
 * Orders list selection and the sticky dark bulk bar (DESIGN.md screen 2). The bar only starts a Fulfill batch;
 * what may be sent is decided on the server for every order (the batch page shows a result per order).
 */

interface Selection {
  selected: ReadonlySet<string>;
  toggle: (id: string, on: boolean) => void;
  setAll: (on: boolean) => void;
  ids: readonly string[];
}

const Ctx = createContext<Selection | null>(null);
const useSelection = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("SelectionProvider missing");
  return s;
};

export function SelectionProvider({ ids, children }: { ids: string[]; children: ReactNode }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const value = useMemo<Selection>(
    () => ({
      selected,
      ids,
      toggle: (id, on) =>
        setSelected((prev) => {
          const next = new Set(prev);
          if (on) next.add(id);
          else next.delete(id);
          return next;
        }),
      setAll: (on) => setSelected(on ? new Set(ids) : new Set()),
    }),
    [selected, ids],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const boxCls = "size-5 cursor-pointer accent-[var(--color-accent)]";

export function SelectAllCheckbox() {
  const t = useTranslations("fulfill");
  const { selected, ids, setAll } = useSelection();
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  return (
    <input
      type="checkbox"
      className={boxCls}
      aria-label={t("selectAll")}
      checked={all}
      onChange={(e) => setAll(e.target.checked)}
    />
  );
}

export function RowCheckbox({ id, label }: { id: string; label: string }) {
  const t = useTranslations("fulfill");
  const { selected, toggle } = useSelection();
  return (
    <input
      type="checkbox"
      className={boxCls}
      aria-label={t("selectOrder", { number: label })}
      checked={selected.has(id)}
      onChange={(e) => toggle(id, e.target.checked)}
    />
  );
}

export function BulkBar({ canFulfill }: { canFulfill: boolean }) {
  const t = useTranslations("fulfill");
  const { selected, setAll } = useSelection();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (selected.size === 0) return null;
  const fulfill = () =>
    start(async () => {
      setError(null);
      const r = await startFulfillAction([...selected]);
      if ("error" in r) setError(t.has(`error.${r.error}`) ? t(`error.${r.error}`) : r.error);
      else router.push(`/orders/fulfill/${r.batchId}`);
    });
  return (
    <div
      role="region"
      aria-label={t("bulkBar")}
      className="sticky bottom-4 z-20 mt-4 flex flex-wrap items-center gap-3 rounded-[14px] bg-dark px-4 py-3 text-white shadow-lg"
    >
      <span className="font-semibold">{t("selected", { count: selected.size })}</span>
      {canFulfill && (
        <button
          type="button"
          onClick={fulfill}
          disabled={pending}
          className="min-h-11 rounded-[10px] bg-white px-4 font-semibold text-ink hover:bg-accent-soft disabled:opacity-60"
        >
          {pending ? t("starting") : t("fulfillSelected", { count: selected.size })}
        </button>
      )}
      <button
        type="button"
        onClick={() => setAll(false)}
        className="min-h-11 rounded-[10px] border border-white/30 px-4 hover:bg-white/10"
      >
        {t("clear")}
      </button>
      {error && (
        <span role="alert" className="text-[#FFB4AB]">
          {error}
        </span>
      )}
    </div>
  );
}

/** Single Fulfill on the order page: the same batch flow with one order. */
export function FulfillButton({ orderId }: { orderId: string }) {
  const t = useTranslations("fulfill");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await startFulfillAction([orderId]);
            if ("error" in r) setError(t.has(`error.${r.error}`) ? t(`error.${r.error}`) : r.error);
            else router.push(`/orders/fulfill/${r.batchId}`);
          })
        }
        className="min-h-11 rounded-[10px] bg-accent px-4 font-semibold text-white hover:bg-accent-strong disabled:opacity-60"
      >
        {pending ? t("starting") : t("fulfillOne")}
      </button>
      {error && (
        <span role="alert" className="text-block">
          {error}
        </span>
      )}
    </span>
  );
}
