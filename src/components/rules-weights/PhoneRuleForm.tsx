"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { saveCountryRuleAction } from "@/app/actions/rules-weights";
import { buttonCls, ghostButtonCls, inputCls, labelCls } from "@/components/ui/form";
import {
  hasBuiltinPhoneRule,
  normalisePhone,
  PhoneRuleSchema,
  type PhoneRule,
} from "@/integrations/eushipments/phone";
import { callingCodeOf, normalisePhoneE164 } from "@/integrations/fhb-v3/phone";

/**
 * The group's own phone rule for a country without a rule in the euShipments guideline. Live preview with the
 * same normalisers the senders use; a clear warning that the format must be confirmed with the warehouse.
 */
export function PhoneRuleForm({
  country,
  initial,
  samplePhone,
  needsCurrency,
  defaultCurrency,
  canRemove,
}: {
  country: string;
  initial: PhoneRule;
  samplePhone: string | null;
  needsCurrency: boolean;
  defaultCurrency: string | null;
  canRemove: boolean;
}) {
  const t = useTranslations("countries");
  const router = useRouter();
  const [state, action, pending] = useActionState(saveCountryRuleAction, undefined);
  const [style, setStyle] = useState<PhoneRule["style"]>(initial.style);
  // Known country → the ITU calling code is fixed (the server refuses any other one).
  const ituCc = callingCodeOf(country);
  const [cc, setCc] = useState(ituCc ?? initial.cc);
  const [trunk, setTrunk] = useState(initial.trunk);
  const [lengths, setLengths] = useState(initial.lengths.join(", "));
  const [phone, setPhone] = useState(samplePhone ?? "");
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  const rule = useMemo(() => {
    const r = PhoneRuleSchema.safeParse({
      style,
      cc: cc.replace(/^\+/, "").trim(),
      trunk: trunk.trim(),
      lengths: lengths
        .split(/[\s,;]+/)
        .filter(Boolean)
        .map(Number),
    });
    return r.success ? r.data : null;
  }, [style, cc, trunk, lengths]);
  const eu = rule ? normalisePhone(phone, country, rule) : null;
  const fhb = rule ? normalisePhoneE164(phone, country, rule) : null;

  return (
    <form action={action} className="flex flex-col gap-3" aria-label={t("addRuleTitle", { cc: country })}>
      <input type="hidden" name="country" value={country} />
      <p role="note" className="m-0 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">
        {hasBuiltinPhoneRule(country) ? t("warningOverride", { cc: country }) : t("warning", { cc: country })}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          {t("style")}
          <select
            name="style"
            value={style}
            onChange={(e) => setStyle(e.target.value as PhoneRule["style"])}
            className={inputCls}
          >
            <option value="international">{t("styleInternational")}</option>
            <option value="national">{t("styleNational")}</option>
          </select>
        </label>
        <label className={labelCls}>
          {t("cc")}
          <input
            name="cc"
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            readOnly={!!ituCc}
            aria-readonly={!!ituCc}
            title={ituCc ? t("ccFixed") : undefined}
            inputMode="numeric"
            className={`${inputCls} font-mono`}
          />
        </label>
        <label className={labelCls}>
          {t("trunk")}
          <input
            name="trunk"
            value={trunk}
            onChange={(e) => setTrunk(e.target.value)}
            inputMode="numeric"
            className={`${inputCls} font-mono`}
          />
        </label>
        <label className={labelCls}>
          {t("lengths")}
          <input
            name="lengths"
            value={lengths}
            onChange={(e) => setLengths(e.target.value)}
            className={`${inputCls} font-mono`}
          />
          <span className="text-xs font-normal text-muted">{t("lengthsHint")}</span>
        </label>
        {needsCurrency && (
          <label className={labelCls}>
            {t("currency")}
            <input
              name="currency"
              required
              defaultValue={defaultCurrency ?? ""}
              maxLength={3}
              className={`${inputCls} font-mono uppercase`}
            />
            <span className="text-xs font-normal text-muted">{t("currencyRequired")}</span>
          </label>
        )}
      </div>
      <fieldset className="m-0 flex flex-col gap-2 rounded-lg border border-line p-3">
        <legend className="px-1 text-sm font-semibold">{t("preview")}</legend>
        <label className={labelCls}>
          {t("previewPhone")}
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={`${inputCls} font-mono`}
          />
        </label>
        <dl
          className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm"
          data-testid="rule-preview"
        >
          <dt className="text-muted">{t("previewEu")}</dt>
          <dd className="m-0 font-mono">
            {!rule
              ? "—"
              : eu?.ok
                ? eu.value
                : t("previewInvalid", { reason: t(`reasons.${eu?.reason ?? "no_rule"}`) })}
          </dd>
          <dt className="text-muted">{t("previewFhb")}</dt>
          <dd className="m-0 font-mono">{fhb ?? "—"}</dd>
        </dl>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending || !rule} className={buttonCls}>
          {t("save")}
        </button>
        {canRemove && (
          <button type="submit" name="remove" value="1" disabled={pending} className={ghostButtonCls}>
            {t("remove")}
          </button>
        )}
        {state?.ok && state.recheck && (
          <span role="status" className="text-sm text-ok">
            {t("saved", {
              checked: state.recheck.checked,
              cleared: state.recheck.cleared,
              queued: state.recheck.queued,
            })}
          </span>
        )}
        {state?.error && (
          <span role="status" className="text-sm text-block">
            {t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : state.error}
          </span>
        )}
      </div>
    </form>
  );
}
