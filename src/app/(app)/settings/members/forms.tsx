"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import type { Role } from "@/generated/prisma/client";
import {
  addMemberAction,
  changeRoleAction,
  createAccountAction,
  removeMemberAction,
} from "@/app/actions/members";
import { buttonCls, ghostButtonCls, inputCls, labelCls, tdCls } from "@/components/ui/form";

function ErrorText({ code }: { code?: string }) {
  const t = useTranslations("members.errors");
  if (!code) return null;
  const known = ["already_member", "last_owner", "forbidden", "not_found", "invalid"];
  return (
    <p role="alert" className="m-0 rounded-lg bg-block-bg px-3 py-2 text-block">
      {t(known.includes(code) ? code : "invalid")}
    </p>
  );
}

export function NewAccountForm() {
  const t = useTranslations("members");
  const [state, action, pending] = useActionState(createAccountAction, undefined);
  return (
    <form action={action} className="mt-4 flex flex-wrap items-end gap-3">
      <label className={labelCls}>
        {t("accountName")}
        <input name="name" required minLength={2} className={`${inputCls} w-72`} />
      </label>
      <button type="submit" disabled={pending} className={buttonCls}>
        {t("createAccount")}
      </button>
      <ErrorText code={state?.error} />
    </form>
  );
}

export function MemberRow({
  membershipId,
  role,
  assignable,
  roleLabels,
  since,
}: {
  membershipId: string;
  role: Role;
  assignable: readonly Role[];
  roleLabels: Record<string, string>;
  since: string;
}) {
  const t = useTranslations("members");
  const [changeState, change, changing] = useActionState(changeRoleAction, undefined);
  const [removeState, remove, removing] = useActionState(removeMemberAction, undefined);
  return (
    <>
      <td className={tdCls}>
        <form action={change} className="flex items-center gap-2">
          <input type="hidden" name="membershipId" value={membershipId} />
          <select name="role" defaultValue={role} aria-label={t("role")} className={`${inputCls} min-h-9`}>
            {assignable.map((r) => (
              <option key={r} value={r}>
                {roleLabels[r]}
              </option>
            ))}
          </select>
          <button type="submit" disabled={changing} className={ghostButtonCls}>
            {t("save")}
          </button>
        </form>
        <ErrorText code={changeState?.error ?? removeState?.error} />
      </td>
      <td className={`${tdCls} text-muted`}>{since}</td>
      <td className={tdCls}>
        <form action={remove}>
          <input type="hidden" name="membershipId" value={membershipId} />
          <button type="submit" disabled={removing} className={`${ghostButtonCls} text-block`}>
            {t("remove")}
          </button>
        </form>
      </td>
    </>
  );
}

export function AddMemberForm({
  assignable,
  roleLabels,
}: {
  assignable: readonly Role[];
  roleLabels: Record<string, string>;
}) {
  const t = useTranslations("members");
  const [state, action, pending] = useActionState(addMemberAction, undefined);
  return (
    <div className="mt-5 flex flex-col gap-3">
      <h3 className="m-0 text-sm font-semibold">{t("add")}</h3>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <label className={labelCls}>
          {t("name")}
          <input name="name" required className={`${inputCls} w-56`} />
        </label>
        <label className={labelCls}>
          {t("email")}
          <input name="email" type="email" required className={`${inputCls} w-64`} />
        </label>
        <label className={labelCls}>
          {t("role")}
          <select name="role" defaultValue="OPERATOR" className={inputCls}>
            {assignable.map((r) => (
              <option key={r} value={r}>
                {roleLabels[r]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={pending} className={buttonCls}>
          {t("addSubmit")}
        </button>
      </form>
      <ErrorText code={state?.error} />
      {state?.existingUser && <p className="m-0 text-ok">{t("existingUser")}</p>}
      {state?.onboarding && (
        <div role="status" className="rounded-xl border border-warn bg-warn-bg p-4">
          <p className="mt-0 font-semibold text-warn">{t("onboardingTitle")}</p>
          <p className="text-[13px]">{t("onboardingBody")}</p>
          <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted">{t("email")}</dt>
            <dd className="m-0 font-mono">{state.onboarding.email}</dd>
            {state.onboarding.password && (
              <>
                <dt className="text-muted">{t("password")}</dt>
                <dd className="m-0 font-mono select-all">{state.onboarding.password}</dd>
              </>
            )}
            <dt className="text-muted">{t("totpUri")}</dt>
            <dd className="m-0 font-mono text-xs break-all select-all">{state.onboarding.otpauthUri}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}
