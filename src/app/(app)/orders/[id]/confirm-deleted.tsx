"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { confirmWarehouseCancelByHandAction } from "@/app/actions/override";
import { inputCls } from "@/components/ui/form";

/**
 * „Складът я е изтрил — потвърди ръчно“ (owner report 2026-11-24): after a refused cancel, when the warehouse has
 * deleted the order in its own system but its API still shows the old status. A note is required.
 */
export function ConfirmDeletedByHand({ orderId, fulfillmentId }: { orderId: string; fulfillmentId: string }) {
  const t = useTranslations("orders.confirmDeleted");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!open)
    return (
      <button
        type="button"
        className="w-fit text-xs text-accent-strong underline"
        onClick={() => setOpen(true)}
        data-testid="confirm-deleted-open"
      >
        {t("button")}
      </button>
    );
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-warn bg-warn-bg p-2 text-xs">
      <span>{t("hint")}</span>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        aria-label={t("note")}
        placeholder={t("placeholder")}
        className={`${inputCls} !min-h-8 !py-1 text-xs`}
      />
      <span className="flex gap-2">
        <button
          type="button"
          disabled={pending || note.trim().length < 5}
          className="rounded-[8px] bg-block px-2 py-1 font-semibold text-white disabled:opacity-60"
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await confirmWarehouseCancelByHandAction(orderId, fulfillmentId, note);
              if ("error" in r) {
                setError(t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : t("errors.other"));
                return;
              }
              router.refresh();
            })
          }
        >
          {t("confirm")}
        </button>
        <button type="button" className="underline" onClick={() => setOpen(false)}>
          {t("cancel")}
        </button>
      </span>
      {error && (
        <span role="alert" className="text-block">
          {error}
        </span>
      )}
    </div>
  );
}
