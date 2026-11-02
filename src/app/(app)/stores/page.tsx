import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { tdCls, thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { requireAccountContext } from "@/server/auth/session";
import { accountDb } from "@/server/db/client";
import { listStores } from "@/server/stores";
import { ConnectionBadge } from "./status";
import { NewStoreForm } from "./forms";

export default async function StoresPage() {
  const ctx = await requireAccountContext();
  const t = await getTranslations("stores");
  const stores = await listStores(ctx);
  const manage = can(ctx.role, "stores.manage");
  const credentials = manage
    ? await accountDb(ctx.accountId).credential.findMany({
        where: { label: { startsWith: "Shopify app" } },
        select: { id: true, label: true, hint: true },
        orderBy: { label: "asc" },
      })
    : [];
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("intro")} />
      <Card>
        {stores.length === 0 ? (
          <p className="m-0 text-muted">{t("empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>{t("name")}</th>
                  <th className={thCls}>{t("company")}</th>
                  <th className={thCls}>{t("domain")}</th>
                  <th className={thCls}>{t("code")}</th>
                  <th className={thCls}>{t("connection")}</th>
                  <th className={thCls}>{t("writeBackMode")}</th>
                </tr>
              </thead>
              <tbody>
                {stores.map((s) => (
                  <tr key={s.id}>
                    <td className={tdCls}>
                      <Link href={`/stores/${s.id}`} className="font-medium text-accent hover:underline">
                        {s.name}
                      </Link>
                    </td>
                    <td className={tdCls}>{s.company?.name ?? "—"}</td>
                    <td className={`${tdCls} font-mono text-[13px]`}>{s.domain}</td>
                    <td className={`${tdCls} font-mono`}>{s.code}</td>
                    <td className={tdCls}>
                      <ConnectionBadge status={s.connectionStatus} />
                    </td>
                    <td className={tdCls}>{t(`writeModes.${s.writeBackMode}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {manage && ctx.companies.length > 0 && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("add")}</h2>
          <p className="mt-0 text-sm text-muted">{t("addHelp")}</p>
          <NewStoreForm companies={ctx.companies} credentials={credentials} />
        </Card>
      )}
    </>
  );
}
