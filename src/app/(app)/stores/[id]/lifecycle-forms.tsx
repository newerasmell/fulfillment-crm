"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  archiveStoreAction,
  deleteStoreAction,
  restoreStoreAction,
  saveStoreDetailsAction,
} from "@/app/actions/stores";
import { buttonCls, ghostButtonCls, inputCls, labelCls } from "@/components/ui/form";

type State = { ok?: boolean; error?: string; pending?: boolean } | undefined;

function Feedback({ state, okText }: { state: State; okText?: string }) {
  const t = useTranslations("stores");
  if (state?.error)
    return (
      <span role="status" className="text-block">
        {t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : state.error}
      </span>
    );
  if (state?.ok)
    return (
      <span role="status" className="text-ok">
        {okText ?? t("saved")}
      </span>
    );
  return null;
}

export interface StoreDetailsView {
  name: string;
  companyId: string | null;
  currency: string;
  countries: string[];
  domain: string;
  code: string;
  vendorIdPrefix: string | null;
  /** Example order number for the preview (the store's latest order), if any. */
  sampleNumber?: string | null;
}

/** "Данни на магазина". Locked fields are read-only with the reason next to them; the server enforces it too. */
export function StoreDetailsForm({
  storeId,
  s,
  companies,
  locks,
}: {
  storeId: string;
  s: StoreDetailsView;
  companies: { id: string; name: string }[];
  locks: { code: boolean; domain: boolean };
}) {
  const t = useTranslations("stores");
  const [state, action, pending] = useActionState(saveStoreDetailsAction.bind(null, storeId), undefined);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2" aria-label={t("details")}>
      <label className={labelCls}>
        {t("name")}
        <input name="name" required maxLength={200} defaultValue={s.name} className={inputCls} />
      </label>
      <label className={labelCls}>
        {t("company")}
        <select name="companyId" required defaultValue={s.companyId ?? ""} className={inputCls}>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="text-xs font-normal text-muted">{t("companyMoveHint")}</span>
      </label>
      <label className={labelCls}>
        {t("currency")}
        <input
          name="currency"
          required
          pattern="[A-Za-z]{3}"
          maxLength={3}
          defaultValue={s.currency}
          className={`${inputCls} uppercase`}
        />
      </label>
      <label className={labelCls}>
        {t("countries")}
        <input name="countries" defaultValue={s.countries.join(", ")} className={`${inputCls} uppercase`} />
      </label>
      <label className={labelCls}>
        {t("domain")}
        <input
          name="domain"
          required
          defaultValue={s.domain}
          readOnly={locks.domain}
          aria-describedby="domain-hint"
          className={`${inputCls} font-mono ${locks.domain ? "bg-hover text-muted" : ""}`}
        />
        <span id="domain-hint" className={`text-xs font-normal ${locks.domain ? "text-warn" : "text-muted"}`}>
          {locks.domain ? t("domainLocked") : t("domainHint")}
        </span>
      </label>
      <label className={labelCls}>
        {t("code")}
        <input
          name="code"
          required
          pattern="[A-Za-z0-9]{2,5}"
          maxLength={5}
          defaultValue={s.code}
          readOnly={locks.code}
          aria-describedby="code-hint"
          className={`${inputCls} font-mono uppercase ${locks.code ? "bg-hover text-muted" : ""}`}
        />
        <span id="code-hint" className={`text-xs font-normal ${locks.code ? "text-warn" : "text-muted"}`}>
          {locks.code ? t("codeLocked") : t("codeHint")}
        </span>
      </label>
      <label className={labelCls}>
        {t("vendorIdPrefix")}
        <input
          name="vendorIdPrefix"
          pattern="[A-Za-z0-9]{0,10}"
          maxLength={10}
          defaultValue={s.vendorIdPrefix ?? ""}
          placeholder={t("vendorIdPrefixNone")}
          aria-describedby="prefix-hint"
          className={`${inputCls} font-mono uppercase`}
        />
        <span id="prefix-hint" className="text-xs font-normal text-muted">
          {t("vendorIdPrefixHint", {
            example: `${s.vendorIdPrefix ? `${s.vendorIdPrefix}-` : ""}${(s.sampleNumber ?? "#1001").replace(/^#/, "")}`,
          })}
        </span>
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

/** Archive needs a second click after the not-yet-sent orders count was shown. */
export function ArchiveStoreForm({ storeId, notSent }: { storeId: string; notSent: number }) {
  const t = useTranslations("stores");
  const [asking, setAsking] = useState(false);
  const [state, action, pending] = useActionState(archiveStoreAction.bind(null, storeId), undefined);
  if (!asking)
    return (
      <button type="button" onClick={() => setAsking(true)} className={ghostButtonCls}>
        {t("archive")}
      </button>
    );
  return (
    <form action={action} className="flex flex-col gap-2" aria-label={t("archive")}>
      <p role="alert" className={`m-0 text-sm ${notSent > 0 ? "text-warn" : "text-muted"}`}>
        {t("archiveNotSent", { count: notSent })}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 rounded-[10px] bg-block px-4 font-semibold text-white"
        >
          {t("archiveConfirm")}
        </button>
        <button type="button" onClick={() => setAsking(false)} className={ghostButtonCls}>
          {t("cancel")}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function RestoreStoreForm({ storeId }: { storeId: string }) {
  const t = useTranslations("stores");
  const [state, action, pending] = useActionState(restoreStoreAction.bind(null, storeId), undefined);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3" aria-label={t("restore")}>
      <button type="submit" disabled={pending} className={buttonCls}>
        {t("restore")}
      </button>
      <Feedback state={state} />
    </form>
  );
}

/** Typed confirmation (the store code). When the webhook removal runs first, the page refreshes until it is gone. */
export function DeleteStoreForm({
  storeId,
  code,
  canForce,
}: {
  storeId: string;
  code: string;
  canForce: boolean;
}) {
  const t = useTranslations("stores");
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [state, action, pending] = useActionState(deleteStoreAction.bind(null, storeId), undefined);
  useEffect(() => {
    if (!state?.pending) return;
    const timers = [4_000, 12_000, 30_000, 60_000].map((ms) => setTimeout(() => router.refresh(), ms));
    return () => timers.forEach(clearTimeout);
  }, [state, router]);
  return (
    <form action={action} className="flex flex-col gap-3" aria-label={t("delete")}>
      <label className={labelCls}>
        {t("deleteConfirmLabel", { code })}
        <input
          name="confirmCode"
          autoComplete="off"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className={`${inputCls} w-40 font-mono uppercase`}
        />
      </label>
      {canForce && (
        <label className="flex items-center gap-2 text-[13px]">
          <input name="force" type="checkbox" className="size-4" />
          {t("deleteForce")}
        </label>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending || typed.trim().toUpperCase() !== code}
          className="min-h-11 rounded-[10px] bg-block px-4 font-semibold text-white disabled:opacity-50"
        >
          {t("delete")}
        </button>
        <Feedback state={state} okText={state?.pending ? t("deletePending") : t("deleted")} />
      </div>
    </form>
  );
}
