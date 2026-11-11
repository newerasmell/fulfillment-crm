"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { warehouseRecheckAction } from "@/app/actions/fulfill";
import { buttonCls } from "@/components/ui/form";

/**
 * An interrupted create-order (worker stopped inside the vendor call): the result is unknown. An OWNER / ADMIN asks
 * the CRM to look it up at the warehouse — found = sent, absent = sent again (CANARY asks for a click).
 */
export function WarehouseRecheck({
  requestId,
  refusal,
  canRun,
  lastCheckError,
}: {
  requestId: string;
  refusal: string | null;
  canRun: boolean;
  /** What the last "Провери в склада" said when it could not decide. */
  lastCheckError: string | null;
}) {
  const t = useTranslations("override.recheck");
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      if (!window.confirm(t("confirm"))) return;
      const r = await warehouseRecheckAction(requestId);
      if ("error" in r) {
        const code = r.error.replace(/^recheck_/, "");
        setMsg({ ok: false, text: t.has(`why.${code}`) ? t(`why.${code}`) : t("failed") });
      } else {
        setMsg({ ok: true, text: t("started") });
        setTimeout(() => router.refresh(), 8000);
      }
    });
  return (
    <div
      className="flex w-full flex-col gap-1 rounded-lg bg-warn-bg px-3 py-2 text-sm"
      data-testid="warehouse-recheck"
    >
      <span className="font-semibold text-warn">{t("title")}</span>
      <span className="text-xs text-ink">{t("explain")}</span>
      {lastCheckError && (
        <span className="text-xs text-block" data-testid="warehouse-recheck-last">
          {t("lastCheck", { error: lastCheckError })}
        </span>
      )}
      {refusal ? (
        <span className="text-xs text-muted" data-testid="warehouse-recheck-refusal">
          {t.has(`why.${refusal}`) ? t(`why.${refusal}`) : refusal}
        </span>
      ) : canRun ? (
        <button
          type="button"
          className={`${buttonCls} self-start px-3 py-1 text-sm`}
          disabled={pending}
          onClick={run}
        >
          {t("button")}
        </button>
      ) : (
        <span className="text-xs text-muted">{t("managersOnly")}</span>
      )}
      {msg && <span className={`text-xs ${msg.ok ? "text-ok" : "text-block"}`}>{msg.text}</span>}
    </div>
  );
}
