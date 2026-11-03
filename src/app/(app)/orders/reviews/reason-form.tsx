"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { saveReasonCodeAction } from "@/app/actions/review";
import { buttonCls, inputCls, labelCls } from "@/components/ui/form";

export function ReasonCodeForm() {
  const t = useTranslations("review");
  const o = useTranslations("override");
  const [state, action, pending] = useActionState(saveReasonCodeAction, undefined);
  const err = state?.error ? `error.${state.error}` : null;
  return (
    <form action={action} aria-label={t("reasons.add")} className="mt-4 grid gap-3 sm:grid-cols-4">
      <h3 className="m-0 text-sm font-semibold sm:col-span-4">{t("reasons.add")}</h3>
      <label className={labelCls}>
        {t("reasons.code")}
        <input
          name="code"
          required
          pattern="[a-zA-Z][a-zA-Z0-9_]{1,39}"
          maxLength={40}
          className={`${inputCls} font-mono`}
        />
      </label>
      <label className={labelCls}>
        {t("reasons.labelBg")}
        <input name="labelBg" required maxLength={80} className={inputCls} />
      </label>
      <label className={labelCls}>
        {t("reasons.labelEn")}
        <input name="labelEn" required maxLength={80} className={inputCls} />
      </label>
      <fieldset className="flex flex-col gap-1 border-0 p-0 text-[13px] font-medium">
        <legend className="mb-1">{t("reasons.decisions")}</legend>
        {(["approve", "hold", "block"] as const).map((k) => (
          <label key={k} className="flex items-center gap-2 font-normal">
            <input type="checkbox" name="decisions" value={k} /> {t(`kind.${k}`)}
          </label>
        ))}
        <label className="flex items-center gap-2 font-normal">
          <input type="checkbox" name="decisions" value="warehouse" /> {o("reasonKind")}
        </label>
      </fieldset>
      <div className="flex items-center gap-3 sm:col-span-4">
        <button type="submit" disabled={pending} className={buttonCls}>
          {t("reasons.save")}
        </button>
        {state?.ok && (
          <span role="status" className="text-ok">
            ✓
          </span>
        )}
        {err && (
          <span role="alert" className="text-block">
            {t.has(err) ? t(err) : t("error.generic")}
          </span>
        )}
      </div>
    </form>
  );
}
