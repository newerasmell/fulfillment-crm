"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import {
  createEuConnectionAction,
  linkEuProductAction,
  replaceEuTokenAction,
  saveCountryCourierAction,
  saveEuSettingsAction,
  setEuModeAction,
  syncEuCitiesAction,
} from "@/app/actions/eushipments";
import { buttonCls, ghostButtonCls, inputCls, labelCls } from "@/components/ui/form";

type State = { ok?: boolean; error?: string } | undefined;

function Feedback({ state, okKey = "saved" }: { state: State; okKey?: string }) {
  const t = useTranslations("eushipments");
  if (state?.error)
    return (
      <span role="status" className="text-block">
        {t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : t("errors.invalid")}
      </span>
    );
  if (state?.ok)
    return (
      <span role="status" className="text-ok">
        {t(okKey)}
      </span>
    );
  return null;
}

export function NewEuConnectionForm({
  companies,
  credentials,
}: {
  companies: { id: string; name: string }[];
  credentials: { id: string; label: string; hint: string }[];
}) {
  const t = useTranslations("eushipments");
  const [state, action, pending] = useActionState(createEuConnectionAction, undefined);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2" aria-label={t("add")}>
      <label className={labelCls}>
        {t("company")}
        <select name="companyId" required className={inputCls}>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className={labelCls}>
        {t("name")}
        <input name="name" required maxLength={200} className={inputCls} />
      </label>
      {credentials.length > 0 && (
        <label className={`${labelCls} sm:col-span-2`}>
          {t("existingToken")}
          <select name="credentialId" className={inputCls} defaultValue="">
            <option value="">{t("newToken")}</option>
            {credentials.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} · {c.hint}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className={labelCls}>
        {t("token")}
        <input name="token" type="password" autoComplete="off" className={`${inputCls} font-mono`} />
        <span className="text-xs font-normal text-muted">{t("tokenHint")}</span>
      </label>
      <label className={labelCls}>
        {t("vendorCompanyId")}
        <input
          name="vendorCompanyId"
          inputMode="numeric"
          pattern="[0-9]*"
          className={`${inputCls} font-mono`}
        />
        <span className="text-xs font-normal text-muted">{t("vendorCompanyIdHint")}</span>
      </label>
      <label className={labelCls}>
        {t("skuPrefix")}
        <input name="skuPrefix" maxLength={20} className={`${inputCls} font-mono`} />
        <span className="text-xs font-normal text-muted">{t("skuPrefixHint")}</span>
      </label>
      <p className="m-0 self-end text-sm text-muted">{t("startsReadOnly")}</p>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonCls}>
          {t("add")}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export interface EuSettingsView {
  name: string;
  companyId: string | null;
  vendorCompanyId: number | null;
  skuPrefix: string;
  acceptedAlertHours: number;
  acceptedAlertWorkDays: boolean;
  stockStaleHours: number;
  cashReceiptCod: boolean;
  canaryDailyCap: number;
  enabled: boolean;
}

export function EuSettingsForm({
  id,
  s,
  companies,
  vendorCompanies,
}: {
  id: string;
  s: EuSettingsView;
  companies: { id: string; name: string }[];
  vendorCompanies: { vendorCompanyId: number; name: string }[];
}) {
  const t = useTranslations("eushipments");
  const [state, action, pending] = useActionState(saveEuSettingsAction.bind(null, id), undefined);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2" aria-label={t("settings")}>
      <label className={labelCls}>
        {t("name")}
        <input name="name" required defaultValue={s.name} className={inputCls} />
      </label>
      <label className={labelCls}>
        {t("company")}
        <select name="companyId" defaultValue={s.companyId ?? ""} className={inputCls}>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className={labelCls}>
        {t("vendorCompany")}
        {vendorCompanies.length > 0 ? (
          <select name="vendorCompanyId" defaultValue={s.vendorCompanyId ?? ""} className={inputCls}>
            <option value="">—</option>
            {vendorCompanies.map((c) => (
              <option key={c.vendorCompanyId} value={c.vendorCompanyId}>
                {c.name} · {c.vendorCompanyId}
              </option>
            ))}
          </select>
        ) : (
          <input
            name="vendorCompanyId"
            inputMode="numeric"
            pattern="[0-9]*"
            defaultValue={s.vendorCompanyId ?? ""}
            className={`${inputCls} font-mono`}
          />
        )}
        <span className="text-xs font-normal text-muted">{t("vendorCompanyHint")}</span>
      </label>
      <label className={labelCls}>
        {t("skuPrefix")}
        <input
          name="skuPrefix"
          defaultValue={s.skuPrefix}
          maxLength={20}
          className={`${inputCls} font-mono`}
        />
        <span className="text-xs font-normal text-muted">{t("skuPrefixHint")}</span>
      </label>
      <label className={labelCls}>
        {t("acceptedAlertHours")}
        <input
          name="acceptedAlertHours"
          type="number"
          min={1}
          max={336}
          defaultValue={s.acceptedAlertHours}
          className={inputCls}
        />
      </label>
      <label className={labelCls}>
        {t("stockStaleHours")}
        <input
          name="stockStaleHours"
          type="number"
          min={1}
          max={336}
          defaultValue={s.stockStaleHours}
          className={inputCls}
        />
      </label>
      <label className={labelCls}>
        {t("canaryDailyCap")}
        <input
          name="canaryDailyCap"
          type="number"
          min={1}
          max={500}
          defaultValue={s.canaryDailyCap}
          className={inputCls}
        />
        <span className="text-xs font-normal text-muted">{t("canaryDailyCapHint")}</span>
      </label>
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" name="acceptedAlertWorkDays" defaultChecked={s.acceptedAlertWorkDays} />
        {t("acceptedAlertWorkDays")}
      </label>
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" name="cashReceiptCod" defaultChecked={s.cashReceiptCod} />
        {t("cashReceiptCod")}
      </label>
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" name="enabled" defaultChecked={s.enabled} />
        {t("enabled")}
      </label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonCls}>
          {t("save")}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function EuTokenForm({ id }: { id: string }) {
  const t = useTranslations("eushipments");
  const [state, action, pending] = useActionState(replaceEuTokenAction.bind(null, id), undefined);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3" aria-label={t("replaceToken")}>
      <label className={labelCls}>
        {t("newTokenLabel")}
        <input name="token" type="password" required autoComplete="off" className={`${inputCls} font-mono`} />
      </label>
      <button type="submit" disabled={pending} className={ghostButtonCls}>
        {t("replaceToken")}
      </button>
      <Feedback state={state} />
    </form>
  );
}

const MODES = ["READ_ONLY", "DRY_RUN", "CANARY", "LIVE"] as const;

/** Mode stepper (DESIGN.md: safety visible). The server decides; the UI only hides what would be refused. */
export function EuModeStepper({
  id,
  current,
  canRaise,
  canLower,
}: {
  id: string;
  current: (typeof MODES)[number];
  canRaise: boolean;
  canLower: boolean;
}) {
  const t = useTranslations();
  const idx = MODES.indexOf(current);
  return (
    <ol className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label={t("eushipments.mode")}>
      {MODES.map((m, i) => (
        <li key={m}>
          {m === current ? (
            <span
              aria-current="step"
              className="inline-flex min-h-11 items-center rounded-full bg-accent px-4 font-semibold text-white"
            >
              {t(`mode.${m}`)}
            </span>
          ) : (
            <ModeButton id={id} mode={m} label={t(`mode.${m}`)} disabled={i > idx ? !canRaise : !canLower} />
          )}
        </li>
      ))}
    </ol>
  );
}

function ModeButton({
  id,
  mode,
  label,
  disabled,
}: {
  id: string;
  mode: string;
  label: string;
  disabled: boolean;
}) {
  const t = useTranslations("eushipments");
  const [state, action, pending] = useActionState(
    setEuModeAction.bind(null, id, mode as "READ_ONLY"),
    undefined,
  );
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <button type="submit" disabled={disabled || pending} className={`${ghostButtonCls} rounded-full`}>
        {label}
      </button>
      {state?.error && (
        <span role="status" className="text-sm text-block">
          {t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : t("errors.invalid")}
        </span>
      )}
    </form>
  );
}

