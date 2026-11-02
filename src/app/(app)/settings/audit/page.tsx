import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { tdCls, thCls } from "@/components/ui/form";
import { listAudit } from "@/server/audit";
import { requireAccountContext } from "@/server/auth/session";
import { systemDb } from "@/server/db/client";

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const ctx = await requireAccountContext("audit.read");
  const t = await getTranslations("audit");
  const format = await getFormatter();
  const { cursor } = await searchParams;
  const { rows, nextCursor } = await listAudit(ctx.accountId, { take: 50, cursor });
  const userIds = [...new Set(rows.map((r) => r.userId).filter((v): v is string => !!v))];
  // Users are global; only names of users that appear in this account's log are looked up.
  const users = await systemDb().user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true },
  });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return (
    <>
      <PageHeader title={t("title")} />
      <Card>
        {rows.length === 0 ? (
          <p className="m-0 text-muted">{t("empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>{t("when")}</th>
                  <th className={thCls}>{t("who")}</th>
                  <th className={thCls}>{t("action")}</th>
                  <th className={thCls}>{t("entity")}</th>
                  <th className={thCls}>{t("details")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className={`${tdCls} font-mono text-[13px] whitespace-nowrap`}>
                      {format.dateTime(r.createdAt, { dateStyle: "short", timeStyle: "medium" })}
                    </td>
                    <td className={tdCls}>{r.userId ? (names.get(r.userId) ?? r.userId) : "—"}</td>
                    <td className={`${tdCls} font-mono text-[13px]`}>{r.action}</td>
                    <td className={`${tdCls} text-muted`}>{r.entityType ?? "—"}</td>
                    <td className={`${tdCls} max-w-md truncate font-mono text-xs text-muted`}>
                      {r.after ? JSON.stringify(r.after) : r.before ? JSON.stringify(r.before) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextCursor && (
          <Link href={`?cursor=${nextCursor}`} className="mt-3 inline-block">
            {t("more")}
          </Link>
        )}
      </Card>
    </>
  );
}
