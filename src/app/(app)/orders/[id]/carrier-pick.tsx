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
const OTHER = "__other__";

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
  // "Друг куриер": a courier Shopify does not list (e.g. Express One), with our tracking link.
  const [customName, setCustomName] = useState("");
  const [template, setTemplate] = useState("");
  const custom = company === OTHER;
  const ready = custom ? !!customName.trim() && !!template.trim() : !!company;
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-center gap-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        start(async () => {
          const r = await setShipmentCarrierAction(
            custom
              ? {
                  orderId,
                  fulfillmentId: s.fulfillmentId,
                  company: customName.trim(),
                  custom: true,
                  urlTemplate: template.trim(),
                }
              : { orderId, fulfillmentId: s.fulfillmentId, company },
          );
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
            <option value={OTHER}>{t("other")}</option>
            {companies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {custom && (
            <>
              <input
                className={`${inputCls} w-40`}
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder={t("otherName")}
                aria-label={t("otherName")}
                maxLength={64}
                data-testid={`carrier-custom-name-${s.fulfillmentId}`}
              />
              <input
                className={`${inputCls} min-w-72 flex-1`}
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                placeholder="https://…?number={tracking}"
                aria-label={t("otherLink")}
                maxLength={500}
                data-testid={`carrier-custom-link-${s.fulfillmentId}`}
              />
              <span className="w-full text-xs text-muted">{t("otherHint")}</span>
            </>
          )}
          <button type="submit" disabled={pending || !ready} className={`${buttonCls} px-3 py-1 text-sm`}>
            {t("save")}
          </button>
          <span className="w-full text-xs text-muted">
            {s.carrier ? t("remember", { carrier: s.carrier }) : t("rememberNone")}
          </span>
        </>
      )}
      {error && (
        <span className="w-full text-block">{t.has(`error.${error}`) ? t(`error.${error}`) : error}</span>
      )}
    </form>
  );
}
