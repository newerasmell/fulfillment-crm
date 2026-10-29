"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { logoutAction, setLocaleAction, setScopeAction } from "@/app/actions/session";
import { Icon } from "@/components/icons";
import type { Scope } from "./scope";

const SCOPE_DOT: Record<Scope, string> = { all: "bg-muted", fhb: "bg-fhb", eu: "bg-eu" };

export function ScopeControl({ scope }: { scope: Scope }) {
  const t = useTranslations("header");
  const router = useRouter();
  const [current, setCurrent] = useState(scope);
  const [, start] = useTransition();
  const labels: Record<Scope, string> = { all: t("scopeAll"), fhb: "FHB", eu: "euShipments" };
  return (
    <div role="group" aria-label={t("scope")} className="flex gap-0.5 rounded-[10px] bg-[#F1F1EC] p-[3px]">
      {(Object.keys(labels) as Scope[]).map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={current === s}
          onClick={() => {
            setCurrent(s);
            start(async () => {
              await setScopeAction(s);
              router.refresh();
            });
          }}
          className={`flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] ${
            current === s
              ? "bg-surface font-semibold text-ink shadow-[0_1px_2px_rgba(23,23,26,.14)]"
              : "font-medium text-muted"
          }`}
        >
          <span aria-hidden className={`size-2 rounded-full ${SCOPE_DOT[s]}`} />
          {labels[s]}
        </button>
      ))}
    </div>
  );
}

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

export function CreateMenu() {
  const t = useTranslations("header");
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const items = [t("createManualShipment"), t("createStockReceipt"), t("createProduct")];
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-[42px] items-center gap-1.5 rounded-[10px] bg-accent px-3.5 font-semibold text-white hover:bg-accent-strong"
      >
        <Icon name="plus" size={16} />
        {t("create")}
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-60 rounded-xl border border-line bg-surface p-1 shadow-lg"
        >
          {items.map((label) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              disabled
              className="flex min-h-10 w-full items-center justify-between rounded-lg px-3 text-left text-muted"
            >
              {label}
              <span className="text-[11px] uppercase">{t("comingSoon")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SearchBox() {
  const t = useTranslations("header");
  const ts = useTranslations("search");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-[42px] flex-[1_1_300px] items-center gap-2 rounded-[10px] border border-line bg-bg px-3 text-left text-muted"
      >
        <Icon name="search" size={16} />
        <span className="flex-1 truncate">{t("searchPlaceholder")}</span>
        <span className="rounded-md border border-[#D6D6D0] px-1.5 font-mono text-xs">Ctrl K</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={ts("title")}
          className="fixed inset-0 z-30 flex items-start justify-center bg-black/30 p-4 pt-[12vh]"
        >
          <div className="w-full max-w-xl rounded-2xl bg-surface p-4 shadow-xl">
            <label className="flex min-h-11 items-center gap-2 rounded-[10px] border border-line px-3">
              <Icon name="search" size={16} />
              <span className="sr-only">{t("search")}</span>
              <input
                autoFocus
                type="search"
                placeholder={t("searchPlaceholder")}
                onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
                className="flex-1 bg-transparent outline-none"
              />
            </label>
            <p className="mt-3 text-muted">{ts("hint")}</p>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="min-h-10 rounded-lg border border-line px-3"
              >
                {ts("close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function ProfileMenu({ name, locale }: { name: string; locale: string }) {
  const t = useTranslations("header");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const [, start] = useTransition();
  const change = (l: string) =>
    start(async () => {
      await setLocaleAction(l);
      setOpen(false);
      router.refresh();
    });
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={t("profile")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface py-0 pr-2.5 pl-1.5"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-[13px] font-bold text-accent-strong">
          {name.trim().charAt(0).toUpperCase()}
        </span>
        <span className="text-xs font-semibold text-muted">{locale === "bg" ? "БГ" : "EN"}</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-56 rounded-xl border border-line bg-surface p-1 shadow-lg"
        >
          <div className="px-3 py-2 text-xs text-muted">{name}</div>
          <div className="px-3 pt-1 text-[11px] font-semibold tracking-wider text-label uppercase">
            {t("language")}
          </div>
          {[
            ["bg", "Български"],
            ["en", "English"],
          ].map(([l, label]) => (
            <button
              key={l}
              type="button"
              role="menuitemradio"
              aria-checked={locale === l}
              onClick={() => change(l!)}
              className="flex min-h-10 w-full items-center rounded-lg px-3 text-left hover:bg-hover aria-checked:font-semibold"
            >
              {label}
            </button>
          ))}
          <form action={logoutAction}>
            <button
              type="submit"
              role="menuitem"
              className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-block hover:bg-block-bg"
            >
              <Icon name="logout" size={16} />
              {t("logout")}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
