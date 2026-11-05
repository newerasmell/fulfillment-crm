"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { saveCountryCurrencyAction } from "@/app/actions/rules-weights";
import { ghostButtonCls, inputCls } from "@/components/ui/form";

/** Настройки → Държави: the local currency of one country (every row, also the built-in phone-rule ones). */
export function CountryCurrencyForm({ country, currency }: { country: string; currency: string | null }) {
  const t = useTranslations("countries");
  const router = useRouter();
  const [state, action, pending] = useActionState(saveCountryCurrencyAction, undefined);
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return (
    <form
      action={action}
      className="flex flex-wrap items-center gap-2"
      data-testid={`currency-form-${country}`}
    >
      <input type="hidden" name="country" value={country} />
      <input
        name="currency"
        required
        maxLength={3}
        defaultValue={currency ?? ""}
        placeholder="EUR"
        aria-label={t("currencyFor", { country })}
        className={`${inputCls} w-20 font-mono uppercase`}
      />
      <button type="submit" disabled={pending} className={`${ghostButtonCls} px-2 py-0.5 text-xs`}>
        {t("saveCurrency")}
      </button>
      {state?.error && (
        <span className="text-xs text-block">
          {t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : state.error}
        </span>
      )}
      {state?.ok && <span className="text-xs text-ok">{t("savedCurrency")}</span>}
    </form>
  );
}
