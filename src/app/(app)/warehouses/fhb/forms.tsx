"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import {
  createFhbConnectionAction,
  linkFhbVendorProductAction,
  loadFhbPickupPointsAction,
  rotateFhbCredentialsAction,
  saveFhbSettingsAction,
  setFhbModeAction,
  syncFhbAction,
} from "@/app/actions/fhb";
import { buttonCls, ghostButtonCls, inputCls, labelCls } from "@/components/ui/form";

type State = { ok?: boolean; error?: string } | undefined;

function Feedback({ state, okKey = "saved" }: { state: State; okKey?: string }) {
  const t = useTranslations("fhb");
  if (state?.error)
    return (
      <span role="status" className="text-sm text-block">
        {t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : t("errors.generic")}
      </span>
    );
  if (state?.ok)
    return (
      <span role="status" className="text-sm text-ok">
        {t(okKey)}
      </span>
    );
  return null;
}

export function NewFhbConnectionForm({ companies }: { companies: { id: string; name: string }[] }) {
  const t = useTranslations("fhb");
  const [state, action, pending] = useActionState(createFhbConnectionAction, undefined);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2" aria-label={t("conn.add")}>
      <label className={labelCls}>
        {t("conn.company")}
        <select name="companyId" required className={inputCls}>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className={labelCls}>
        {t("conn.name")}
        <input name="name" required minLength={2} maxLength={100} className={inputCls} />
      </label>
      <label className={labelCls}>
        {t("conn.appId")}
        <input name="appId" required autoComplete="off" className={`${inputCls} font-mono`} />
      </label>
      <label className={labelCls}>
        {t("conn.secret")}
        <input
          name="secret"
          type="password"
          required
          autoComplete="off"
          className={`${inputCls} font-mono`}
        />
        <span className="text-xs font-normal text-muted">{t("conn.secretHint")}</span>
      </label>
      <label className={labelCls}>
        {t("conn.skuPrefix")}
        <input name="skuPrefix" maxLength={20} pattern="[^#&%\s]*" className={`${inputCls} font-mono`} />
        <span className="text-xs font-normal text-muted">{t("conn.skuPrefixHint")}</span>
      </label>
      <p className="m-0 self-end text-sm text-muted">{t("conn.startsReadOnly")}</p>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonCls}>
          {t("conn.add")}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function FhbSettingsForm({
  connectionId,
  name,
  skuPrefix,
  enabled,
}: {
  connectionId: string;
  name: string;
  skuPrefix: string;
  enabled: boolean;
}) {
  const t = useTranslations("fhb");
  const [state, action, pending] = useActionState(saveFhbSettingsAction.bind(null, connectionId), undefined);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2" aria-label={t("conn.settings")}>
      <label className={labelCls}>
        {t("conn.name")}
        <input name="name" required defaultValue={name} className={inputCls} />
      </label>
      <label className={labelCls}>
        {t("conn.skuPrefix")}
        <input
          name="skuPrefix"
          defaultValue={skuPrefix}
          maxLength={20}
          pattern="[^#&%\s]*"
          className={`${inputCls} font-mono`}
        />
        <span className="text-xs font-normal text-muted">{t("conn.skuPrefixHint")}</span>
      </label>
      <label className="flex min-h-11 items-center gap-2 text-[13px] font-medium">
        <input name="enabled" type="checkbox" defaultChecked={enabled} className="size-4" />
        {t("conn.enabled")}
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

export function RotateFhbCredentialsForm({ connectionId }: { connectionId: string }) {
  const t = useTranslations("fhb");
  const [state, action, pending] = useActionState(
    rotateFhbCredentialsAction.bind(null, connectionId),
    undefined,
  );
  return (
    <form action={action} className="flex flex-wrap items-end gap-3" aria-label={t("conn.rotate")}>
      <label className={labelCls}>
        {t("conn.appId")}
        <input name="appId" required autoComplete="off" className={`${inputCls} w-56 font-mono`} />
      </label>
      <label className={labelCls}>
        {t("conn.secret")}
        <input
          name="secret"
          type="password"
          required
          autoComplete="off"
          className={`${inputCls} w-56 font-mono`}
        />
      </label>
      <button type="submit" disabled={pending} className={buttonCls}>
        {t("conn.rotate")}
      </button>
      <Feedback state={state} />
    </form>
  );
}

const MODES = ["READ_ONLY", "DRY_RUN", "CANARY", "LIVE"] as const;

/** Mode stepper: everyone with connections.manage may lower; only an OWNER may raise (the server decides). */
export function FhbModeForm({
  connectionId,
  current,
  canRaise,
}: {
  connectionId: string;
  current: (typeof MODES)[number];
  canRaise: boolean;
}) {
  const t = useTranslations("fhb");
  const tm = useTranslations("mode");
  const [state, action, pending] = useActionState(setFhbModeAction.bind(null, connectionId), undefined);
  const idx = MODES.indexOf(current);
  return (
    <form action={action} aria-label={t("conn.mode")} className="flex flex-col gap-2">
      <ol className="m-0 flex list-none flex-wrap gap-1 p-0" aria-label={t("conn.modeSteps")}>
        {MODES.map((m, i) => (
          <li
            key={m}
            aria-current={m === current ? "step" : undefined}
            className={`rounded-full border px-3 py-1 text-[13px] ${
              m === current
                ? "border-accent bg-accent-soft font-semibold text-accent-strong"
                : i < idx
                  ? "border-line text-muted"
                  : "border-line-soft text-label"
            }`}
          >
            {i + 1}. {tm(m)}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-end gap-2">
        <label className={labelCls}>
          {t("conn.newMode")}
          <select name="mode" defaultValue={current} className={inputCls}>
            {MODES.map((m, i) => (
              <option key={m} value={m} disabled={!canRaise && i > idx}>
                {tm(m)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={pending} className={ghostButtonCls}>
          {t("conn.changeMode")}
        </button>
        <Feedback state={state} />
      </div>
      {!canRaise && <p className="m-0 text-xs text-muted">{t("conn.onlyOwnerRaises")}</p>}
    </form>
  );
}

export function SyncButton({
  connectionId,
  resource,
  label,
}: {
  connectionId: string;
  resource: string;
  label: string;
}) {
  const [state, action, pending] = useActionState(syncFhbAction.bind(null, connectionId), undefined);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="resource" value={resource} />
      <button type="submit" disabled={pending} className={ghostButtonCls}>
        {label}
      </button>
      <Feedback state={state} okKey="queued" />
    </form>
  );
}

export function LoadPickupPointsForm({
  connectionId,
  carriers,
}: {
  connectionId: string;
  carriers: { code: string; name: string | null }[];
}) {
  const t = useTranslations("fhb");
  const [state, action, pending] = useActionState(
    loadFhbPickupPointsAction.bind(null, connectionId),
    undefined,
  );
  return (
    <form action={action} className="flex flex-wrap items-end gap-3" aria-label={t("carriers.load")}>
      <label className={labelCls}>
        {t("carriers.service")}
        <select name="service" required className={inputCls}>
          {carriers.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name ? `${c.name} (${c.code})` : c.code}
            </option>
          ))}
        </select>
      </label>
      <label className={labelCls}>
        {t("carriers.country")}
        <input name="country" maxLength={2} pattern="[A-Za-z]{2}" className={`${inputCls} w-24 uppercase`} />
      </label>
      <button type="submit" disabled={pending || carriers.length === 0} className={ghostButtonCls}>
        {t("carriers.load")}
      </button>
      <Feedback state={state} okKey="queued" />
      <p className="m-0 w-full text-xs text-muted">{t("carriers.countryHint")}</p>
    </form>
  );
}

export function LinkVendorProductForm({ vendorProductId }: { vendorProductId: string }) {
  const t = useTranslations("fhb");
  const [state, action, pending] = useActionState(
    linkFhbVendorProductAction.bind(null, vendorProductId),
    undefined,
  );
  return (
    <form action={action} className="flex flex-wrap items-center gap-2" aria-label={t("stock.link")}>
      <input
        name="sku"
        required
        placeholder={t("stock.masterSku")}
        aria-label={t("stock.masterSku")}
        className={`${inputCls} min-h-10 w-40 font-mono`}
      />
      <button type="submit" disabled={pending} className={ghostButtonCls}>
        {t("stock.link")}
      </button>
      <Feedback state={state} okKey="linked" />
    </form>
  );
}
