"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import {
  addWarehouseReplyAction,
  markCustomerEmailedAction,
  markWarehouseEmailSentAction,
  refreshCasesAction,
  unlockSkuAction,
  type CaseActionResult,
} from "@/app/actions/warehouse-cases";
import { buttonCls, ghostButtonCls, inputCls, tdCls, thCls } from "@/components/ui/form";
import { customerEmail, type CustomerEmailInput } from "@/lib/warehouse-case-emails";

type Email = { to: string[]; cc: string[]; subject: string; body: string };
type Level = 1 | 2 | 3;

export interface CaseOrderRow {
  id: string;
  orderId: string;
  number: string;
  ref: string;
  awb: string | null;
  rawStatus: string | null;
  since: string;
  hours: number;
  level: number | null;
  outcome: string | null;
  resolved: boolean;
  warehouseConfirmed: boolean;
  customerEmailed: boolean;
  cancelInFlight: boolean;
  deleteUntil: string | null;
  items: string;
  zeroStock: string[];
  held: { frozen: boolean; units: number }[];
}

export interface CaseData {
  id: string;
  companyName: string;
  connectionName: string;
  senderEmail: string | null;
  discountPercent: number | null;
  configured: boolean;
  closed: boolean;
  level: number;
  oldestHours: number;
  lastSentLevel: number;
  lastSentAt: string | null;
  repliedSinceLast: boolean;
  suggested: Level | null;
  emails: Record<Level, Email>;
  messages: {
    id: string;
    direction: string;
    kind: string;
    recipients: string[];
    subject: string;
    body: string;
    orderNumbers: string[];
    createdAt: string;
  }[];
  customerInputs: Record<string, CustomerEmailInput>;
  orders: CaseOrderRow[];
}

const LEVEL_CLS = [
  "bg-hover text-ink-2",
  "bg-warn-bg text-warn",
  "bg-warn-bg text-warn",
  "bg-block-bg text-block",
];

function useAction() {
  const router = useRouter();
  const t = useTranslations("warehouseCases");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const go = (fn: () => Promise<CaseActionResult>, okText: string, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if ("error" in r)
        setMsg({ ok: false, text: t.has(`error.${r.error}`) ? t(`error.${r.error}`) : r.error });
      else {
        setMsg({ ok: true, text: okText });
        after?.();
        router.refresh();
      }
    });
  return { pending, msg, go };
}

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p className={`m-0 text-sm ${msg.ok ? "text-ok" : "text-block"}`}>{msg.text}</p>;
}

function CopyButton({ value, label, testId }: { value: string; label: string; testId?: string }) {
  const t = useTranslations("warehouseCases");
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`${ghostButtonCls} min-h-8 px-2 text-xs`}
      data-testid={testId}
      disabled={!value}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? `✓ ${t("copied")}` : label}
    </button>
  );
}

/** To / Cc / subject / body, each with its own copy button, as they go into Gmail. */
function EmailBox({ email, testId }: { email: Email; testId: string }) {
  const t = useTranslations("warehouseCases");
  const row = (label: string, value: string, id: string) => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-16 text-xs text-label">{label}</span>
      <span className="min-w-0 flex-1 font-mono text-[13px] break-words">{value || "—"}</span>
      <CopyButton value={value} label={t("copy")} testId={`${testId}-copy-${id}`} />
    </div>
  );
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-bg p-3" data-testid={testId}>
      {row(t("to"), email.to.join(", "), "to")}
      {email.cc.length > 0 && row(t("cc"), email.cc.join(", "), "cc")}
      {row(t("subject"), email.subject, "subject")}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-label">{t("body")}</span>
        <CopyButton value={email.body} label={t("copyBody")} testId={`${testId}-copy-body`} />
      </div>
      <pre className="m-0 max-h-80 overflow-auto rounded-md bg-surface p-2 font-mono text-[12px] whitespace-pre-wrap">
        {email.body}
      </pre>
    </div>
  );
}

export function RefreshButton() {
  const t = useTranslations("warehouseCases");
  const { pending, msg, go } = useAction();
  return (
    <div className="flex items-center gap-2">
      <Msg msg={msg} />
      <button
        type="button"
        className={ghostButtonCls}
        disabled={pending}
        data-testid="cases-refresh"
        onClick={() => go(() => refreshCasesAction(), t("refreshed"))}
      >
        {t("refresh")}
      </button>
    </div>
  );
}

