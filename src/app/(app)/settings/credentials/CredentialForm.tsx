"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { saveCredentialAction } from "@/app/actions/credentials";
import { buttonCls, ghostButtonCls, inputCls, labelCls } from "@/components/ui/form";

/** Write-only secret field: never pre-filled, never echoed back. */
export function CredentialForm({
  credentialId,
  label,
  compact,
}: {
  credentialId?: string;
  label?: string;
  compact?: boolean;
}) {
  const t = useTranslations("credentials");
  const [state, action, pending] = useActionState(saveCredentialAction, undefined);
  const [open, setOpen] = useState(!compact);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={ghostButtonCls}>
        {t("rotate")}
      </button>
    );
  }
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      {credentialId && <input type="hidden" name="credentialId" value={credentialId} />}
      <label className={labelCls}>
        {t("label")}
        <input
          name="label"
          required
          defaultValue={label}
          readOnly={!!credentialId}
          className={`${inputCls} w-56`}
        />
      </label>
      <label className={labelCls}>
        {t("secret")}
        <input name="secret" type="password" required autoComplete="off" className={`${inputCls} w-72`} />
        <span className="text-xs font-normal text-muted">{t("secretHint")}</span>
      </label>
      <button type="submit" disabled={pending} className={buttonCls}>
        {t("save")}
      </button>
      {state?.hint && <span className="text-ok">{t("saved", { hint: state.hint })}</span>}
      {state?.error && <span className="text-block">{state.error}</span>}
    </form>
  );
}
