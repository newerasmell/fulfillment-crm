import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { LineChip } from "@/components/ui/LineChip";
import { tdCls, thCls } from "@/components/ui/form";
import { requireAccountContext } from "@/server/auth/session";
import { accountDb } from "@/server/db/client";
import { lineCoverage } from "@/server/lines/coverage";
import { listLines } from "@/server/lines/lines";
import { CoverageSummary } from "../../products/lines/coverage";
import { CompanyLineForm, EditLineForm, NewLineForm } from "./forms";

/** Настройки → Линии и фирми (P5-00): product lines of the group and which line each company sells. */
export default async function LinesSettingsPage() {
  const ctx = await requireAccountContext("lines.manage");
  const t = await getTranslations("lines");
  const lines = await listLines(ctx.accountId, { includeArchived: true });
  const companies = await accountDb(ctx.accountId).company.findMany({
    where: { archivedAt: null },
    select: {
      id: true,
      name: true,
      lineId: true,
      _count: { select: { stores: true, connections: true } },
    },
    orderBy: { name: "asc" },
  });
  const active = lines.filter((l) => !l.archivedAt);
  const coverage = await Promise.all(active.map((l) => lineCoverage(ctx.accountId, l.id)));
  const lineless = companies.filter((c) => !c.lineId);
  return (
    <>
      <PageHeader title={t("settingsTitle")} subtitle={t("settingsIntro")} />
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("linesTitle", { count: active.length })}</h2>
        {lines.length === 0 ? (
          <p className="m-0 text-muted">{t("noLines")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>{t("line")}</th>
                  <th className={thCls}>{t("companies")}</th>
                  <th className={thCls}>{t("coverage")}</th>
                  <th className={thCls}>{t("edit")}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const cov = coverage[active.findIndex((a) => a.id === l.id)];
                  return (
                    <tr key={l.id} data-testid={`line-row-${l.name}`}>
                      <td className={tdCls}>
                        <LineChip name={l.name} color={l.color} />
                        {l.archivedAt && <span className="ml-2 text-xs text-muted">{t("archived")}</span>}
                      </td>
                      <td className={tdCls}>
                        {companies
                          .filter((c) => c.lineId === l.id)
                          .map((c) => c.name)
                          .join(", ") || "—"}
                      </td>
                      <td className={tdCls}>
                        {cov ? (
                          <Link href={`/products/lines?line=${l.id}`} className="text-ink no-underline">
                            <CoverageSummary coverage={cov} />
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={tdCls}>
                        <EditLineForm
                          line={{
                            id: l.id,
                            name: l.name,
                            color: l.color,
                            sortOrder: l.sortOrder,
                            archived: !!l.archivedAt,
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <NewLineForm />
      </Card>
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("companiesTitle")}</h2>
        <p className="mt-0 text-[13px] text-muted">{t("companiesIntro")}</p>
        {lineless.length > 0 && active.length > 0 && (
          <p role="note" className="mt-0 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">
            {t("linelessWarning", { count: lineless.length })}
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>{t("company")}</th>
                <th className={thCls}>{t("storesAndWarehouses")}</th>
                <th className={thCls}>{t("line")}</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id}>
                  <td className={tdCls}>{c.name}</td>
                  <td className={`${tdCls} text-muted`}>
                    {t("counts", { stores: c._count.stores, connections: c._count.connections })}
                  </td>
                  <td className={tdCls}>
                    <CompanyLineForm
                      company={{ id: c.id, name: c.name, lineId: c.lineId }}
                      lines={active.map((l) => ({ id: l.id, name: l.name }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
