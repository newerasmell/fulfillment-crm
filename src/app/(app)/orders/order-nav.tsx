"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

/** Typing in a field, a dialog open, or a modifier held: the letters belong to that, not to navigation. */
function ignored(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return true;
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable ||
    !!el.closest("dialog[open]")
  );
}

/**
 * "← по-стара · по-нова →" in the order page header, with Shopify's keys: J = newer order, K = older order
 * (owner request 2026-11-09). The neighbours are worked out on the server in the member's current scope.
 */
export function OrderNav({ newer, older }: { newer: string | null; older: string | null }) {
  const t = useTranslations("orders.nav");
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ignored(e)) return;
      const k = e.key.toLowerCase();
      const to = k === "j" ? newer : k === "k" ? older : null;
      if (!to) return;
      e.preventDefault();
      router.push(`/orders/${to}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newer, older, router]);
  const btn =
    "inline-flex h-10 w-10 items-center justify-center rounded-[10px] border border-line bg-surface text-lg hover:bg-hover";
  const off = `${btn} pointer-events-none opacity-40`;
  return (
    <div className="flex items-center gap-1" data-testid="order-nav">
      {older ? (
        <Link
          href={`/orders/${older}`}
          className={btn}
          aria-label={t("older")}
          title={t("olderHint")}
          data-testid="order-older"
        >
          ←
        </Link>
      ) : (
        <span className={off} aria-disabled title={t("none")}>
          ←
        </span>
      )}
      {newer ? (
        <Link
          href={`/orders/${newer}`}
          className={btn}
          aria-label={t("newer")}
          title={t("newerHint")}
          data-testid="order-newer"
        >
          →
        </Link>
      ) : (
        <span className={off} aria-disabled title={t("none")}>
          →
        </span>
      )}
    </div>
  );
}
