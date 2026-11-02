"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  canaryViewAction,
  confirmCanaryAction,
  retryFulfillItemAction,
  runFulfillStepAction,
} from "@/app/actions/fulfill";
import type { BatchView, CanaryView } from "@/server/fulfill";

/**
 * Fulfill progress (P4-06): drives the batch step by step, shows a result per order, the CANARY confirmation
 * (exact payload + remaining daily cap) and "acknowledge and send" for new warnings.
 */

type Row = BatchView["rows"][number];

const TONE: Record<string, string> = {
  PENDING: "bg-hover text-ink-2",
  RUNNING: "bg-accent-soft text-accent-strong",
  QUEUED: "bg-ok-bg text-ok",
  NEEDS_ACK: "bg-warn-bg text-warn",
  BLOCKED: "bg-block-bg text-block",
  FAILED: "bg-block-bg text-block",
  SKIPPED: "bg-hover text-muted",
};

export function FulfillProgress({ initial, canConfirm }: { initial: BatchView; canConfirm: boolean }) {
  const t = useTranslations("fulfill");
  const locale = useLocale();
  const [view, setView] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<CanaryView | null>(null);
  const [busy, start] = useTransition();
  const running = useRef(false);
  const msg = useCallback(
    (code: string) =>
      code.startsWith("status_")
        ? t("error.notFulfillable", { status: code.slice(7).toUpperCase() })
        : t.has(`error.${code}`)
          ? t(`error.${code}`)
          : code,
    [t],
  );

  const waiting = view.rows.some((r) => r.status === "PENDING" || r.status === "RUNNING");
  useEffect(() => {
    if (!waiting || running.current) return;
    running.current = true;
    void (async () => {
      for (;;) {
        const r = await runFulfillStepAction(view.id);
        if ("error" in r) {
          setError(msg(r.error));
          break;
        }
        setView(r);
        if (!r.rows.some((x) => x.status === "PENDING" || x.status === "RUNNING")) break;
      }
      running.current = false;
    })();
  }, [waiting, view.id, msg]);

  const retry = (row: Row, acknowledge: boolean) =>
    start(async () => {
      const r = await retryFulfillItemAction(
        view.id,
        row.id,
        acknowledge ? row.findings.map((f) => f.code) : [],
      );
      if ("error" in r) setError(msg(r.error));
      else setView(r);
    });
  const openCanary = (row: Row) =>
    start(async () => {
      const r = await canaryViewAction(row.request!.id);
      if ("error" in r) setError(msg(r.error));
      else setDialog(r);
    });
  const confirm = () =>
    start(async () => {
      if (!dialog) return;
      const r = await confirmCanaryAction(dialog.requestId, dialog.payloadHash);
      if ("error" in r) setError(msg(r.error));
      setDialog(null);
      const v = await runFulfillStepAction(view.id);
      if (!("error" in v)) setView(v);
    });

  const pct = view.total ? Math.round((view.done / view.total) * 100) : 100;
  return (
    <>
      <section aria-label={t("progress")} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-semibold" data-testid="fulfill-progress">
            {t("doneOf", { done: view.done, total: view.total })}
          </span>
          {Object.entries(view.counts).map(([k, v]) => (
            <span key={k} className={`rounded-full px-2 py-0.5 text-xs ${TONE[k] ?? ""}`}>
              {t(`status.${k}`)} · {v}
            </span>
          ))}
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={t("progress")}
          className="h-2 w-full overflow-hidden rounded-full bg-hover"
        >
          <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      </section>
      {error && (
        <p role="alert" className="m-0 rounded-lg bg-block-bg px-3 py-2 text-block">
          {error}
        </p>
      )}
      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
        <table className="w-full border-collapse" aria-label={t("results")}>
          <thead>
            <tr>
              {["order", "customer", "warehouse", "result", "details", "actions"].map((h) => (
                <th
                  key={h}
                  className="border-b border-line px-3 py-2 text-left text-[12px] font-semibold tracking-wide text-label uppercase"
                >
                  {t(`col.${h}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr key={r.id} data-testid={`fulfill-row-${r.number}`}>
                <td className="border-b border-line-soft px-3 py-2.5">
                  <Link
                    href={`/orders/${r.orderId}`}
                    className="font-mono font-medium text-accent hover:underline"
                  >
                    {r.number}
                  </Link>
                </td>
                <td className="border-b border-line-soft px-3 py-2.5">{r.customerName ?? "—"}</td>
                <td className="border-b border-line-soft px-3 py-2.5">
                  {r.connection ? (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          r.connection.type === "EUSHIPMENTS"
                            ? "bg-eu-chip text-eu-text"
                            : "bg-fhb-chip text-fhb-text"
                        }`}
                      >
                        {r.connection.name}
                      </span>
                      <span className="text-xs text-muted">{t(`mode.${r.connection.liveMode}`)}</span>
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="border-b border-line-soft px-3 py-2.5">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${TONE[r.status] ?? ""}`}
                  >
                    {t(`status.${r.status}`)}
                  </span>
                  {r.request && (
                    <span className="ml-2 font-mono text-xs text-muted">
                      {t(`request.${r.request.status}`)}
                    </span>
                  )}
                </td>
                <td className="border-b border-line-soft px-3 py-2.5 text-sm">
                  {r.code && <div>{msg(r.code)}</div>}
                  {r.findings.length > 0 && (
                    <ul className="m-0 list-disc pl-5">
                      {r.findings.map((f, i) => (
                        <li key={i} className={f.severity === "hard" ? "text-block" : "text-warn"}>
                          {locale === "en" ? f.message_en : f.message_bg}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="border-b border-line-soft px-3 py-2.5">
                  <span className="flex flex-wrap gap-2">
                    {r.needsCanary && canConfirm && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => openCanary(r)}
                        className="min-h-10 rounded-[10px] bg-accent px-3 font-semibold text-white disabled:opacity-60"
                      >
                        {t("canary.review")}
                      </button>
                    )}
                    {r.status === "NEEDS_ACK" && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => retry(r, true)}
                        className="min-h-10 rounded-[10px] bg-warn px-3 font-semibold text-white disabled:opacity-60"
                      >
                        {t("ackAndSend")}
                      </button>
                    )}
                    {(r.status === "BLOCKED" || r.status === "FAILED") && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => retry(r, false)}
                        className="min-h-10 rounded-[10px] border border-line px-3 hover:bg-hover disabled:opacity-60"
                      >
                        {t("retry")}
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="canary-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-3 rounded-[14px] bg-surface p-5 shadow-xl">
            <h2 id="canary-title" className="m-0 text-lg font-semibold">
              {t("canary.title")}
            </h2>
            <p className="m-0 text-muted">{t("canary.explain")}</p>
            <p className="m-0 font-semibold" data-testid="canary-cap">
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
                disabled={busy || dialog.remaining === 0}
                onClick={confirm}
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
