"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState, useTransition } from "react";
import {
  loadReturnPhotosAction,
  notifySupportAction,
  processReturnAction,
  reopenReturnAction,
  saveReturnsCodSettingsAction,
  type ReturnActionResult,
} from "@/app/actions/returns";
import { buttonCls, ghostButtonCls, inputCls, labelCls } from "@/components/ui/form";

/** Row actions on the returns board: processed with a (required) note, reopen, notify support, load photos. */
export function ReturnActions(props: {
  caseId: string;
  reference: string;
  processed: boolean;
  received: boolean;
  notifyRequested: boolean;
  canLoadPhotos: boolean;
  photosPending: boolean;
}) {
  const t = useTranslations("returns");
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const run = (fn: () => Promise<ReturnActionResult>, done?: string) =>
    start(async () => {
      setError(null);
      setInfo(null);
      const r = await fn();
      if (r.error) setError(t.has(`error.${r.error}`) ? t(`error.${r.error}`) : r.error);
      else {
        setOpen(false);
        if (done) setInfo(done);
      }
    });
  return (
    <div className="mt-1 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {props.processed ? (
          <button
            type="button"
            disabled={pending}
            className={ghostButtonCls}
            onClick={() => run(() => reopenReturnAction(props.caseId))}
          >
            {t("reopen")}
          </button>
        ) : (
          !open && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="min-h-10 rounded-[10px] bg-accent px-3 font-semibold text-white hover:bg-accent-strong"
            >
              {t("process")}
            </button>
          )
        )}
        {props.received && !props.processed && (
          <button
            type="button"
            disabled={pending || props.notifyRequested}
            className={ghostButtonCls}
            onClick={() => run(() => notifySupportAction(props.caseId), t("notifyQueued"))}
          >
            {props.notifyRequested ? t("notifyQueued") : t("notify")}
          </button>
        )}
        {props.canLoadPhotos && (
          <button
            type="button"
            disabled={pending || props.photosPending}
            className={ghostButtonCls}
            onClick={() => run(() => loadReturnPhotosAction(props.caseId), t("photosQueued"))}
          >
            {props.photosPending ? t("photosQueued") : t("loadPhotos")}
          </button>
        )}
      </div>
      {open && (
        <form
          className="flex flex-wrap items-center gap-2"
          aria-label={t("processForm", { reference: props.reference })}
          onSubmit={(e) => {
            e.preventDefault();
            run(() => processReturnAction(props.caseId, note));
          }}
        >
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label={t("note")}
            placeholder={t("notePlaceholder")}
            className="min-h-10 min-w-56 flex-1 rounded-[10px] border border-line bg-surface px-3 outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={pending}
            className="min-h-10 rounded-[10px] bg-ok px-3 font-semibold text-white disabled:opacity-60"
          >
            {t("confirmProcess")}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="min-h-10 px-2 text-muted">
            {t("cancel")}
          </button>
        </form>
      )}
      {error && (
        <span role="alert" className="text-sm text-block">
          {error}
        </span>
      )}
      {info && (
        <span role="status" className="text-sm text-muted">
          {info}
        </span>
      )}
    </div>
  );
}

export function ReturnsSettingsForm({
  settings,
}: {
  settings: { returnOverdueDays: number; codMissingDays: number; notifySupport: boolean };
}) {
  const t = useTranslations("returns");
  const [state, action, pending] = useActionState(saveReturnsCodSettingsAction, {} as ReturnActionResult);
  return (
    <form action={action} aria-label={t("settings.form")} className="flex flex-wrap items-end gap-4">
      <label className={labelCls}>
        {t("settings.overdueDays")}
        <input
          name="returnOverdueDays"
          type="number"
          min={1}
          max={120}
          defaultValue={settings.returnOverdueDays}
          className={`${inputCls} w-32`}
        />
      </label>
      <label className={labelCls}>
        {t("settings.codMissingDays")}
        <input
          name="codMissingDays"
          type="number"
          min={1}
          max={180}
          defaultValue={settings.codMissingDays}
          className={`${inputCls} w-32`}
        />
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          name="notifySupport"
          type="checkbox"
          defaultChecked={settings.notifySupport}
          className="size-5"
        />
        {t("settings.notifySupport")}
      </label>
      <button type="submit" disabled={pending} className={buttonCls}>
        {t("settings.save")}
      </button>
      {state.ok && (
        <span role="status" className="text-sm text-ok">
          {t("settings.saved")}
        </span>
      )}
      {state.error && (
        <span role="alert" className="text-sm text-block">
          {t.has(`error.${state.error}`) ? t(`error.${state.error}`) : state.error}
        </span>
      )}
    </form>
  );
}
