"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { saveStockSettingsAction } from "@/app/actions/stock";
import { buttonCls, inputCls, labelCls } from "@/components/ui/form";

export function StockError({ code, detail }: { code?: string; detail?: string }) {
  const t = useTranslations("stock");
  if (!code) return null;
  return (
    <p role="alert" className="m-0 rounded-md bg-block-bg px-3 py-2 text-sm text-block">
      {t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.generic", { code })}
      {detail && <span className="block text-xs">{detail}</span>}
    </p>
  );
}

export function StockSettingsForm({
  values,
  canEdit,
}: {
  values: { shopifyThreshold: number; fhbStaleHours: number; euStaleHours: number; runOutDays: number };
  canEdit: boolean;
}) {
  const t = useTranslations("stock");
  const [state, action, pending] = useActionState(saveStockSettingsAction, undefined);
  const field = (name: keyof typeof values, max: number) => (
    <label className={labelCls}>
      {t(`settings.${name}`)}
      <input
        name={name}
        type="number"
        min={name === "shopifyThreshold" ? 0 : 1}
        max={max}
        required
        defaultValue={values[name]}
        disabled={!canEdit}
        className={inputCls}
      />
    </label>
  );
  return (
    <form action={action} className="flex flex-col gap-3" aria-label={t("settings.title")}>
      {field("shopifyThreshold", 10000)}
      {field("fhbStaleHours", 336)}
      {field("euStaleHours", 336)}
      {field("runOutDays", 90)}
      {canEdit ? (
        <button type="submit" disabled={pending} className={buttonCls}>
          {t("settings.save")}
        </button>
      ) : (
        <p className="m-0 text-xs text-muted">{t("settings.adminOnly")}</p>
      )}
      {state?.ok && (
        <span role="status" className="text-sm text-ok">
          {t("settings.saved")}
        </span>
      )}
      <StockError code={state?.error} />
    </form>
  );
}
