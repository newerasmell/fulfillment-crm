"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { enrolAction } from "@/app/actions/invitations";

const input =
  "min-h-11 w-full rounded-[10px] border border-line bg-surface px-3 outline-none focus:border-accent";

export function EnrolForm({
  token,
  secret,
  otpauthUri,
  defaultName,
}: {
  token: string;
  secret: string;
  otpauthUri: string;
  defaultName: string;
}) {
  const t = useTranslations("invite");
  const [state, action, pending] = useActionState(enrolAction.bind(null, token), undefined);
  const known = ["invalid_code", "password_mismatch", "invalid", "invalid_invitation"];
  return (
    <form action={action} className="flex flex-col gap-4">
      <section className="flex flex-col gap-2 rounded-xl border border-line bg-bg p-4">
        <span className="font-semibold">{t("step2fa")}</span>
        <a href={otpauthUri} className="font-semibold">
          {t("openApp")}
        </a>
        <span className="text-xs text-muted">{t("secret")}</span>
        <code className="font-mono text-sm break-all select-all" data-testid="totp-secret">
          {secret}
        </code>
      </section>
      <section className="flex flex-col gap-3">
        <span className="font-semibold">{t("step2")}</span>
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          {t("name")}
          <input name="name" required defaultValue={defaultName} autoComplete="name" className={input} />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          {t("password")}
          <input
            name="password"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            className={input}
          />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          {t("passwordRepeat")}
          <input
            name="passwordRepeat"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            className={input}
          />
        </label>
      </section>
      <label className="flex flex-col gap-1 text-[13px] font-medium">
        <span className="font-semibold">{t("code")}</span>
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          className={`${input} font-mono tracking-widest`}
        />
      </label>
      {state?.error && (
        <p role="alert" className="m-0 rounded-lg bg-block-bg px-3 py-2 text-block">
          {t(`errors.${known.includes(state.error) ? state.error : "invalid"}`)}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 rounded-[10px] bg-accent font-semibold text-white hover:bg-accent-strong disabled:opacity-60"
      >
        {t("submit")}
      </button>
    </form>
  );
}
