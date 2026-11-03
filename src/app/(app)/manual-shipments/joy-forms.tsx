"use client";

import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import {
  createJoyConnectionAction,
  saveJoySettingsAction,
  setJoyModeAction,
  testJoyAction,
} from "@/app/actions/labels";
import { buttonCls, ghostButtonCls, inputCls, labelCls } from "@/components/ui/form";

type State = { ok?: boolean; error?: string } | undefined;
const MODES = ["READ_ONLY", "DRY_RUN", "CANARY", "LIVE"] as const;

function Feedback({ state }: { state: State }) {
  const t = useTranslations("manual");
  if (state?.error)
    return (
      <span role="status" className="text-sm text-block">
        {t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : t("errors.generic")}
      </span>
    );
  if (state?.ok)
    return (
      <span role="status" className="text-sm text-ok">
        {t("saved")}
      </span>
    );
  return null;
}

function ServiceFields({ parcel = "", pickup = "", sender = "", senderName = "" }) {
  const t = useTranslations("manual.joy");
  return (
    <>
      <label className={labelCls}>
        {t("parcelServices")}
        <input
          name="parcelServices"
          defaultValue={parcel}
          className={`${inputCls} font-mono`}
          placeholder="pplcz, packeta"
        />
        <span className="text-xs font-normal text-muted">{t("parcelServicesHint")}</span>
      </label>
      <label className={labelCls}>
        {t("pickupServices")}
        <input name="pickupServices" defaultValue={pickup} className={`${inputCls} font-mono`} />
        <span className="text-xs font-normal text-muted">{t("pickupServicesHint")}</span>
      </label>
      <label className={labelCls}>
        {t("sender")}
        <input name="sender" defaultValue={sender} maxLength={60} className={`${inputCls} font-mono`} />
      </label>
      <label className={labelCls}>
        {t("senderName")}
        <input name="senderName" defaultValue={senderName} maxLength={100} className={inputCls} />
      </label>
    </>
  );
}

export function NewJoyConnectionForm({ companies }: { companies: { id: string; name: string }[] }) {
  const t = useTranslations("manual.joy");
  const [state, action, pending] = useActionState(createJoyConnectionAction, undefined);
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
        <input name="name" required minLength={2} maxLength={100} className={inputCls} />
      </label>
      <label className={labelCls}>
        {t("appId")}
        <input name="appId" required autoComplete="off" className={`${inputCls} font-mono`} />
      </label>
      <label className={labelCls}>
        {t("secret")}
        <input
          name="secret"
          type="password"
          required
          autoComplete="off"
          className={`${inputCls} font-mono`}
        />
        <span className="text-xs font-normal text-muted">{t("secretHint")}</span>
      </label>
      <ServiceFields />
      <p className="m-0 text-sm text-muted sm:col-span-2">{t("startsReadOnly")}</p>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonCls}>
          {t("add")}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function JoyConnectionCard({
  connection: c,
  canRaise,
}: {
  connection: {
    id: string;
    name: string;
    liveMode: (typeof MODES)[number];
    company: string;
    parcelServices: string[];
    pickupServices: string[];
    sender: string;
    senderName: string;
    lastTest: { ok: boolean; at: string; error?: string | null } | null;
  };
  canRaise: boolean;
}) {
  const t = useTranslations("manual.joy");
  const tm = useTranslations("mode");
  const [state, action, pending] = useActionState(saveJoySettingsAction.bind(null, c.id), undefined);
  const [modeState, modeAction, modePending] = useActionState(setJoyModeAction.bind(null, c.id), undefined);
  const [testing, start] = useTransition();
  const [tested, setTested] = useState<State>(undefined);
  const idx = MODES.indexOf(c.liveMode);
  return (
    <article className="rounded-xl border border-line p-4" aria-label={c.name}>
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-fhb-chip px-2 py-0.5 text-xs text-fhb-text">FHB Joy</span>
        <h3 className="m-0 text-base font-semibold">{c.name}</h3>
        <span className="text-sm text-muted">{c.company}</span>
        <span className="ml-auto text-sm font-semibold">{tm(c.liveMode)}</span>
      </header>
      <p className="mt-0 text-sm text-muted">{t("billable")}</p>
      <form action={modeAction} className="mb-3 flex flex-wrap items-end gap-2" aria-label={t("mode")}>
        <ol className="m-0 flex list-none flex-wrap gap-1 p-0">
          {MODES.map((m, i) => (
            <li
              key={m}
              aria-current={m === c.liveMode ? "step" : undefined}
              className={`rounded-full border px-3 py-1 text-[13px] ${
                m === c.liveMode
                  ? "border-accent bg-accent-soft font-semibold text-accent-strong"
                  : "border-line text-muted"
              }`}
            >
              {i + 1}. {tm(m)}
            </li>
          ))}
        </ol>
        <select name="mode" defaultValue={c.liveMode} aria-label={t("newMode")} className={inputCls}>
          {MODES.map((m, i) => (
            <option key={m} value={m} disabled={!canRaise && i > idx}>
              {tm(m)}
            </option>
          ))}
        </select>
        <button type="submit" disabled={modePending} className={ghostButtonCls}>
          {t("setMode")}
        </button>
        <Feedback state={modeState} />
      </form>
      <form action={action} className="grid gap-3 sm:grid-cols-2" aria-label={t("settings")}>
        <ServiceFields
          parcel={c.parcelServices.join(", ")}
          pickup={c.pickupServices.join(", ")}
          sender={c.sender}
          senderName={c.senderName}
        />
        <label className={labelCls}>
          {t("rotateAppId")}
          <input name="appId" autoComplete="off" className={`${inputCls} font-mono`} />
        </label>
        <label className={labelCls}>
          {t("rotateSecret")}
          <input name="secret" type="password" autoComplete="off" className={`${inputCls} font-mono`} />
        </label>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button type="submit" disabled={pending} className={buttonCls}>
            {t("save")}
          </button>
          <button
            type="button"
            disabled={testing}
            className={ghostButtonCls}
            onClick={() => start(async () => setTested(await testJoyAction(c.id)))}
          >
            {t("test")}
          </button>
          <Feedback state={state} />
          {tested?.ok && <span className="text-sm text-muted">{t("testQueued")}</span>}
          {c.lastTest && (
            <span className={`text-sm ${c.lastTest.ok ? "text-ok" : "text-block"}`}>
              {c.lastTest.ok
                ? t("testOk", { at: c.lastTest.at.slice(0, 16).replace("T", " ") })
                : t("testFailed", { error: c.lastTest.error ?? "" })}
            </span>
          )}
        </div>
      </form>
    </article>
  );
}
