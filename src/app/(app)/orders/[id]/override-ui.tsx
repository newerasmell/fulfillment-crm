"use client";

import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { canaryViewAction, confirmCanaryAction } from "@/app/actions/fulfill";
import {
  chooseWarehouseAction,
  clearWarehouseAction,
  rerouteAction,
  warehouseCancelAction,
} from "@/app/actions/override";
import { buttonCls, ghostButtonCls, inputCls, labelCls } from "@/components/ui/form";
import type { Finding } from "@/server/checks/findings";

/** Client parts of "Изпрати от" and "Пренасочи" on the order detail (P4-09). The server decides everything. */

export interface OptionView {
  id: string;
  name: string;
  type: string;
  companyName: string | null;
  crossCompany: boolean;
  stockStatus: "ok" | "insufficient" | "unknown";
  lines: { title: string; need: number; available: number | null }[];
}
export interface CodeView {
  code: string;
  label: string;
}

const chipCls = (type: string) =>
  type === "EUSHIPMENTS" ? "bg-eu-chip text-eu-text" : "bg-fhb-chip text-fhb-text";
const STOCK_TONE = {
  ok: "bg-ok-bg text-ok",
  insufficient: "bg-block-bg text-block",
  unknown: "bg-warn-bg text-warn",
};

function useErr() {
  const t = useTranslations("override");
  return (code: string) => (t.has(`error.${code}`) ? t(`error.${code}`) : `${t("error.generic")} (${code})`);
}

function Option({
  o,
  name,
  checked,
  onChange,
  tags,
}: {
  o: OptionView;
  name: string;
  checked: boolean;
  onChange: () => void;
  tags?: React.ReactNode;
}) {
  const t = useTranslations("override");
  return (
    <label
      className={`flex cursor-pointer flex-col gap-1 rounded-[10px] border px-3 py-2 ${checked ? "border-accent bg-accent-soft" : "border-line"}`}
      data-testid={`warehouse-option-${o.name}`}
    >
      <span className="flex flex-wrap items-center gap-2">
        <input type="radio" name={name} checked={checked} onChange={onChange} className="h-4 w-4" />
        <span className={`rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${chipCls(o.type)}`}>
          {o.name}
        </span>
        {o.companyName && <span className="text-sm text-muted">{o.companyName}</span>}
        {o.crossCompany && <span className="text-xs font-medium text-warn">{t("crossCompany")}</span>}
        <span className={`ml-auto rounded-full px-2 py-0.5 text-xs ${STOCK_TONE[o.stockStatus]}`}>
          {t(`stock.${o.stockStatus}`)}
        </span>
        {tags}
      </span>
      <span className="flex flex-wrap gap-x-4 pl-6 text-xs text-muted">
        {o.lines.map((l, i) => (
          <span key={i} className="font-mono">
            {t("stock.line", { title: l.title, need: l.need, available: l.available ?? "—" })}
          </span>
        ))}
      </span>
    </label>
  );
}

function ReasonFields({
  codes,
  reason,
  setReason,
  note,
  setNote,
}: {
  codes: CodeView[];
  reason: string;
  setReason: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
}) {
  const t = useTranslations("override");
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className={labelCls}>
        {t("reason")}
        <select value={reason} onChange={(e) => setReason(e.target.value)} required className={inputCls}>
          <option value="">{t("reasonPick")}</option>
          {codes.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className={`${labelCls} min-w-48 flex-1`}>
        {t("note")}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={1000}
          required={reason === "other"}
          className={inputCls}
        />
      </label>
    </div>
  );
}

