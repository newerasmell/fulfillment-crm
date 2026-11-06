"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { setShipmentCarrierAction } from "@/app/actions/fulfill";
import { buttonCls, inputCls } from "@/components/ui/form";

/**
 * Shown on the order while a Shopify tracking write-back waits because Shopify does not know the shipment's carrier
 * (owner request 2026-11-06): a person picks the right Shopify company; the CRM then sends the tracking.
 */
export function CarrierPick({
  orderId,
  shipments,
  companies,
  canSet,
}: {
  orderId: string;
  shipments: { fulfillmentId: string; carrier: string | null; tracking: string | null }[];
  companies: string[];
  canSet: boolean;
}) {
  const t = useTranslations("fulfill.carrierPick");
  return (
    <div
      role="alert"
      data-testid="carrier-pick"
      className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-warn bg-warn-bg px-4 py-3"
    >
      <strong className="text-sm text-warn">{t("title")}</strong>
      <p className="m-0 text-sm">{t("body")}</p>
      {shipments.map((s) => (
        <Row key={s.fulfillmentId} orderId={orderId} s={s} companies={companies} canSet={canSet} />
      ))}
    </div>
  );
}

function Row({
  orderId,
  s,
  companies,
  canSet,
}: {
  orderId: string;
  s: { fulfillmentId: string; carrier: string | null; tracking: string | null };
  companies: string[];
  canSet: boolean;
}) {
  const t = useTranslations("fulfill.carrierPick");
  const router = useRouter();
  const [company, setCompany] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-center gap-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (!company) return;
        start(async () => {
          const r = await setShipmentCarrierAction({ orderId, fulfillmentId: s.fulfillmentId, company });
          if ("error" in r) setError(r.error);
          else router.refresh();
        });
      }}
    >
      <span>
        {t("carrier")}: <strong>{s.carrier ?? t("none")}</strong>
        {s.tracking && <span className="ml-2 font-mono text-[13px]">{s.tracking}</span>}
      </span>
      {canSet && (
        <>
          <select
            className={`${inputCls} w-auto`}
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            aria-label={t("choose")}
            data-testid={`carrier-select-${s.fulfillmentId}`}
          >
            <option value="">{t("choose")}</option>
            {companies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button type="submit" disabled={pending || !company} className={`${buttonCls} px-3 py-1 text-sm`}>
            {t("save")}
          </button>
          {s.carrier && (
            <span className="w-full text-xs text-muted">{t("remember", { carrier: s.carrier })}</span>
          )}
        </>
      )}
      {error && (
        <span className="w-full text-block">{t.has(`error.${error}`) ? t(`error.${error}`) : error}</span>
      )}
    </form>
  );
}
