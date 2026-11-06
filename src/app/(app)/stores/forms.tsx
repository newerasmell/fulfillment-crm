"use client";

import { startTransition, useActionState } from "react";
import { useTranslations } from "next-intl";
import {
  backfillOrdersAction,
  createStoreAction,
  replaceStoreCredentialsAction,
  saveStoreSettingsAction,
} from "@/app/actions/stores";
import { buttonCls, inputCls, labelCls } from "@/components/ui/form";

function Feedback({ state }: { state: { ok?: boolean; error?: string } | undefined }) {
  const t = useTranslations("stores");
  if (state?.error)
    return (
      <span role="status" className="text-block">
        {t(`errors.${state.error}`)}
      </span>
    );
  if (state?.ok)
    return (
      <span role="status" className="text-ok">
        {t("saved")}
      </span>
    );
  return null;
}

export function NewStoreForm({
  companies,
  credentials,
}: {
  companies: { id: string; name: string }[];
  credentials: { id: string; label: string; hint: string }[];
}) {
  const t = useTranslations("stores");
  const [state, action, pending] = useActionState(createStoreAction, undefined);
  return (
    <form
      // Submitted by hand: a plain form action resets every field, so a wrong value cost the whole form (owner
      // report 2026-11-06). The fields keep what was typed; the error names the field.
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => action(data));
      }}
      className="grid gap-3 sm:grid-cols-2"
      aria-label={t("add")}
    >
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
      <label className={labelCls}>
        {t("domain")}
        <input
          name="domain"
          required
          placeholder="example.myshopify.com"
          className={`${inputCls} font-mono`}
        />
      </label>
      <label className={labelCls}>
        {t("code")}
        <input
          name="code"
          required
          pattern="[A-Za-z0-9]{2,5}"
          maxLength={5}
          className={`${inputCls} font-mono uppercase`}
        />
        <span className="text-xs font-normal text-muted">{t("codeHint")}</span>
      </label>
      <label className={labelCls}>
        {t("currency")}
        <input
          name="currency"
          required
          pattern="[A-Za-z]{3}"
          maxLength={3}
          placeholder="EUR"
          className={`${inputCls} uppercase`}
        />
      </label>
      <label className={labelCls}>
        {t("countries")}
        <input name="countries" placeholder="BG, RO" className={`${inputCls} uppercase`} />
      </label>
      {credentials.length > 0 && (
        <label className={`${labelCls} sm:col-span-2`}>
          {t("existingApp")}
          <select name="credentialId" className={inputCls} defaultValue="">
            <option value="">{t("newApp")}</option>
            {credentials.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} · {c.hint}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className={labelCls}>
        {t("clientId")}
        <input name="clientId" autoComplete="off" className={`${inputCls} font-mono`} />
      </label>
      <label className={labelCls}>
        {t("clientSecret")}
        <input name="clientSecret" type="password" autoComplete="off" className={`${inputCls} font-mono`} />
        <span className="text-xs font-normal text-muted">{t("secretHint")}</span>
      </label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonCls}>
          {t("add")}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export interface StoreSettingsView {
  codGateways: string[];
  skuPrefix: string | null;
  notifyCustomer: boolean;
  fulfilTrigger: string;
  writeBackMode: string;
  inventoryPushMode: string;
  weightWriteMode: string;
  inventoryBuffer: number;
}

export function StoreSettingsForm({
  storeId,
  s,
  canRaise,
}: {
  storeId: string;
  s: StoreSettingsView;
  canRaise: boolean;
}) {
  const t = useTranslations("stores");
  const [state, action, pending] = useActionState(saveStoreSettingsAction.bind(null, storeId), undefined);
  const writeModes = ["READ_ONLY", "DRY_RUN", "LIVE"];
  const pushModes = ["DISABLED", "DRY_RUN", "LIVE"];
  const allowed = (modes: string[], current: string, m: string) =>
    canRaise || modes.indexOf(m) <= modes.indexOf(current);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2" aria-label={t("settings")}>
      <label className={labelCls}>
        {t("codGateways")}
        <textarea
          name="codGateways"
          rows={3}
          defaultValue={s.codGateways.join("\n")}
          className={`${inputCls} py-2`}
        />
        <span className="text-xs font-normal text-muted">{t("codGatewaysHint")}</span>
      </label>
      <label className={labelCls}>
        {t("skuPrefix")}
        <input name="skuPrefix" defaultValue={s.skuPrefix ?? ""} className={`${inputCls} font-mono`} />
        <span className="text-xs font-normal text-muted">{t("skuPrefixHint")}</span>
      </label>
      <label className={labelCls}>
        {t("writeBackMode")}
        <select name="writeBackMode" defaultValue={s.writeBackMode} className={inputCls}>
          {writeModes.map((m) => (
            <option key={m} value={m} disabled={!allowed(writeModes, s.writeBackMode, m)}>
              {t(`writeModes.${m}`)}
            </option>
          ))}
        </select>
      </label>
      <label className={labelCls}>
        {t("fulfilTrigger")}
        <select name="fulfilTrigger" defaultValue={s.fulfilTrigger} className={inputCls}>
          {["ON_TRACKING", "ON_ACCEPT"].map((m) => (
            <option
              key={m}
              value={m}
              disabled={!canRaise && m === "ON_ACCEPT" && s.fulfilTrigger !== "ON_ACCEPT"}
            >
              {t(`fulfilTriggers.${m}`)}
            </option>
          ))}
        </select>
        <span className="text-xs font-normal text-muted">{t("fulfilTriggerHint")}</span>
      </label>
      <label className={labelCls}>
        {t("inventoryPushMode")}
        <select name="inventoryPushMode" defaultValue={s.inventoryPushMode} className={inputCls}>
          {pushModes.map((m) => (
            <option key={m} value={m} disabled={!allowed(pushModes, s.inventoryPushMode, m)}>
              {t(`pushModes.${m}`)}
            </option>
          ))}
        </select>
      </label>
      <label className={labelCls}>
        {t("weightWriteMode")}
        <select name="weightWriteMode" defaultValue={s.weightWriteMode} className={inputCls}>
          {pushModes.map((m) => (
            <option key={m} value={m} disabled={!allowed(pushModes, s.weightWriteMode, m)}>
              {t(`weightModes.${m}`)}
            </option>
          ))}
        </select>
        <span className="text-xs font-normal text-muted">{t("weightWriteModeHint")}</span>
      </label>
      <label className={labelCls}>
        {t("inventoryBuffer")}
        <input
          name="inventoryBuffer"
          type="number"
          min={0}
          max={10000}
          defaultValue={s.inventoryBuffer}
          className={inputCls}
        />
      </label>
      <label className="flex min-h-11 items-center gap-2 self-end text-[13px] font-medium">
        <input name="notifyCustomer" type="checkbox" defaultChecked={s.notifyCustomer} className="size-4" />
        {t("notifyCustomer")}
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

export function ReplaceCredentialsForm({ storeId }: { storeId: string }) {
  const t = useTranslations("stores");
  const [state, action, pending] = useActionState(
    replaceStoreCredentialsAction.bind(null, storeId),
    undefined,
  );
  return (
    <form action={action} className="flex flex-wrap items-end gap-3" aria-label={t("replaceCredentials")}>
      <label className={labelCls}>
        {t("clientId")}
        <input name="clientId" required autoComplete="off" className={`${inputCls} w-64 font-mono`} />
      </label>
      <label className={labelCls}>
        {t("clientSecret")}
        <input
          name="clientSecret"
          type="password"
          required
          autoComplete="off"
          className={`${inputCls} w-64 font-mono`}
        />
      </label>
      <button type="submit" disabled={pending} className={buttonCls}>
        {t("replaceCredentials")}
      </button>
      <Feedback state={state} />
    </form>
  );
}

export function BackfillForm({ storeId }: { storeId: string }) {
  const t = useTranslations("stores");
  const [state, action, pending] = useActionState(backfillOrdersAction.bind(null, storeId), undefined);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3" aria-label={t("backfill")}>
      <label className={labelCls}>
        {t("backfillDays")}
        <input
          name="days"
          type="number"
          min={1}
          max={365}
          defaultValue={30}
          required
          className={`${inputCls} w-28`}
        />
      </label>
      <button type="submit" disabled={pending} className={buttonCls}>
        {t("backfill")}
      </button>
      {state?.ok ? (
        <span role="status" className="text-ok">
          {t("queued")}
        </span>
      ) : (
        <Feedback state={state} />
      )}
    </form>
  );
}