/** "Изпрати от": the warehouses of the order's product line with stock; choosing one needs a reason. */
export function WarehouseChooser({
  orderId,
  options,
  currentId,
  routedId,
  manual,
  codes,
  canChoose,
}: {
  orderId: string;
  options: OptionView[];
  currentId: string | null;
  routedId: string | null;
  manual: { who: string | null; reason: string; via: string } | null;
  codes: CodeView[];
  canChoose: boolean;
}) {
  const t = useTranslations("override");
  const err = useErr();
  const router = useRouter();
  const [picked, setPicked] = useState<string | null>(currentId);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const changed = !!picked && picked !== currentId;

  const save = () =>
    start(async () => {
      if (!picked) return;
      const r = await chooseWarehouseAction({
        orderId,
        connectionId: picked,
        reasonCode: reason || null,
        reasonText: note || null,
      });
      if (r.error) return setMessage({ tone: "error", text: err(r.error) });
      setMessage({ tone: "ok", text: t("saved", { hard: r.hardCount ?? 0, soft: r.softCount ?? 0 }) });
      setReason("");
      setNote("");
      router.refresh();
    });
  const clear = () =>
    start(async () => {
      const r = await clearWarehouseAction(orderId);
      if (r.error) return setMessage({ tone: "error", text: err(r.error) });
      setMessage({ tone: "ok", text: t("cleared") });
      setPicked(null);
      router.refresh();
    });

  return (
    <section aria-label={t("title")} className="flex flex-col gap-2">
      {manual && (
        <p className="m-0 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn" data-testid="manual-choice">
          {manual.via === "reroute" ? t("boundByReroute") : t("chosenBy", { who: manual.who ?? "—" })} ·{" "}
          {manual.reason}
        </p>
      )}
      {options.length === 0 ? (
        <p className="m-0 text-muted">{t("noOptions")}</p>
      ) : (
        <div className="flex flex-col gap-2" role="radiogroup" aria-label={t("title")}>
          {options.map((o) => (
            <Option
              key={o.id}
              o={o}
              name={`warehouse-${orderId}`}
              checked={picked === o.id}
              onChange={() => canChoose && setPicked(o.id)}
              tags={
                <>
                  {o.id === currentId && (
                    <span className="rounded-full bg-hover px-2 py-0.5 text-xs">{t("current")}</span>
                  )}
                  {o.id === routedId && (
                    <span className="rounded-full bg-hover px-2 py-0.5 text-xs">{t("routed")}</span>
                  )}
                </>
              }
            />
          ))}
        </div>
      )}
      {canChoose && changed && (
        <form
          className="flex flex-col gap-2"
          aria-label={t("confirmForm")}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <ReasonFields codes={codes} reason={reason} setReason={setReason} note={note} setNote={setNote} />
          <p className="m-0 text-xs text-muted">{t("hint")}</p>
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className={buttonCls}>
              {t("choose")}
            </button>
            <button type="button" onClick={() => setPicked(currentId)} className={ghostButtonCls}>
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
      {canChoose && manual && !changed && (
        <div>
          <button type="button" onClick={clear} disabled={pending} className={`${ghostButtonCls} text-sm`}>
            {t("clear")}
          </button>
        </div>
      )}
      {message && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={`m-0 text-sm ${message.tone === "error" ? "text-block" : "text-ok"}`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}

/** "Пренасочи към друг склад" (OWNER/ADMIN): cancel at the old warehouse first, then send from the new one. */
export function RerouteForm({
  orderId,
  from,
  targets,
  codes,
}: {
  orderId: string;
  from: string;
  targets: OptionView[];
  codes: CodeView[];
}) {
  const t = useTranslations("override");
  const locale = useLocale();
  const err = useErr();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<{ text: string; findings?: Finding[] } | null>(null);
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      if (!picked) return;
      const r = await rerouteAction({
        orderId,
        toConnectionId: picked,
        reasonCode: reason || null,
        reasonText: note || null,
      });
      if (r.error) return setError({ text: err(r.error), findings: r.findings });
      setOpen(false);
      router.refresh();
    });

  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className={`${ghostButtonCls} self-start`}>
        {t("reroute.open")}
      </button>
    );
  return (
    <form
      aria-label={t("reroute.form")}
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="m-0 text-sm">{t("reroute.explain", { from })}</p>
      {targets.length === 0 ? (
        <p className="m-0 text-muted">{t("reroute.noTargets")}</p>
      ) : (
        <div className="flex flex-col gap-2" role="radiogroup" aria-label={t("reroute.target")}>
          {targets.map((o) => (
            <Option
              key={o.id}
              o={o}
              name={`reroute-${orderId}`}
              checked={picked === o.id}
              onChange={() => setPicked(o.id)}
            />
          ))}
        </div>
      )}
      <ReasonFields codes={codes} reason={reason} setReason={setReason} note={note} setNote={setNote} />
      <label className="flex items-center gap-2 rounded-lg bg-block-bg px-3 py-2 text-sm text-block">
        <input
          type="checkbox"
          required
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          className="h-4 w-4"
        />
        {t("reroute.ack", { from })}
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={pending || !picked || !ack} className={`${buttonCls} bg-block`}>
          {t("reroute.submit")}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={ghostButtonCls}>
          {t("cancel")}
        </button>
      </div>
      {error && (
        <div role="alert" className="text-sm text-block">
          <p className="m-0">{error.text}</p>
          {error.findings?.map((f, i) => (
            <p key={i} className="m-0">
              · {locale === "en" ? f.message_en : f.message_bg}
            </p>
          ))}
        </div>
      )}
    </form>
  );
}

/** CANARY: the cancel waits for one explicit click after seeing its exact payload (the sender still decides). */
export function CancelCanaryConfirm({ requestId }: { requestId: string }) {
  const t = useTranslations("fulfill");
  const o = useTranslations("override");
  const router = useRouter();
  const [dialog, setDialog] = useState<{
    payload: unknown;
    payloadHash: string;
    remaining: number;
    cap: number;
    usedToday: number;
    operation: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <button
        type="button"
        disabled={pending}
        className={`${ghostButtonCls} self-start`}
        onClick={() =>
          start(async () => {
            const r = await canaryViewAction(requestId);
            if ("error" in r) setError(r.error);
            else setDialog(r);
          })
        }
      >
        {t("canary.review")}
      </button>
      {error && (
        <span className="text-sm text-block">
          {o("error.generic")} ({error})
        </span>
      )}
      {dialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-canary-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-3 rounded-[14px] bg-surface p-5 shadow-xl">
            <h2 id="cancel-canary-title" className="m-0 text-lg font-semibold">
              {t("canary.title")}
            </h2>
            <p className="m-0 text-muted">{o("reroute.canary")}</p>
            <p className="m-0 font-semibold">
              {t("canary.cap", { remaining: dialog.remaining, cap: dialog.cap, used: dialog.usedToday })}
            </p>
            <p className="m-0 font-mono text-xs text-muted">{dialog.operation}</p>
            <pre
              aria-label={t("canary.payload")}
              className="m-0 min-h-24 overflow-auto rounded-lg bg-hover p-3 font-mono text-xs"
            >
              {JSON.stringify(dialog.payload, null, 2)}
            </pre>
            <div className="flex flex-wrap justify-end gap-3">
              <button
                type="button"
                onClick={() => setDialog(null)}
                className="min-h-11 rounded-[10px] border border-line px-4 hover:bg-hover"
              >
                {t("canary.cancel")}
              </button>
              <button
                type="button"
                disabled={pending || dialog.remaining === 0}
                onClick={() =>
                  start(async () => {
                    const r = await confirmCanaryAction(requestId, dialog.payloadHash);
                    if ("error" in r) setError(r.error);
                    setDialog(null);
                    router.refresh();
                  })
                }
                className="min-h-11 rounded-[10px] bg-block px-4 font-semibold text-white disabled:opacity-60"
              >
                {t("canary.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * "Откажи в склада" for one shipment: a confirmation dialog with a required reason. The server re-checks everything
 * (role, vendor rules, reroute, a request already on its way); the outbox sender applies the liveMode.
 */
export function WarehouseCancelButton({
  orderId,
  fulfillmentId,
  externalId,
  connection,
  liveMode,
  codes,
}: {
  orderId: string;
  fulfillmentId: string;
  externalId: string;
  connection: string;
  liveMode: string;
  codes: CodeView[];
}) {
  const t = useTranslations("override");
  const err = useErr();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const r = await warehouseCancelAction({
        orderId,
        fulfillmentId,
        reasonCode: reason || null,
        reasonText: note || null,
      });
      if (r.error) return setError(err(r.error));
      setOpen(false);
      router.refresh();
    });
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setError(null);
        }}
        className={`${ghostButtonCls} self-start text-block`}
        data-testid={`warehouse-cancel-${externalId}`}
      >
        {t("warehouseCancel.open")}
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("warehouseCancel.title")}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <form
            className="flex w-full max-w-lg flex-col gap-3 rounded-[14px] bg-surface p-4 shadow-lg"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <h3 className="m-0 text-base font-semibold">{t("warehouseCancel.title")}</h3>
            <p className="m-0 text-sm">{t("warehouseCancel.explain", { id: externalId, connection })}</p>
            {liveMode !== "LIVE" && (
              <p className="m-0 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">
                {t(`warehouseCancel.mode.${liveMode}`)}
              </p>
            )}
            <ReasonFields codes={codes} reason={reason} setReason={setReason} note={note} setNote={setNote} />
            <label className="flex items-center gap-2 rounded-lg bg-block-bg px-3 py-2 text-sm text-block">
              <input
                type="checkbox"
                required
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                className="h-4 w-4"
              />
              {t("warehouseCancel.ack", { connection })}
            </label>
            <div className="flex gap-2">
              <button type="submit" disabled={pending || !reason || !ack} className={`${buttonCls} bg-block`}>
                {t("warehouseCancel.submit")}
              </button>
              <button type="button" onClick={() => setOpen(false)} className={ghostButtonCls}>
                {t("cancel")}
              </button>
            </div>
            {error && (
              <p role="alert" className="m-0 text-sm text-block">
                {error}
              </p>
            )}
          </form>
        </div>
      )}
    </>
  );
}
