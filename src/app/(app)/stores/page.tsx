import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ShopifySetupGuide } from "./setup-guide";
import { tdCls, thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { requireAccountContext } from "@/server/auth/session";
import { accountDb } from "@/server/db/client";
import { listStores } from "@/server/stores";
import { ConnectionBadge } from "./status";
import { NewStoreForm } from "./forms";

export default async function StoresPage({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const ctx = await requireAccountContext();
  const t = await getTranslations("stores");
  const { deleted } = await searchParams;
  const all = await listStores(ctx, { includeArchived: true });
  const stores = all.filter((s) => !s.archivedAt);
  const archived = all.filter((s) => s.archivedAt);
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
      {deleted && (
        <p role="status" className="m-0 rounded-lg bg-ok-bg px-3 py-2 text-ok">
          {t("deleted")}
        </p>
      )}
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
      {archived.length > 0 && (
        <Card>
          <details>
            <summary className="cursor-pointer font-semibold">
              {t("archivedSection", { count: archived.length })}
            </summary>
            <ul className="mt-3 mb-0 flex list-none flex-col gap-2 p-0">
              {archived.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-3">
                  <Link href={`/stores/${s.id}`} className="font-medium text-accent hover:underline">
                    {s.name}
                  </Link>
                  <span className="text-muted">{s.company?.name ?? "—"}</span>
                  <span className="font-mono text-[13px] text-muted">{s.domain}</span>
                  <span className="font-mono">{s.code}</span>
                </li>
              ))}
            </ul>
          </details>
        </Card>
      )}
      {manage && ctx.companies.length > 0 && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("add")}</h2>
          <p className="mt-0 text-sm text-muted">{t("addHelp")}</p>
          <div className="mb-4">
            <ShopifySetupGuide open />
          </div>
          <NewStoreForm companies={ctx.companies} credentials={credentials} />
        </Card>
      )}
    </>
  );
}
