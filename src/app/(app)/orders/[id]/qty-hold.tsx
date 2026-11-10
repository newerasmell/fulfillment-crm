"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { decideQtyHoldAction } from "@/app/actions/review";
import { buttonCls, ghostButtonCls } from "@/components/ui/form";

/** Противосаботаж banner on an order held for its quantity: approve (reserve the units) or cancel it. */
export function QtyHoldBanner({
  orderId,
  totalQty,
  maxProductQty,
  canDecide,
}: {
  orderId: string;
  totalQty: number;
  maxProductQty: number;
  canDecide: boolean;
}) {
  const t = useTranslations("qtyHold");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const decide = (decision: "approve" | "reject") => {
    if (!window.confirm(t(decision === "approve" ? "confirmApprove" : "confirmReject"))) return;
    start(async () => {
      const r = await decideQtyHoldAction({ orderId, decision });
      if ("error" in r) setError(r.error);
      else router.refresh();
    });
  };
  return (
    <div
      role="alert"
      data-testid="qty-hold"
      className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-block bg-block-bg px-4 py-3"
    >
      <strong className="text-sm text-block">{t("title")}</strong>
      <p className="m-0 text-sm">{t("body", { total: totalQty, max: maxProductQty })}</p>
      {canDecide && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonCls} disabled={pending} onClick={() => decide("approve")}>
            {t("approve")}
          </button>
          <button
            type="button"
            className={ghostButtonCls}
            disabled={pending}
            onClick={() => decide("reject")}
          >
            {t("reject")}
          </button>
        </div>
      )}
      {error && (
        <span className="text-sm text-block">{t.has(`error.${error}`) ? t(`error.${error}`) : error}</span>
      )}
    </div>
  );
}
