import { getFormatter, getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { tdCls, thCls } from "@/components/ui/form";
import { listMembers } from "@/server/accounts";
import { can, canAssignRole, ROLES } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { switchAccountAction } from "@/app/actions/session";
import { AddMemberForm, MemberRow, NewAccountForm } from "./forms";

export default async function MembersPage() {
  const ctx = await requireAccountContext();
  const t = await getTranslations();
  const format = await getFormatter();
  const members = await listMembers(actorFrom(ctx));
  const manage = can(ctx.role, "members.manage");
  const assignable = ROLES.filter((r) => canAssignRole(ctx.role, r));
  const roleLabels = Object.fromEntries(ROLES.map((r) => [r, t(`roles.${r}`)]));

  return (
    <>
      <PageHeader title={t("members.title")} />
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("members.accounts")}</h2>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {ctx.memberships.map((m) => (
            <li key={m.accountId} className="flex min-h-11 items-center gap-3 border-b border-line-soft">
              <span className="font-medium">{m.accountName}</span>
              <span className="text-muted">{t(`roles.${m.role}`)}</span>
              {m.accountId === ctx.accountId ? (
                <span className="ml-auto rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent-strong">
                  {t("members.current")}
                </span>
              ) : (
                <form action={switchAccountAction.bind(null, m.accountId)} className="ml-auto">
                  <button type="submit" className="min-h-9 rounded-lg border border-line px-3">
                    {t("members.switch")}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
        {can(ctx.role, "account.create") && <NewAccountForm />}
      </Card>

      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("members.people", { account: ctx.accountName })}</h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>{t("members.name")}</th>
                <th className={thCls}>{t("members.email")}</th>
                <th className={thCls}>{t("members.role")}</th>
                <th className={thCls}>{t("members.since")}</th>
                {manage && <th className={thCls} />}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td className={tdCls}>{m.user.name}</td>
                  <td className={`${tdCls} font-mono text-[13px]`}>{m.user.email}</td>
                  {manage && canAssignRole(ctx.role, m.role) ? (
                    <MemberRow
                      membershipId={m.id}
                      role={m.role}
                      assignable={assignable}
                      roleLabels={roleLabels}
                      since={format.dateTime(m.createdAt, { dateStyle: "medium" })}
                    />
                  ) : (
                    <>
                      <td className={tdCls}>{t(`roles.${m.role}`)}</td>
                      <td className={`${tdCls} text-muted`}>
                        {format.dateTime(m.createdAt, { dateStyle: "medium" })}
                      </td>
                      {manage && <td className={tdCls} />}
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {manage && <AddMemberForm assignable={assignable} roleLabels={roleLabels} />}
      </Card>
    </>
  );
}