export function CaseCard({ c, canAct }: { c: CaseData; canAct: boolean }) {
  const t = useTranslations("warehouseCases");
  const format = useFormatter();
  const [level, setLevel] = useState<Level>(
    c.suggested ?? (Math.max(1, Math.min(3, c.lastSentLevel || 1)) as Level),
  );
  const [panel, setPanel] = useState<"email" | "reply" | null>(
    c.suggested && c.suggested > c.lastSentLevel ? "email" : null,
  );
  const [customerFor, setCustomerFor] = useState<string | null>(null);
  const open = c.orders.filter((o) => !o.resolved);
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "short", timeStyle: "short" });
  const email = c.emails[level];
  const { pending, msg, go } = useAction();
  return (
    <section
      className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-5"
      data-testid="case-card"
      id={`case-${c.id}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <h2 className="m-0 text-lg font-bold">
            {c.connectionName} <span className="font-normal text-muted">· {c.companyName}</span>
          </h2>
          <span className="text-sm text-muted">
            {c.closed ? t("closed") : t("summary", { count: open.length, hours: c.oldestHours })}
            {c.lastSentAt && ` · ${t("lastSent", { level: c.lastSentLevel, when: when(c.lastSentAt) })}`}
            {c.repliedSinceLast && ` · ${t("replied")}`}
          </span>
        </div>
        {!c.closed && (
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${LEVEL_CLS[c.level]}`}
            data-testid="case-level"
          >
            {t(`level.${c.level}`)}
          </span>
        )}
      </header>

      {!c.closed && c.suggested && (
        <p className="m-0 rounded-md bg-warn-bg px-3 py-2 text-sm text-warn" data-testid="case-next">
          {c.suggested > c.lastSentLevel ? t(`next.${c.suggested}`) : t("nextWait")}
          {c.level >= 3 && ` ${t("decide")}`}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className={thCls}>{t("col.order")}</th>
              <th className={thCls}>{t("col.ref")}</th>
              <th className={thCls}>{t("col.status")}</th>
              <th className={thCls}>{t("col.since")}</th>
              <th className={thCls}>{t("col.items")}</th>
              <th className={thCls}>{t("col.state")}</th>
              {canAct && <th className={thCls} />}
            </tr>
          </thead>
          <tbody>
            {c.orders.map((o) => (
              <tr key={o.id} data-testid="case-order" className={o.resolved ? "opacity-60" : ""}>
                <td className={tdCls}>
                  <Link
                    className="font-semibold text-accent-strong hover:underline"
                    href={`/orders/${o.orderId}`}
                  >
                    {o.number}
                  </Link>
                </td>
                <td className={`${tdCls} font-mono text-[13px]`}>
                  {o.ref}
                  {o.awb && <div className="text-xs text-muted">AWB {o.awb}</div>}
                </td>
                <td className={tdCls}>{o.rawStatus ?? "—"}</td>
                <td className={tdCls}>
                  <span className="font-semibold">{t("hours", { hours: o.hours })}</span>
                  <div className="text-xs text-muted">{when(o.since)}</div>
                  {o.deleteUntil && !o.resolved && (
                    <div className="text-xs text-muted">
                      {t("deleteUntil", {
                        date: format.dateTime(new Date(o.deleteUntil), { dateStyle: "short" }),
                      })}
                    </div>
                  )}
                </td>
                <td className={tdCls}>
                  {o.items}
                  {o.zeroStock.length > 0 && (
                    <div className="text-xs text-block">
                      {t("zeroStock", { skus: o.zeroStock.join(", ") })}
                    </div>
                  )}
                  {o.held.length > 0 && (
                    <div className="text-xs text-block">
                      {o.held.some((h) => h.frozen) ? t("heldFrozen") : t("held")}
                    </div>
                  )}
                </td>
                <td className={`${tdCls} text-xs`}>
                  <div className="flex flex-col gap-0.5">
                    {o.resolved ? (
                      <span className="text-ok">{t(`outcome.${o.outcome ?? "other"}`)}</span>
                    ) : (
                      <span
                        className={`w-fit rounded-full px-2 py-0.5 font-semibold ${LEVEL_CLS[o.level ?? 0]}`}
                      >
                        {t(`level.${o.level ?? 0}`)}
                      </span>
                    )}
                    {o.cancelInFlight && <span className="text-warn">{t("cancelInFlight")}</span>}
                    {o.warehouseConfirmed && <span className="text-ok">{t("confirmed")}</span>}
                    {o.customerEmailed && <span className="text-ok">{t("customerEmailed")}</span>}
                  </div>
                </td>
                {canAct && (
                  <td className={tdCls}>
                    {c.customerInputs[o.id] && (
                      <button
                        type="button"
                        className={`${ghostButtonCls} min-h-8 px-2 text-xs whitespace-nowrap`}
                        data-testid="customer-email-open"
                        onClick={() => setCustomerFor(customerFor === o.id ? null : o.id)}
                      >
                        {t("customerEmail")}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {customerFor && c.customerInputs[customerFor] && (
        <CustomerEmail
          caseOrderId={customerFor}
          input={c.customerInputs[customerFor]}
          discountPercent={c.discountPercent}
          senderEmail={c.senderEmail}
          onDone={() => setCustomerFor(null)}
        />
      )}

      {canAct && !c.closed && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={panel === "email" ? buttonCls : ghostButtonCls}
            data-testid="case-email-toggle"
            onClick={() => setPanel(panel === "email" ? null : "email")}
          >
            {t("warehouseEmail")}
          </button>
          <button
            type="button"
            className={panel === "reply" ? buttonCls : ghostButtonCls}
            data-testid="case-reply-toggle"
            onClick={() => setPanel(panel === "reply" ? null : "reply")}
          >
            {t("addReply")}
          </button>
        </div>
      )}

      {canAct && !c.closed && panel === "email" && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2" role="tablist">
            {([1, 2, 3] as const).map((l) => (
              <button
                key={l}
                type="button"
                role="tab"
                aria-selected={level === l}
                data-testid={`case-email-level-${l}`}
                className={`${level === l ? buttonCls : ghostButtonCls} min-h-9 px-3 text-sm`}
                onClick={() => setLevel(l)}
              >
                {t(`emailLevel.${l}`)}
                {c.lastSentLevel >= l && " ✓"}
              </button>
            ))}
          </div>
          {c.senderEmail ? (
            <p className="m-0 text-sm text-muted">{t("sendFrom", { email: c.senderEmail })}</p>
          ) : (
            <p className="m-0 text-sm text-warn">{t("noSender")}</p>
          )}
          {!c.configured && <p className="m-0 text-sm text-warn">{t("noRecipients")}</p>}
          <EmailBox email={email} testId="case-email" />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={buttonCls}
              disabled={pending}
              data-testid="case-email-sent"
              onClick={() =>
                go(
                  () =>
                    markWarehouseEmailSentAction({
                      caseId: c.id,
                      level,
                      recipients: [...email.to, ...email.cc],
                      subject: email.subject,
                      body: email.body,
                      orderNumbers: open.map((o) => o.number),
                    }),
                  t("sentOk"),
                  () => setPanel(null),
                )
              }
            >
              {t("markSent")}
            </button>
            <Msg msg={msg} />
          </div>
        </div>
      )}

      {canAct && !c.closed && panel === "reply" && (
        <ReplyForm caseId={c.id} orders={open} onDone={() => setPanel(null)} />
      )}

      {c.messages.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">
            {t("history", { count: c.messages.length })}
          </summary>
          <ol className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
            {c.messages.map((m) => (
              <li key={m.id} className="rounded-md border border-line-soft p-2" data-testid="case-message">
                <div className="text-xs text-muted">
                  {when(m.createdAt)} ·{" "}
                  {t(`kind.${m.kind.startsWith("warehouse_") ? "warehouse" : m.kind}`, {
                    level: m.kind.slice(-1),
                  })}
                  {m.orderNumbers.length > 0 && ` · ${m.orderNumbers.join(", ")}`}
                </div>
                <div className="font-semibold">{m.subject}</div>
                <pre className="m-0 font-sans text-[13px] whitespace-pre-wrap">{m.body}</pre>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function ReplyForm({
  caseId,
  orders,
  onDone,
}: {
  caseId: string;
  orders: CaseOrderRow[];
  onDone: () => void;
}) {
  const t = useTranslations("warehouseCases");
  const [body, setBody] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { pending, msg, go } = useAction();
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-bg p-3" data-testid="case-reply">
      <label className="flex flex-col gap-1 text-sm">
        <span>{t("replyText")}</span>
        <textarea
          className={`${inputCls} min-h-28 py-2`}
          value={body}
          maxLength={20000}
          onChange={(e) => setBody(e.target.value)}
          data-testid="case-reply-body"
        />
      </label>
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0 text-sm">
        <legend className="mb-1 text-label">{t("replyConfirms")}</legend>
        {orders.map((o) => (
          <label key={o.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={picked.has(o.id)}
              data-testid="case-reply-confirm"
              onChange={(e) => {
                const next = new Set(picked);
                if (e.target.checked) next.add(o.id);
                else next.delete(o.id);
                setPicked(next);
              }}
            />
            {o.number} <span className="text-muted">({o.ref})</span>
          </label>
        ))}
      </fieldset>
      <p className="m-0 text-xs text-muted">{t("replyHint")}</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={buttonCls}
          disabled={pending || body.trim().length < 2}
          data-testid="case-reply-save"
          onClick={() =>
            go(
              () => addWarehouseReplyAction({ caseId, body, confirmedCaseOrderIds: [...picked] }),
              t("replyOk"),
              onDone,
            )
          }
        >
          {t("saveReply")}
        </button>
        <Msg msg={msg} />
      </div>
    </div>
  );
}

function CustomerEmail({
  caseOrderId,
  input,
  discountPercent,
  senderEmail,
  onDone,
}: {
  caseOrderId: string;
  input: CustomerEmailInput;
  discountPercent: number | null;
  senderEmail: string | null;
  onDone: () => void;
}) {
  const t = useTranslations("warehouseCases");
  const [code, setCode] = useState("");
  const { pending, msg, go } = useAction();
  // The company's template, filled as the code is typed (its discount line is left out without a code).
  const email = customerEmail({ ...input, discountCode: code });
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-bg p-3" data-testid="customer-email">
      <strong className="text-sm">{t("customerEmail")}</strong>
      <p className="m-0 text-xs text-muted">
        {senderEmail ? t("sendFrom", { email: senderEmail }) : t("noSender")}
      </p>
      <label className="flex flex-col gap-1 text-sm">
        <span>
          {discountPercent ? t("codeLabel", { percent: discountPercent }) : t("codeLabelNoPercent")}
        </span>
        <input
          className={inputCls}
          value={code}
          maxLength={60}
          placeholder={t("codePlaceholder")}
          onChange={(e) => setCode(e.target.value)}
          data-testid="customer-email-code"
        />
      </label>
      <EmailBox email={email} testId="customer-email-box" />
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={buttonCls}
          disabled={pending}
          data-testid="customer-email-sent"
          onClick={() =>
            go(
              () =>
                markCustomerEmailedAction({
                  caseOrderId,
                  recipients: email.to,
                  subject: email.subject,
                  body: email.body,
                }),
              t("sentOk"),
              onDone,
            )
          }
        >
          {t("markSent")}
        </button>
        <Msg msg={msg} />
      </div>
    </div>
  );
}

export function SkuWatchTable({
  rows,
  canAct,
}: {
  rows: {
    connectionId: string;
    productId: string;
    sku: string | null;
    title: string;
    connectionName: string;
    units: number;
    incidents: number;
    frozen: boolean;
    lastAt: string;
  }[];
  canAct: boolean;
}) {
  const t = useTranslations("warehouseCases");
  const format = useFormatter();
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const { pending, msg, go } = useAction();
  return (
    <div className="flex flex-col gap-2">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className={thCls}>{t("sku.product")}</th>
            <th className={thCls}>{t("sku.warehouse")}</th>
            <th className={thCls}>{t("sku.state")}</th>
            <th className={thCls}>{t("sku.last")}</th>
            {canAct && <th className={thCls} />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const key = `${r.connectionId}:${r.productId}`;
            return (
              <tr key={key} data-testid="sku-watch-row">
                <td className={tdCls}>
                  <span className="font-mono text-[13px]">{r.sku}</span>
                  <div className="text-xs text-muted">{r.title}</div>
                </td>
                <td className={tdCls}>{r.connectionName}</td>
                <td className={tdCls}>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${r.frozen ? "bg-block-bg text-block" : "bg-warn-bg text-warn"}`}
                  >
                    {r.frozen ? t("sku.frozen") : t("sku.watch", { units: r.units })}
                  </span>
                  <div className="text-xs text-muted">{t("sku.incidents", { count: r.incidents })}</div>
                </td>
                <td className={tdCls}>
                  {format.dateTime(new Date(r.lastAt), { dateStyle: "short", timeStyle: "short" })}
                </td>
                {canAct && (
                  <td className={tdCls}>
                    {unlocking === key ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          className={`${inputCls} min-h-9`}
                          value={note}
                          maxLength={500}
                          placeholder={t("sku.notePlaceholder")}
                          onChange={(e) => setNote(e.target.value)}
                          data-testid="sku-unlock-note"
                        />
                        <button
                          type="button"
                          className={`${buttonCls} min-h-9`}
                          disabled={pending || note.trim().length < 3}
                          data-testid="sku-unlock-save"
                          onClick={() =>
                            go(
                              () =>
                                unlockSkuAction({
                                  connectionId: r.connectionId,
                                  productId: r.productId,
                                  note,
                                }),
                              t("sku.unlocked"),
                              () => {
                                setUnlocking(null);
                                setNote("");
                              },
                            )
                          }
                        >
                          {t("sku.unlock")}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className={`${ghostButtonCls} min-h-8 px-2 text-xs`}
                        data-testid="sku-unlock"
                        onClick={() => setUnlocking(key)}
                      >
                        {t("sku.unlock")}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <Msg msg={msg} />
    </div>
  );
}
