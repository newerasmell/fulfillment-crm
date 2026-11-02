"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import type { Role } from "@/generated/prisma/client";
import { createCompanyAction, setMemberCompaniesAction } from "@/app/actions/companies";
import { changeRoleAction, inviteMemberAction, removeMemberAction } from "@/app/actions/members";
import { buttonCls, ghostButtonCls, inputCls, labelCls, tdCls } from "@/components/ui/form";

type Company = { id: string; name: string };

function ErrorText({ code }: { code?: string }) {
  const t = useTranslations("members.errors");
  if (!code) return null;
  const known = [
    "already_member",
    "last_owner",
    "forbidden",
    "not_found",
    "invalid",
    "company_exists",
    "owner_sees_all",
  ];
  return (
    <p role="alert" className="m-0 rounded-lg bg-block-bg px-3 py-2 text-block">
      {t(known.includes(code) ? code : "invalid")}
    </p>
  );
}

/** Checkbox list of companies; nothing ticked = all companies. */
function CompanyChecks({ companies, selected = [] }: { companies: Company[]; selected?: string[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {companies.map((c) => (
        <label key={c.id} className="flex min-h-9 items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            name="companyIds"
            value={c.id}
            defaultChecked={selected.includes(c.id)}
            className="size-4"
          />
          {c.name}
        </label>
      ))}
    </div>
  );
}

export function NewCompanyForm() {
  const t = useTranslations("members");
  const [state, action, pending] = useActionState(createCompanyAction, undefined);
  return (
    <form action={action} className="mt-4 flex flex-wrap items-end gap-3">
      <label className={labelCls}>
        {t("companyName")}
        <input name="name" required minLength={2} className={`${inputCls} w-72`} />
      </label>
      <button type="submit" disabled={pending} className={buttonCls}>
        {t("createCompany")}
      </button>
      <ErrorText code={state?.error} />
    </form>
  );
}

/** The member's company access: summary text, and (for managers) an explicit all / limited editor. */
export function MemberCompanies({
  membershipId,
  companies,
  selected,
  editable,
  summary,
}: {
  membershipId: string;
  companies: Company[];
  selected: string[];
  editable: boolean;
  summary: string;
}) {
  const t = useTranslations("members");
  const [state, action, pending] = useActionState(setMemberCompaniesAction, undefined);
  if (!editable) return <span className="text-muted">{summary}</span>;
  return (
    <details>
      <summary className="cursor-pointer">
        {summary} <span className="text-accent">· {t("editScope")}</span>
      </summary>
      <form action={action} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="membershipId" value={membershipId} />
        <label className="flex min-h-9 items-center gap-2 text-[13px]">
          <input
            type="radio"
            name="access"
            value="all"
            defaultChecked={selected.length === 0}
            className="size-4"
          />
          {t("allCompanies")}
        </label>
        <label className="flex min-h-9 items-center gap-2 text-[13px]">
          <input
            type="radio"
            name="access"
            value="limited"
            defaultChecked={selected.length > 0}
            className="size-4"
          />
          {t("onlySelected")}
        </label>
        <div className="pl-6">
          <CompanyChecks companies={companies} selected={selected} />
        </div>
        <button type="submit" disabled={pending} className={`${ghostButtonCls} self-start`}>
          {t("save")}
        </button>
        <ErrorText code={state?.error} />
      </form>
    </details>
  );
}

export function MemberRow({
  membershipId,
  role,
  assignable,
  roleLabels,
  since,
  companiesCell,
}: {
  membershipId: string;
  role: Role;
  assignable: readonly Role[];
  roleLabels: Record<string, string>;
  since: string;
  companiesCell: React.ReactNode;
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
      <td className={tdCls}>{companiesCell}</td>
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

export function InviteForm({
  assignable,
  roleLabels,
  companies,
}: {
  assignable: readonly Role[];
  roleLabels: Record<string, string>;
  companies: Company[];
}) {
  const t = useTranslations("members");
  const [state, action, pending] = useActionState(inviteMemberAction, undefined);
  const link =
    state?.invitePath && typeof window !== "undefined"
      ? `${window.location.origin}${state.invitePath}`
      : undefined;
  return (
    <div className="mt-5 flex flex-col gap-3">
      <h3 className="m-0 text-sm font-semibold">{t("add")}</h3>
      <form action={action} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className={labelCls}>
            {t("name")}
            <input name="name" className={`${inputCls} w-56`} />
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
        </div>
        {companies.length > 1 && (
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className="mb-1 text-[13px] font-medium">{t("inviteCompanies")}</legend>
            <CompanyChecks companies={companies} />
            <span className="text-xs text-muted">{t("inviteScopeHint")}</span>
          </fieldset>
        )}
        <button type="submit" disabled={pending} className={`${buttonCls} self-start`}>
          {t("addSubmit")}
        </button>
      </form>
      <ErrorText code={state?.error} />
      {link && (
        <div role="status" className="rounded-xl border border-warn bg-warn-bg p-4">
          <p className="mt-0 font-semibold text-warn">
            {t("inviteTitle", { email: state?.inviteEmail ?? "" })}
          </p>
          <p className="text-[13px]">{t("inviteBody")}</p>
          <p className="m-0 font-mono text-xs break-all select-all" data-testid="invite-link">
            {link}
          </p>
        </div>
      )}
    </div>
  );
}
