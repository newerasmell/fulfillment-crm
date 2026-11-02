"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import {
  decideAction,
  previewAddressAction,
  recheckAction,
  releaseAction,
  saveAddressAction,
} from "@/app/actions/review";
import { buttonCls, ghostButtonCls, inputCls, labelCls } from "@/components/ui/form";
import type { Finding } from "@/server/checks/findings";

/** Client parts of the order detail (P4-04): address editor with live validation, suggested fixes, decision bar. */

const FIELDS = [
  "name",
  "company",
  "address1",
  "address2",
  "city",
  "zip",
  "province",
  "countryCode",
  "phone",
] as const;
type Field = (typeof FIELDS)[number];
export type Values = Record<Field, string | null>;

const pathOf = (f: Field) => (f === "phone" ? "phone" : `shippingAddress.${f}`);
const errKey = (code: string) => `error.${code.replace(":", "__")}`;

function useErrorText() {
  const t = useTranslations("review");
  return (code: string) => (t.has(errKey(code)) ? t(errKey(code)) : `${t("error.generic")} (${code})`);
}

export function AddressEditor({
  orderId,
  version,
  values,
  original,
  editable,
  canReview,
  statusLabel,
}: {
  orderId: string;
  version: string;
  values: Values;
  original: Values | null;
  editable: boolean;
  canReview: boolean;
  statusLabel: string;
}) {
  const t = useTranslations("review");
  const locale = useLocale();
  const errorText = useErrorText();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Values>(values);
  const [live, setLive] = useState<{ findings: Finding[]; phone: string | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const validate = useCallback(
    (next: Values) => {
      if (timer.current) clearTimeout(timer.current);
      setChecking(true);
      timer.current = setTimeout(async () => {
        const mine = ++seq.current;
        const r = await previewAddressAction({ orderId, values: next });
        if (mine !== seq.current) return; // a newer keystroke is being checked
        setChecking(false);
        if (r.error) setMessage({ tone: "error", text: errorText(r.error) });
        else setLive({ findings: r.findings ?? [], phone: r.normalisedPhone ?? null });
      }, 350);
    },
    [orderId, errorText],
  );
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const open = () => {
    setDraft(values);
    setMessage(null);
    setEditing(true);
    validate(values);
  };
  const change = (f: Field, v: string) => {
    const next = { ...draft, [f]: v };
    setDraft(next);
    validate(next);
  };
  const save = () =>
    start(async () => {
      const r = await saveAddressAction({ orderId, version, values: draft });
      if (r?.error) return setMessage({ tone: "error", text: errorText(r.error) });
      setEditing(false);
      setMessage({ tone: "ok", text: r?.changed ? t("address.saved") : t("address.unchanged") });
    });

  const fieldErrors = (f: Field) =>
    (live?.findings ?? []).filter(
      (x) => x.field === pathOf(f) || (f === "countryCode" && x.field === "countryCode"),
    );
  const msg = (x: Finding) => (locale === "en" ? x.message_en : x.message_bg);

  if (!editing) {
    return (
      <div className="flex flex-col gap-2">
        <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1" data-testid="address-view">
          {FIELDS.map((f) => {
            const now = values[f];
            const was = original?.[f] ?? null;
            const corrected = original && was !== now;
            if (!now && !corrected) return null;
            return (
              <div key={f} className="contents">
                <dt className="text-muted">{t(`address.field.${f}`)}</dt>
                <dd
                  className={`m-0 ${f === "phone" || f === "zip" || f === "countryCode" ? "font-mono text-[13px]" : ""}`}
                >
                  {corrected && (
                    <del className="mr-2 text-muted" aria-label={t("address.original")}>
                      {was ?? "—"}
                    </del>
                  )}
                  <span>{now ?? "—"}</span>
                  {corrected && (
                    <span className="ml-2 rounded-full bg-warn-bg px-2 py-0.5 text-xs text-warn">
                      {t("address.corrected")}
                    </span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
        {message && (
          <p role="status" className={`m-0 text-sm ${message.tone === "ok" ? "text-ok" : "text-block"}`}>
            {message.text}
          </p>
        )}
        {canReview &&
          (editable ? (
            <button type="button" onClick={open} className={`${ghostButtonCls} self-start`}>
              {t("address.edit")}
            </button>
          ) : (
            <p className="m-0 text-sm text-muted">{t("address.notEditable", { status: statusLabel })}</p>
          ))}
      </div>
    );
  }

  return (
    <form
      aria-label={t("address.form")}
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {FIELDS.map((f) => {
        const errs = fieldErrors(f);
        const id = `addr-${f}`;
        return (
          <label key={f} className={`${labelCls} ${f === "address1" || f === "name" ? "sm:col-span-2" : ""}`}>
            {t(`address.field.${f}`)}
            <input
              id={id}
              name={f}
              value={draft[f] ?? ""}
              onChange={(e) => change(f, e.target.value)}
              aria-invalid={errs.length ? true : undefined}
              aria-describedby={errs.length ? `${id}-err` : undefined}
              maxLength={f === "countryCode" ? 2 : 200}
              className={`${inputCls} ${errs.length ? "border-block" : ""}`}
            />
            {original && original[f] !== (draft[f] || null) && (
              <span className="text-xs font-normal text-muted">
                {t("address.original")}: <del>{original[f] ?? "—"}</del>
              </span>
            )}
            {errs.map((x) => (
              <span
                key={x.code}
                id={`${id}-err`}
                className={`text-xs font-normal ${x.severity === "hard" ? "text-block" : "text-warn"}`}
              >
                {msg(x)}
              </span>
            ))}
            {f === "phone" && live?.phone && live.phone !== (draft.phone ?? "") && (
              <span className="text-xs font-normal text-muted">
                {t("address.phoneAs", { phone: live.phone })}
              </span>
            )}
          </label>
        );
      })}
      <p role="status" aria-live="polite" className="m-0 text-sm sm:col-span-2" data-testid="address-live">
        {checking ? (
          <span className="text-muted">{t("address.checking")}</span>
        ) : live && live.findings.length === 0 ? (
          <span className="text-ok">✓ {t("address.liveOk")}</span>
        ) : live ? (
          <span className="text-block">{live.findings.map((x) => msg(x)).join(" · ")}</span>
        ) : null}
      </p>
      {message?.tone === "error" && (
        <p role="alert" className="m-0 text-sm text-block sm:col-span-2">
          {message.text}
        </p>
      )}
      <div className="flex gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonCls}>
          {pending ? t("address.saving") : t("address.save")}
        </button>
        <button type="button" onClick={() => setEditing(false)} className={ghostButtonCls}>
          {t("address.cancel")}
        </button>
      </div>
    </form>
  );
}

/** One-click suggested fix for an address/phone finding (recorded in the diff as suggested_fix:<code>). */
export function ApplyFixButton({
  orderId,
  version,
  field,
  value,
  code,
}: {
  orderId: string;
  version: string;
  field: string;
  value: string;
  code: string;
}) {
  const t = useTranslations("review");
  const errorText = useErrorText();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const key = field === "phone" ? "phone" : field.replace(/^shippingAddress\./, "");
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        className={`${ghostButtonCls} min-h-9 text-sm`}
        onClick={() =>
          start(async () => {
            const r = await saveAddressAction({
              orderId,
              version,
              values: { [key]: value },
              via: `suggested_fix:${code}`,
            });
            setError(r?.error ? errorText(r.error) : null);
          })
        }
      >
        {t("findings.apply", { value })}
      </button>
      {error && (
        <span role="alert" className="text-sm text-block">
          {error}
        </span>
      )}
    </span>
  );
}

export function RecheckButton({ orderId }: { orderId: string }) {
  const t = useTranslations("review");
  const errorText = useErrorText();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        className={`${ghostButtonCls} text-sm`}
        onClick={() =>
          start(async () => {
            const r = await recheckAction(orderId);
            setError(r?.error ? errorText(r.error) : null);
          })
        }
      >
        {pending ? t("address.checking") : t("findings.recheck")}
      </button>
      {error && <span className="text-sm text-block">{error}</span>}
    </span>
  );
}

type Kind = "approve" | "hold" | "block";
interface Code {
  code: string;
  label: string;
  decisions: Kind[];
}

/**
 * Sticky decision bar (DESIGN.md screen 3): Одобри / Задръж / Блокирай, each with a reason from the group's
 * list, keyboard A / H / R. The server decides (src/server/review/service.ts decideOrder); the bar only
 * shows what the server would allow. The review timer starts when the page is first opened and survives the
 * refreshes that edits cause.
 */
export function DecisionBar({
  orderId,
  allowed,
  hardCount,
  changes,
  codes,
  openedAt,
  canRelease,
  statusLabel,
}: {
  orderId: string;
  allowed: Kind[];
  hardCount: number;
  changes: number;
  codes: Code[];
  openedAt: string;
  canRelease: boolean;
  statusLabel: string;
}) {
  const t = useTranslations("review");
  const errorText = useErrorText();
  const router = useRouter();
  const [started] = useState(openedAt);
  const [kind, setKind] = useState<Kind | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  const approveBlocked = hardCount > 0;

  const choose = useCallback(
    (k: Kind) => {
      if (!allowed.includes(k)) return;
      setKind(k);
      setReason("");
      setError(null);
    },
    [allowed],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || !el) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable) return;
      const k = ({ a: "approve", h: "hold", r: "block" } as const)[e.key.toLowerCase() as "a" | "h" | "r"];
      if (k) {
        e.preventDefault();
        choose(k);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [choose]);

  const submit = () =>
    start(async () => {
      if (!kind) return;
      const r = await decideAction({
        orderId,
        decision: kind,
        reasonCode: reason || null,
        reasonText: note || null,
        openedAt: started,
      });
      if (r?.error) return setError(errorText(r.error));
      setDone(true);
      setKind(null);
      router.refresh();
    });

  const release = () =>
    start(async () => {
      const r = await releaseAction(orderId);
      if (r?.error) setError(errorText(r.error));
    });

  const tone: Record<Kind, string> = {
    approve: "bg-ok text-white",
    hold: "bg-warn text-white",
    block: "bg-block text-white",
  };
  const options = kind ? codes.filter((c) => c.decisions.includes(kind)) : [];

  return (
    <section
      aria-label={t("decide.bar")}
      className="sticky bottom-0 z-10 -mx-1 mt-2 rounded-[14px] bg-dark px-4 py-3 text-white shadow-lg"
    >
      <div className="flex flex-wrap items-center gap-3">
        {allowed.length === 0 && !canRelease && (
          <span className="text-sm text-white/80">{t("decide.noActions", { status: statusLabel })}</span>
        )}
        {(["approve", "hold", "block"] as const)
          .filter((k) => allowed.includes(k))
          .map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => choose(k)}
              aria-pressed={kind === k}
              disabled={pending || (k === "approve" && approveBlocked)}
              title={
                k === "approve" && approveBlocked ? t("decide.hardBlocked", { n: hardCount }) : undefined
              }
              className={`min-h-11 rounded-[10px] px-4 font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                kind === k ? `${tone[k]} ring-2 ring-white` : `${tone[k]}`
              }`}
            >
              {t(`decide.${k}`)}
            </button>
          ))}
        {canRelease && (
          <button
            type="button"
            onClick={release}
            disabled={pending}
            className="min-h-11 rounded-[10px] border border-white/40 px-4"
          >
            {t("decide.release")}
          </button>
        )}
        {approveBlocked && allowed.includes("approve") && (
          <span className="text-sm text-[#FDECEA]">{t("decide.hardBlocked", { n: hardCount })}</span>
        )}
        {changes > 0 && <span className="text-sm text-white/80">{t("decide.changes", { n: changes })}</span>}
        <span className="ml-auto hidden text-xs text-white/60 lg:inline">{t("decide.keys")}</span>
      </div>
      {kind && (
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="flex flex-col gap-1 text-[13px] font-medium">
            {t("decide.reason")}
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required={kind !== "approve"}
              className="min-h-11 rounded-[10px] border border-white/30 bg-[#26262B] px-3 text-white"
            >
              <option value="">
                {kind === "approve" ? t("decide.reasonOptional") : t("decide.reasonPick")}
              </option>
              {options.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-60 flex-1 flex-col gap-1 text-[13px] font-medium">
            {t("decide.note")}
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
              className="min-h-11 rounded-[10px] border border-white/30 bg-[#26262B] px-3 text-white"
            />
          </label>
          <button
            type="submit"
            disabled={pending}
            className={`min-h-11 rounded-[10px] px-4 font-semibold ${tone[kind]}`}
          >
            {t("decide.confirm", { decision: t(`kind.${kind}`) })}
          </button>
          <button
            type="button"
            onClick={() => setKind(null)}
            className="min-h-11 rounded-[10px] border border-white/40 px-4"
          >
            {t("decide.cancel")}
          </button>
          <p className="m-0 w-full text-xs text-white/70">
            {kind === "block" ? t("decide.blockHint") : kind === "approve" ? t("decide.approveHint") : null}
          </p>
        </form>
      )}
      {error && (
        <p role="alert" className="m-0 mt-2 text-sm text-[#FDECEA]">
          {error}
        </p>
      )}
      {done && !error && (
        <p role="status" className="m-0 mt-2 text-sm text-[#E7F4EC]">
          {t("decide.done")}
        </p>
      )}
    </section>
  );
}

/** A <details> whose content is mounted only while open (raw JSON stays out of the page text until asked for). */
export function LazyDetails({ summary, children }: { summary: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer">{summary}</summary>
      {open && children}
    </details>
  );
}
