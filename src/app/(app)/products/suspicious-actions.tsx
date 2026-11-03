"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { confirmSuspiciousAction, unlinkSuspiciousAction } from "@/app/actions/suspicious";
import { buttonCls, ghostButtonCls } from "@/components/ui/form";

const KNOWN_ERRORS = ["forbidden", "invalid", "not_found", "link_changed"];

/** Потвърди (същият продукт е) / Развържи (asks once more: it removes the link). */
export function SuspiciousActions({ id, label }: { id: string; label: string }) {
  const t = useTranslations("suspicious");
  const [confirmState, confirmAction, confirming] = useActionState(
    confirmSuspiciousAction.bind(null, id),
    undefined,
  );
  const [unlinkState, unlinkAction, unlinking] = useActionState(
    unlinkSuspiciousAction.bind(null, id),
    undefined,
  );
  const [askUnlink, setAskUnlink] = useState(false);
  const error = confirmState?.error ?? unlinkState?.error;
  const done = confirmState?.ok ?? unlinkState?.ok;
  if (done)
    return (
      <span role="status" className="text-sm text-ok">
        {t(done === "confirmed" ? "confirmed" : "unlinked")}
      </span>
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={confirmAction}>
        <button
          type="submit"
          disabled={confirming || unlinking}
          className={buttonCls}
          aria-label={t("confirmAria", { label })}
        >
          {t("confirm")}
        </button>
      </form>
      {askUnlink ? (
        <form action={unlinkAction} className="flex items-center gap-2">
          <button
            type="submit"
            disabled={confirming || unlinking}
            className={`${ghostButtonCls} text-block`}
            aria-label={t("unlinkSureAria", { label })}
          >
            {t("unlinkSure")}
          </button>
          <button type="button" className={ghostButtonCls} onClick={() => setAskUnlink(false)}>
            {t("cancel")}
          </button>
        </form>
      ) : (
        <button
          type="button"
          className={ghostButtonCls}
          onClick={() => setAskUnlink(true)}
          aria-label={t("unlinkAria", { label })}
        >
          {t("unlink")}
        </button>
      )}
      {error && (
        <span role="alert" className="text-sm text-block">
          {t(`errors.${KNOWN_ERRORS.includes(error) ? error : "other"}`)}
        </span>
      )}
    </div>
  );
}
