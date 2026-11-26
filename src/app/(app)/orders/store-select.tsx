"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { inputCls } from "@/components/ui/form";
import type { StoreGroups } from "@/server/store-preferences";

/**
 * The store filter of „Поръчки“ (owner request 2026-11-25): one choice, applied at once — „Моите магазини“ (the
 * member's stores, the default once they are set), „Всички магазини“, or ONE store (only its orders). The member's
 * stores come first, grouped by product line and alphabetical; the others under „Други магазини“. Submitted with the
 * filter form as `store` (absent = mine, "all", or a store id).
 */
export function StoreSelect({
  groups,
  current,
  mine,
}: {
  groups: StoreGroups;
  /** "mine", "all", a store id, or (an older link) several ids joined by commas. */
  current: string;
  mine: string[];
}) {
  const t = useTranslations("orders.storeFilter");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(current);
  const [chosen, setChosen] = useState(0);
  // Applies the choice at once (with the rest of the filter form: tab, search, country, payment).
  useEffect(() => {
    if (chosen) box.current?.closest("form")?.requestSubmit();
  }, [chosen]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      box.current?.querySelector<HTMLButtonElement>("[data-testid=store-filter]")?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const mineSet = new Set(mine);
  const all = groups.flatMap((g) => g.stores);
  const nameOf = new Map(all.map((s) => [s.id, s.name]));
  const several = current.includes(",") ? current.split(",").filter(Boolean) : null;
  const label =
    current === "mine"
      ? t("mine", { n: mine.length })
      : current === "all"
        ? t("all")
        : several
          ? t("count", { n: several.length })
          : (nameOf.get(current) ?? t("mine", { n: mine.length }));
  const choose = (v: string) => {
    setValue(v);
    setOpen(false);
    setChosen((n) => n + 1);
  };
  const section = (title: string, filter: (id: string) => boolean, testId: string) => {
    const shown = groups
      .map((g) => ({ ...g, stores: g.stores.filter((s) => filter(s.id)) }))
      .filter((g) => g.stores.length);
    if (!shown.length) return null;
    return (
      <div className="flex flex-col gap-2" data-testid={testId}>
        {title && <span className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</span>}
        {shown.map((g) => (
          <div key={g.lineId ?? "none"} className="flex flex-col gap-0.5">
            <span className="text-xs font-semibold text-muted">{g.line ?? t("noLine")}</span>
            {g.stores.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={current === s.id}
                onClick={() => choose(s.id)}
                className={`rounded-md px-2 py-1 text-left text-sm hover:bg-hover ${
                  current === s.id ? "bg-hover font-semibold" : ""
                }`}
              >
                {s.name}
                {s.archived ? <span className="text-muted"> ({t("archived")})</span> : null}
              </button>
            ))}
          </div>
        ))}
      </div>
    );
  };
  const option = (value: string, text: string) => (
    <button
      type="button"
      aria-pressed={current === value}
      onClick={() => choose(value)}
      className={`rounded-md px-2 py-1 text-left text-sm hover:bg-hover ${
        current === value ? "bg-hover font-semibold" : ""
      }`}
    >
      {text}
    </button>
  );
  return (
    <div className="relative" ref={box}>
      {/* „Моите“ is the default: no `store` in the URL. */}
      <input type="hidden" name="store" value={value === "mine" ? "" : value} disabled={value === "mine"} />
      <button
        type="button"
        className={`${inputCls} flex min-w-56 items-center justify-between gap-2 text-left`}
        aria-expanded={open}
        aria-controls="store-filter-menu"
        onClick={() => setOpen((o) => !o)}
        data-testid="store-filter"
      >
        <span className="truncate">{label}</span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div
          className="absolute z-30 mt-1 flex max-h-[28rem] w-80 flex-col gap-3 overflow-auto rounded-[10px] border border-line bg-surface p-3 shadow-lg"
          role="group"
          aria-label={t("title")}
          id="store-filter-menu"
        >
          <div className="flex flex-col gap-0.5">
            {mine.length > 0 && option("mine", t("mine", { n: mine.length }))}
            {option("all", t("all"))}
            <Link href="/settings/my-stores" className="px-2 py-1 text-xs text-accent-strong underline">
              {t("setMine")}
            </Link>
          </div>
          {mine.length > 0 ? (
            <>
              {section(t("myStores"), (id) => mineSet.has(id), "store-filter-mine")}
              <details open={nameOf.has(current) && !mineSet.has(current)}>
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">
                  {t("otherStores")}
                </summary>
                <div className="mt-2">{section("", (id) => !mineSet.has(id), "store-filter-others")}</div>
              </details>
            </>
          ) : (
            section(t("title"), () => true, "store-filter-all")
          )}
        </div>
      )}
    </div>
  );
}