export function EuCitiesForm({
  id,
  countries,
}: {
  id: string;
  countries: { countryId: number; name: string }[];
}) {
  const t = useTranslations("eushipments");
  const [state, action, pending] = useActionState(syncEuCitiesAction.bind(null, id), undefined);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3" aria-label={t("syncCities")}>
      <label className={labelCls}>
        {t("country")}
        <select name="countryId" className={inputCls}>
          {countries.map((c) => (
            <option key={c.countryId} value={c.countryId}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={pending} className={ghostButtonCls}>
        {t("syncCities")}
      </button>
      <Feedback state={state} okKey="queued" />
    </form>
  );
}

export function LinkEuProduct({
  connectionId,
  vendorProductId,
  refNumber,
  suggestion,
}: {
  connectionId: string;
  vendorProductId: string;
  refNumber: string;
  suggestion: string;
}) {
  const t = useTranslations("eushipments");
  const [state, action, pending] = useActionState(
    linkEuProductAction.bind(null, connectionId, vendorProductId),
    undefined,
  );
  return (
    <form
      action={action}
      className="flex flex-wrap items-center gap-2"
      aria-label={`${t("link")} ${refNumber}`}
    >
      <input
        name="sku"
        defaultValue={suggestion}
        aria-label={`${t("masterSku")} ${refNumber}`}
        className={`${inputCls} min-h-10 w-40 font-mono text-[13px]`}
      />
      <button type="submit" disabled={pending} className={ghostButtonCls}>
        {t("link")}
      </button>
      <Feedback state={state} okKey="linked" />
    </form>
  );
}

/** One destination country: its default courier (and optional service) for create-order. */
export function CountryCourierForm({
  id,
  country,
  couriers,
  courierId,
  serviceName,
  services,
  disabled,
}: {
  id: string;
  country: string;
  couriers: { courierId: number; name: string; toAddress: boolean; toOffice: boolean }[];
  courierId: number | null;
  serviceName: string | null;
  services: readonly string[];
  disabled: boolean;
}) {
  const t = useTranslations("eushipments.countryCourier");
  const [state, action, pending] = useActionState(saveCountryCourierAction.bind(null, id), undefined);
  return (
    <form
      action={action}
      className="flex flex-wrap items-center gap-2"
      data-testid={`country-courier-${country}`}
    >
      <input type="hidden" name="country" value={country} />
      <select
        name="courierId"
        defaultValue={courierId ?? ""}
        disabled={disabled}
        className={`${inputCls} min-w-56`}
        aria-label={t("courier", { country })}
      >
        <option value="">{t("none")}</option>
        {couriers.map((c) => (
          <option key={c.courierId} value={c.courierId}>
            {c.name} · {c.courierId}
            {c.toAddress ? "" : ` · ${t("officeOnly")}`}
          </option>
        ))}
      </select>
      <select
        name="serviceName"
        defaultValue={serviceName ?? ""}
        disabled={disabled}
        className={inputCls}
        aria-label={t("service", { country })}
      >
        <option value="">{t("serviceAuto")}</option>
        {services.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {!disabled && (
        <button type="submit" disabled={pending} className={ghostButtonCls}>
          {t("save")}
        </button>
      )}
      <Feedback state={state} />
    </form>
  );
}
