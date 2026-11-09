"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fillWeightsAction, saveProductWeightAction } from "@/app/actions/rules-weights";
import { buttonCls, ghostButtonCls, inputCls } from "@/components/ui/form";

export interface SuggestionView {
  source: "eushipments" | "fhb" | "shopify";
  grams: number;
  from: string;
  raw: string;
  unitAssumed?: boolean;
}

/**
 * Master product weight in grams (1..100000): typed by a person or taken from a suggestion with one click.
 * Applies to every order; "Обнови теглото и в Shopify" queues the Shopify write-back (store mode permitting).
 */
export function WeightForm({
  productId,
  productLabel,
  current,
  suggestions,
  shopifyAllowed,
  compact = false,
}: {
  productId: string;
  productLabel: string;
  current: number | null;
  suggestions: SuggestionView[];
  shopifyAllowed: boolean;
  compact?: boolean;
}) {
  const t = useTranslations("weights");
  const router = useRouter();
  const [state, action, pending] = useActionState(saveProductWeightAction.bind(null, productId), undefined);
  const [grams, setGrams] = useState(current ? String(current) : "");
  const [source, setSource] = useState<string>("manual");
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return (
    <form
      action={action}
      className="flex flex-col gap-2"
      aria-label={`${t("enter")}: ${productLabel}`}
      data-testid={`weight-form-${productId}`}
    >
      <input type="hidden" name="source" value={source} />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <span className={compact ? "sr-only" : ""}>{t("grams")}</span>
          <input
            name="grams"
            type="number"
            min={1}
            max={100000}
            step={1}
            required
            value={grams}
            onChange={(e) => {
              setGrams(e.target.value);
              setSource("manual");
            }}
            aria-label={t("grams")}
            className={`${inputCls} min-h-10 w-32 font-mono`}
          />
        </label>
        <button type="submit" disabled={pending} className={compact ? ghostButtonCls : buttonCls}>
          {t("save")}
        </button>
      </div>
      {suggestions.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
          {suggestions.map((s, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{s.grams} g</span>
              <span className="text-muted">
                {t(`source.${s.source}`)} · {s.from} ({s.raw}){s.unitAssumed ? ` · ${t("unitAssumed")}` : ""}
              </span>
              <button
                type="button"
                className="min-h-8 rounded-full border border-line px-2 text-xs hover:bg-hover"
                onClick={() => {
                  setGrams(String(s.grams));
                  setSource(s.source);
                }}
              >
                {t("use")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="writeToShopify"
          defaultChecked={shopifyAllowed}
          disabled={!shopifyAllowed}
        />
        {t("writeShopify")}
      </label>
      {!shopifyAllowed && <span className="text-xs text-muted">{t("writeShopifyOff")}</span>}
      {state?.ok && state.recheck && (
        <span role="status" className="text-sm text-ok">
          {t("saved", {
            checked: state.recheck.checked,
            cleared: state.recheck.cleared,
            queued: state.recheck.queued,
          })}
          {state.shopify
            ? ` · ${t("shopifyQueued", { queued: state.shopify.queued })}${
                state.shopify.skippedStores.length
                  ? ` · ${t("skippedStores", { stores: state.shopify.skippedStores.join(", ") })}`
                  : ""
              }`
            : ""}
        </span>
      )}
      {state?.error && (
        <span role="status" className="text-sm text-block">
          {t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : state.error}
        </span>
      )}
    </form>
  );
}

export function FillWeightsButton({ warehouses = [] }: { warehouses?: { id: string; name: string }[] }) {
  const t = useTranslations("weights");
  const router = useRouter();
  const [state, action, pending] = useActionState(fillWeightsAction, undefined);
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      {/* "Основен склад": when euShipments warehouses disagree on a weight, this one's value is used. */}
      {warehouses.length > 1 && (
        <select
          name="preferConnectionId"
          defaultValue=""
          aria-label={t("preferWarehouse")}
          title={t("preferWarehouseHint")}
          className={`${inputCls} w-auto`}
          data-testid="weights-prefer-warehouse"
        >
          <option value="">{t("preferNone")}</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {t("preferOption", { name: w.name })}
            </option>
          ))}
        </select>
      )}
      <button type="submit" disabled={pending} className={ghostButtonCls} title={t("bulkHint")}>
        {t("bulk")}
      </button>
      {state?.bulk && (
        <span role="status" className="text-sm text-ok">
          {t("bulkDone", state.bulk)}
          {state.bulk.fromPreferred > 0 && ` ${t("bulkPreferred", { n: state.bulk.fromPreferred })}`}
        </span>
      )}
      {state?.error && (
        <span role="status" className="text-sm text-block">
          {t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : state.error}
        </span>
      )}
    </form>
  );
}
