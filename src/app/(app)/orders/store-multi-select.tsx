"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { inputCls } from "@/components/ui/form";
import type { StoreGroups } from "@/server/store-preferences";

/**
 * „Всички магазини“ (owner request 2026-11-24): stores grouped by product line (e.g. clothes / perfumes),
 * alphabetical, several at once with checkboxes. Submitted with the filter form as `store=a,b` ("all" = every store).
 */
export function StoreMultiSelect({
  groups,
  selected,
  mine,
}: {
  groups: StoreGroups;
  selected: string[];
  mine: string[];
}) {
  const t = useTranslations("orders.storeFilter");
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set(selected));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const all = groups.flatMap((g) => g.stores);
  const nameOf = new Map(all.map((s) => [s.id, s.name]));
  const label =
    picked.size === 0
      ? t("all")
      : picked.size === 1
        ? (nameOf.get([...picked][0]!) ?? t("count", { n: 1 }))
        : t("count", { n: picked.size });
  const toggle = (ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids)
        if (on) next.add(id);
        else next.delete(id);
      return next;
    });
  return (
    <div className="relative" ref={box}>
      <input type="hidden" name="store" value={picked.size ? [...picked].join(",") : "all"} />
      <button
        type="button"
        className={`${inputCls} flex min-w-56 items-center justify-between gap-2 text-left`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="store-filter"
      >
        <span className="truncate">{label}</span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div
          className="absolute z-30 mt-1 flex max-h-96 w-80 flex-col gap-2 overflow-auto rounded-[10px] border border-line bg-surface p-3 shadow-lg"
          role="group"
          aria-label={t("title")}
        >
          <div className="flex flex-wrap gap-2 text-xs">
            <button type="button" className="underline" onClick={() => setPicked(new Set())}>
              {t("all")}
            </button>
            {mine.length > 0 && (
              <button type="button" className="underline" onClick={() => setPicked(new Set(mine))}>
                {t("mine", { n: mine.length })}
              </button>
            )}
            <Link href="/settings/my-stores" className="text-accent-strong underline">
              {t("setMine")}
            </Link>
          </div>
          {groups.map((g) => {
            const ids = g.stores.map((s) => s.id);
            const every = ids.every((id) => picked.has(id));
            return (
              <fieldset key={g.lineId ?? "none"} className="m-0 flex flex-col gap-1 border-0 p-0">
                <legend className="mb-1 flex w-full items-center justify-between text-xs font-semibold text-muted">
                  <span>{g.line ?? t("noLine")}</span>
                  <button type="button" className="font-normal underline" onClick={() => toggle(ids, !every)}>
                    {every ? t("none") : t("allOfLine")}
                  </button>
                </legend>
                {g.stores.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--color-accent)]"
                      checked={picked.has(s.id)}
                      onChange={(e) => toggle([s.id], e.target.checked)}
                    />
                    <span>
                      {s.name}
                      {s.archived ? <span className="text-muted"> ({t("archived")})</span> : null}
                    </span>
                  </label>
                ))}
              </fieldset>
            );
          })}
        </div>
      )}
    </div>
  );
}
