"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { saveRoutingRuleAction } from "@/app/actions/routing";
import { buttonCls, inputCls, labelCls } from "@/components/ui/form";

export interface RuleFormValues {
  id?: string;
  name: string;
  connectionId: string;
  enabled: boolean;
  storeIds: string[];
  countries: string;
  payment: "" | "COD" | "PREPAID";
  tags: string;
  excludeTags: string;
  skus: string;
  requireStock: boolean;
  parcelService: string;
  courierId: string;
  serviceName: string;
  deliveryPointPolicy: string;
}

export const EMPTY_RULE: RuleFormValues = {
  name: "",
  connectionId: "",
  enabled: true,
  storeIds: [],
  countries: "",
  payment: "",
  tags: "",
  excludeTags: "",
  skus: "",
  requireStock: false,
  parcelService: "",
  courierId: "",
  serviceName: "",
  deliveryPointPolicy: "",
};

export function RuleForm({
  values,
  connections,
  stores,
}: {
  values: RuleFormValues;
  connections: { id: string; label: string }[];
  stores: { id: string; label: string }[];
}) {
  const t = useTranslations("routing");
  const [state, action, pending] = useActionState(saveRoutingRuleAction, undefined);
  const key = values.id ?? "new";
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2" aria-label={values.id ? t("edit") : t("add")}>
      {values.id && <input type="hidden" name="ruleId" value={values.id} />}
      <label className={labelCls}>
        {t("name")}
        <input name="name" required maxLength={120} defaultValue={values.name} className={inputCls} />
      </label>
      <label className={labelCls}>
        {t("connection")}
        <select name="connectionId" required defaultValue={values.connectionId} className={inputCls}>
          <option value="" disabled>
            {t("chooseConnection")}
          </option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="flex flex-col gap-1 sm:col-span-2">
        <legend className="text-[13px] font-medium">{t("stores")}</legend>
        <span className="text-xs text-muted">{t("storesHint")}</span>
        <div className="flex flex-wrap gap-3">
          {stores.map((s) => (
            <label key={s.id} className="flex min-h-10 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="storeIds"
                value={s.id}
                defaultChecked={values.storeIds.includes(s.id)}
              />
              {s.label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className={labelCls}>
        {t("countries")}
        <input
          name="countries"
          defaultValue={values.countries}
          placeholder="BG, RO"
          className={`${inputCls} font-mono uppercase`}
        />
        <span className="text-xs font-normal text-muted">{t("listHint")}</span>
      </label>
      <label className={labelCls}>
        {t("payment")}
        <select name="payment" defaultValue={values.payment} className={inputCls}>
          <option value="">{t("paymentAny")}</option>
          <option value="COD">{t("paymentCod")}</option>
          <option value="PREPAID">{t("paymentPrepaid")}</option>
        </select>
      </label>
      <label className={labelCls}>
        {t("tags")}
        <input name="tags" defaultValue={values.tags} className={inputCls} />
        <span className="text-xs font-normal text-muted">{t("tagsHint")}</span>
      </label>
      <label className={labelCls}>
        {t("excludeTags")}
        <input name="excludeTags" defaultValue={values.excludeTags} className={inputCls} />
      </label>
      <label className={`${labelCls} sm:col-span-2`}>
        {t("skus")}
        <input name="skus" defaultValue={values.skus} className={`${inputCls} font-mono`} />
        <span className="text-xs font-normal text-muted">{t("skusHint")}</span>
      </label>
      <label className={labelCls}>
        {t("parcelService")}
        <input name="parcelService" defaultValue={values.parcelService} className={`${inputCls} font-mono`} />
      </label>
      <label className={labelCls}>
        {t("courierId")}
        <input name="courierId" defaultValue={values.courierId} className={`${inputCls} font-mono`} />
      </label>
      <label className={labelCls}>
        {t("serviceName")}
        <input name="serviceName" defaultValue={values.serviceName} className={inputCls} />
      </label>
      <label className={labelCls}>
        {t("deliveryPointPolicy")}
        <input name="deliveryPointPolicy" defaultValue={values.deliveryPointPolicy} className={inputCls} />
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm" htmlFor={`requireStock-${key}`}>
        <input
          id={`requireStock-${key}`}
          type="checkbox"
          name="requireStock"
          defaultChecked={values.requireStock}
        />
        {t("requireStock")}
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm" htmlFor={`enabled-${key}`}>
        <input id={`enabled-${key}`} type="checkbox" name="enabled" defaultChecked={values.enabled} />
        {t("enabled")}
      </label>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonCls}>
          {values.id ? t("save") : t("create")}
        </button>
        {state?.error && (
          <span role="status" className="text-block">
            {t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : t("errors.generic")}
          </span>
        )}
        {state?.ok && (
          <span role="status" className="text-ok">
            {t("saved")}
          </span>
        )}
      </div>
    </form>
  );
}
