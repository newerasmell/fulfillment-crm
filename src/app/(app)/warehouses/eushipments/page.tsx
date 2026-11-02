import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { tdCls, thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { requireAccountContext } from "@/server/auth/session";
import { EuVendorIds } from "@/server/eushipments/connection";
import { euCredentials, listEuConnections } from "@/server/eushipments/connections";
import { NewEuConnectionForm } from "./forms";
import { Freshness, TestBadge, WarehouseChip } from "./ui";

export default async function EuShipmentsConnectionsPage() {
  const ctx = await requireAccountContext();
  const t = await getTranslations();
  const connections = await listEuConnections(ctx);
  const manage = can(ctx.role, "connections.manage");
  const credentials = manage ? await euCredentials(ctx.accountId) : [];
  return (
    <>
      <PageHeader
        title={t("eushipments.title")}
        subtitle={t("eushipments.intro")}
        actions={
          <Link href="/warehouses" className="text-accent hover:underline">
            ← {t("pages.warehouses")}
          </Link>
        }
      />
      <Card>
        {connections.length === 0 ? (
          <p className="m-0 text-muted">{t("eushipments.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>{t("eushipments.name")}</th>
                  <th className={thCls}>{t("eushipments.company")}</th>
                  <th className={thCls}>{t("eushipments.vendorCompany")}</th>
                  <th className={thCls}>{t("eushipments.mode")}</th>
                  <th className={thCls}>{t("eushipments.test")}</th>
                  <th className={thCls}>{t("eushipments.stockAge")}</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => {
                  const ids = EuVendorIds.safeParse(c.vendorIds);
                  const vendorCompanyId = ids.success ? ids.data.companyId : null;
                  const vc = c.eushipmentsVendorCompanies.find((v) => v.vendorCompanyId === vendorCompanyId);
                  const sync = (k: string) => c.eushipmentsSyncs.find((s) => s.kind === k);
                  return (
                    <tr key={c.id}>
                      <td className={tdCls}>
                        <span className="flex items-center gap-2">
                          <WarehouseChip />
                          <Link
                            href={`/warehouses/eushipments/${c.id}`}
                            className="font-medium text-accent hover:underline"
                          >
                            {c.name}
                          </Link>
                        </span>
                      </td>
                      <td className={tdCls}>{c.company?.name ?? "—"}</td>
                      <td className={`${tdCls} font-mono text-[13px]`}>
                        {vendorCompanyId ? `${vc?.name ?? ""} ${vendorCompanyId}`.trim() : "—"}
                      </td>
                      <td className={`${tdCls} font-semibold`}>{t(`mode.${c.liveMode}`)}</td>
                      <td className={tdCls}>
                        <TestBadge sync={sync("connection")} />
                      </td>
                      <td className={tdCls}>
                        <Freshness at={sync("stock")?.lastOkAt ?? null} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {manage && ctx.companies.length > 0 && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("eushipments.add")}</h2>
          <p className="mt-0 text-sm text-muted">{t("eushipments.addHelp")}</p>
          <NewEuConnectionForm companies={ctx.companies} credentials={credentials} />
        </Card>
      )}
    </>
  );
}
