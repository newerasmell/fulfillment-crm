"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { loginAction } from "@/app/actions/session";

const input =
  "min-h-11 w-full rounded-[10px] border border-line bg-surface px-3 outline-none focus:border-accent";

export function LoginForm() {
  const t = useTranslations("login");
  const [state, action, pending] = useActionState(loginAction, undefined);
  const known = ["invalid", "rate_limited", "totp_required"];
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-[13px] font-medium">{t("email")}</span>
        <input name="email" type="email" autoComplete="username" required className={input} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[13px] font-medium">{t("password")}</span>
        <input name="password" type="password" autoComplete="current-password" required className={input} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[13px] font-medium">{t("code")}</span>
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          required
          className={`${input} font-mono tracking-widest`}
        />
        <span className="text-xs text-muted">{t("codeHint")}</span>
      </label>
      {state?.error && (
        <p role="alert" className="m-0 rounded-lg bg-block-bg px-3 py-2 text-block">
          {t(`errors.${known.includes(state.error) ? state.error : "invalid"}`)}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="mt-1 min-h-11 rounded-[10px] bg-accent font-semibold text-white hover:bg-accent-strong disabled:opacity-60"
      >
        {t("submit")}
      </button>
    </form>
  );
}
