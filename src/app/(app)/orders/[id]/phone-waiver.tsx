"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { allowOrderPhoneAction, revokeOrderPhoneAction } from "@/app/actions/review";
import { buttonCls, inputCls } from "@/components/ui/form";

/**
 * "Позволи за тази поръчка" on a phone check: shows exactly what goes to the warehouse, asks for a reason, and
 * allows this one phone for this one order (owner request 2026-11-18).
 */
export function PhoneWaiverButton({
  orderId,
  phone,
  sentPhone,
  warehouse,
}: {
  orderId: string;
  phone: string;
  /** What would be sent (international form); null = the phone has no country code, it must be fixed instead. */
  sentPhone: string | null;
  warehouse: string | null;
}) {
  const t = useTranslations("orders.phoneWaiver");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!sentPhone)
    return (
      <p className="m-0 mt-2 text-xs text-muted" data-testid="phone-waiver-local">
        {t("notInternational")}
      </p>
    );
  return (
    <div className="mt-2" data-testid="phone-waiver">
      {!open ? (
        <button type="button" className={`${buttonCls} px-3 py-1 text-sm`} onClick={() => setOpen(true)}>
          {t("button")}
        </button>
      ) : (
        <div
          className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3 text-sm"
          role="dialog"
        >
          <strong>{t("title")}</strong>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">{t("check")}</dt>
            <dd className="m-0">{t("checkValue")}</dd>
            <dt className="text-muted">{t("orderPhone")}</dt>
            <dd className="m-0 font-mono">{phone}</dd>
            <dt className="text-muted">{t("sent")}</dt>
            <dd className="m-0 font-mono font-semibold" data-testid="phone-waiver-sent">
              {sentPhone}
            </dd>
            {warehouse && (
              <>
                <dt className="text-muted">{t("warehouse")}</dt>
                <dd className="m-0">{warehouse}</dd>
              </>
            )}
          </dl>
          <label className="flex flex-col gap-1">
            <span>{t("reason")}</span>
            <input
              className={inputCls}
              value={reason}
              maxLength={300}
              placeholder={t("reasonPlaceholder")}
              onChange={(e) => setReason(e.target.value)}
              data-testid="phone-waiver-reason"
            />
          </label>
          <p className="m-0 rounded-md bg-warn-bg px-2 py-1 text-xs text-warn">{t("warning")}</p>
          {err && <p className="m-0 text-xs text-block">{err}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              className={`${buttonCls} px-3 py-1 text-sm`}
              disabled={pending || reason.trim().length < 3}
              data-testid="phone-waiver-confirm"
              onClick={() =>
                start(async () => {
                  const r = await allowOrderPhoneAction({ orderId, reason, phoneKey: sentPhone });
                  if (r?.error) {
                    setErr(t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : t("errors.failed"));
                    return;
                  }
                  setOpen(false);
                  router.refresh();
                })
              }
            >
              {t("confirm")}
            </button>
            <button
              type="button"
              className="rounded-lg px-3 py-1 text-sm text-muted hover:bg-hover"
              onClick={() => setOpen(false)}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** "Отмени разрешението": the phone is checked by the country's rule again. */
export function PhoneWaiverRevoke({
  orderId,
  reason,
  at,
}: {
  orderId: string;
  reason: string | null;
  at: string | null;
}) {
  const t = useTranslations("orders.phoneWaiver");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="mt-1 flex flex-col items-start gap-1 text-xs">
      {reason && (
        <span className="text-muted" data-testid="phone-waiver-reason-shown">
          {t("given", { reason, at: at ?? "" })}
        </span>
      )}
      {err && <span className="text-block">{err}</span>}
      <button
        type="button"
        className="mt-2 rounded-lg px-2 py-0.5 text-xs text-block underline hover:bg-hover"
        disabled={pending}
        data-testid="phone-waiver-revoke"
        onClick={() =>
          start(async () => {
            if (!window.confirm(t("revokeConfirm"))) return;
            const r = await revokeOrderPhoneAction(orderId);
            if (r?.error) {
              setErr(t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : t("errors.failed"));
              return;
            }
            router.refresh();
          })
        }
      >
        {t("revoke")}
      </button>
    </div>
  );
}
