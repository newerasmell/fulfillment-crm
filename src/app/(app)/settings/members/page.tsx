import { getFormatter, getTranslations } from "next-intl/server";
import { revokeInvitationAction } from "@/app/actions/members";
import { setCompanyArchivedAction } from "@/app/actions/companies";
import { switchAccountAction } from "@/app/actions/session";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, tdCls, thCls } from "@/components/ui/form";
import { listMembers } from "@/server/accounts";
import { can, canAssignRole, ROLES } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { listCompanies } from "@/server/companies";
import { listOpenInvitations } from "@/server/invitations";
import { InviteForm, MemberCompanies, MemberRow, NewCompanyForm } from "./forms";

export default async function MembersPage() {
  const ctx = await requireAccountContext();
  const t = await getTranslations();
  const format = await getFormatter();
  const actor = actorFrom(ctx);
  const members = await listMembers(actor);
  const manage = can(ctx.role, "members.manage");
  const assignable = ROLES.filter((r) => canAssignRole(ctx.role, r));
  const roleLabels = Object.fromEntries(ROLES.map((r) => [r, t(`roles.${r}`)]));
  const invitations = manage ? await listOpenInvitations(actor) : [];
  const companies = await listCompanies(actor, { includeArchived: can(ctx.role, "companies.archive") });
  const active = companies.filter((c) => !c.archivedAt);
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  const scopeSummary = (ids: string[]) =>
    ids.length ? ids.map((id) => companyName.get(id) ?? "—").join(", ") : t("members.allCompanies");

  return (
    <>
      <PageHeader title={t("members.title")} subtitle={ctx.accountName} />
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("members.companies")}</h2>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {companies.map((c) => (
            <li key={c.id} className="flex min-h-11 items-center gap-3 border-b border-line-soft">
              <span className={`font-medium ${c.archivedAt ? "text-muted line-through" : ""}`}>{c.name}</span>
              {c.archivedAt && (
                <span className="rounded-full bg-hover px-2 py-0.5 text-xs text-muted">
                  {t("members.archived")}
                </span>
              )}
              {can(ctx.role, "companies.archive") && (
                <form action={setCompanyArchivedAction.bind(null, c.id, !c.archivedAt)} className="ml-auto">
                  <button type="submit" className={ghostButtonCls}>
                    {c.archivedAt ? t("members.unarchive") : t("members.archive")}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
        {can(ctx.role, "companies.manage") && <NewCompanyForm />}
      </Card>

      {ctx.memberships.length > 1 && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("members.groups")}</h2>
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
        </Card>
      )}

      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("members.people", { account: ctx.accountName })}</h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>{t("members.name")}</th>
                <th className={thCls}>{t("members.email")}</th>
                <th className={thCls}>{t("members.role")}</th>
                <th className={thCls}>{t("members.companiesCol")}</th>
                <th className={thCls}>{t("members.since")}</th>
                {manage && <th className={thCls} />}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const ids = m.companies.map((c) => c.companyId);
                const companiesCell = (
                  <MemberCompanies
                    membershipId={m.id}
                    companies={active}
                    selected={ids}
                    editable={
                      manage && m.role !== "OWNER" && canAssignRole(ctx.role, m.role) && active.length > 1
                    }
                    summary={m.role === "OWNER" ? t("members.allCompanies") : scopeSummary(ids)}
                  />
                );
                const since = format.dateTime(m.createdAt, { dateStyle: "medium" });
                return (
                  <tr key={m.id}>
                    <td className={tdCls}>{m.user.name}</td>
                    <td className={`${tdCls} font-mono text-[13px]`}>{m.user.email}</td>
                    {manage && canAssignRole(ctx.role, m.role) ? (
                      <MemberRow
                        membershipId={m.id}
                        role={m.role}
                        assignable={assignable}
                        roleLabels={roleLabels}
                        since={since}
                        companiesCell={companiesCell}
                      />
                    ) : (
                      <>
                        <td className={tdCls}>{t(`roles.${m.role}`)}</td>
                        <td className={tdCls}>{companiesCell}</td>
                        <td className={`${tdCls} text-muted`}>{since}</td>
                        {manage && <td className={tdCls} />}
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {invitations.length > 0 && (
          <div className="mt-5">
            <h3 className="mt-0 mb-2 text-sm font-semibold">{t("members.openInvitations")}</h3>
            <ul className="m-0 flex list-none flex-col p-0">
              {invitations.map((i) => (
                <li
                  key={i.id}
                  className="flex min-h-11 flex-wrap items-center gap-3 border-b border-line-soft"
                >
                  <span className="font-mono text-[13px]">{i.email}</span>
                  <span className="text-muted">{t(`roles.${i.role}`)}</span>
                  <span className="text-xs text-muted">
                    {t("members.expires", {
                      date: format.dateTime(i.expiresAt, { dateStyle: "medium", timeStyle: "short" }),
                    })}
                  </span>
                  <form action={revokeInvitationAction.bind(null, i.id)} className="ml-auto">
                    <button type="submit" className="min-h-9 rounded-lg border border-line px-3 text-block">
                      {t("members.revoke")}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </div>
        )}
        {manage && <InviteForm assignable={assignable} roleLabels={roleLabels} companies={active} />}
      </Card>
    </>
  );
}
