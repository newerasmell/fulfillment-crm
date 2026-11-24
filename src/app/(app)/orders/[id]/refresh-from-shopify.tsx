"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { refreshOrderFromShopifyAction } from "@/app/actions/stores";

/**
 * „Обнови от Shopify“ (owner request 2026-11-24): this one order is read again from Shopify now (after an edit there),
 * not every store. The page refreshes itself while the worker reads it.
 */
export function RefreshFromShopify({ orderId }: { orderId: string }) {
  const t = useTranslations("orders.refreshShopify");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        className="text-accent-strong underline disabled:opacity-60"
        disabled={pending}
        data-testid="order-refresh-shopify"
        onClick={() =>
          start(async () => {
            const r = await refreshOrderFromShopifyAction(orderId);
            if ("error" in r) {
              setMsg({
                ok: false,
                text: t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : t("errors.other"),
              });
              return;
            }
            setMsg({ ok: true, text: r.reopened ? t("queuedReopened") : t("queued") });
            timers.current.forEach(clearTimeout);
            timers.current = [4_000, 12_000, 30_000].map((ms) => setTimeout(() => router.refresh(), ms));
          })
        }
      >
        {pending ? t("working") : t("button")}
      </button>
      {msg && <span className={msg.ok ? "text-ok" : "text-block"}>{msg.text}</span>}
    </span>
  );
}
