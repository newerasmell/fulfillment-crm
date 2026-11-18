"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { recheckOrderTasksAction } from "@/app/actions/fulfill";
import { buttonCls } from "@/components/ui/form";

/** "Провери задачите": closes the order's tasks whose cause is gone; says which stay and why. */
export function TasksRecheck({ orderId }: { orderId: string }) {
  const t = useTranslations("orders.tasksRecheck");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string; kept: string[] } | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="tasks-recheck">
      <button
        type="button"
        className={`${buttonCls} px-3 py-1 text-sm`}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await recheckOrderTasksAction(orderId);
            if ("error" in r) return setMsg({ ok: false, text: t("failed"), kept: [] });
            setMsg({
              ok: true,
              text: r.closed ? t("closed", { n: r.closed }) : t("nothing"),
              kept: r.kept.map((k) => `${k.title} — ${k.why ? t(`why.${k.why}`) : t("manual")}`),
            });
            router.refresh();
          })
        }
      >
        {pending ? t("checking") : t("button")}
      </button>
      {msg && (
        <span className={`text-xs ${msg.ok ? "text-ok" : "text-block"}`} data-testid="tasks-recheck-result">
          {msg.text}
        </span>
      )}
      {msg && msg.kept.length > 0 && (
        <ul className="m-0 w-full list-none p-0 text-xs text-muted" data-testid="tasks-recheck-kept">
          {msg.kept.map((k) => (
            <li key={k}>{t("stays", { what: k })}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
