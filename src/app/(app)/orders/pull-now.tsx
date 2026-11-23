"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { pullOrdersNowAction } from "@/app/actions/stores";
import { ghostButtonCls } from "@/components/ui/form";

/**
 * „Изтегли поръчките сега“ (owner request 2026-11-23): the scheduled Shopify order pull, now, for every store the
 * member sees. The list refreshes itself a few times while the pulls run in the worker.
 */
export function PullOrdersNow({ lastPull }: { lastPull: string | null }) {
  const t = useTranslations("orders.pullNow");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className={`${ghostButtonCls} inline-flex items-center`}
        disabled={pending}
        data-testid="orders-pull-now"
        onClick={() =>
          start(async () => {
            const r = await pullOrdersNowAction();
            if ("error" in r) {
              setMsg({ ok: false, text: t("failed") });
              return;
            }
            setMsg({
              ok: true,
              text:
                r.queued + r.already > 0
                  ? t("queued", { n: r.queued + r.already })
                  : r.skipped > 0
                    ? t("skipped", { n: r.skipped })
                    : t("none"),
            });
            timers.current.forEach(clearTimeout);
            timers.current = [20_000, 60_000, 120_000].map((ms) => setTimeout(() => router.refresh(), ms));
          })
        }
      >
        {pending ? t("working") : t("button")}
      </button>
      <span className={`text-xs ${msg ? (msg.ok ? "text-ok" : "text-block") : "text-muted"}`} role="status">
        {msg?.text ?? (lastPull ? t("last", { at: lastPull }) : "")}
      </span>
    </div>
  );
}
