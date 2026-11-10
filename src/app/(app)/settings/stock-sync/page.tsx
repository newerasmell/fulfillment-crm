import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ConnectionChip } from "@/app/(app)/products/stock/ui";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { LineChip } from "@/components/ui/LineChip";
import { tdCls, thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { stockSyncOverview } from "@/server/stock/guard";
import { LineGuardForm } from "./guard-form";

/**
 * "Синхронизация на наличности" (owner request 2026-11-10): per product line the anti-sabotage rule and the stock
 * groups — the stores that sell one warehouse's stock and so show (and lose) the same units.
 */
export default async function StockSyncPage() {
  const ctx = await requireAccountContext("inventory.push");
  const t = await getTranslations("stockSync");
  const groups = await stockSyncOverview(actorFrom(ctx));
  const canEdit = can(ctx.role, "lines.manage");
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("intro")} />
      {groups.map((g) => (
        <Card key={g.lineId ?? "none"}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {g.lineName ? (
              <LineChip name={g.lineName} color={g.lineColor ?? "rose"} />
            ) : (
              <span className="font-semibold">{t("noLine")}</span>
            )}
          </div>
          {g.lineId && <LineGuardForm lineId={g.lineId} guard={g.guard} canEdit={canEdit} />}
          <h3 className="mb-2 mt-4 text-sm font-semibold">{t("groups")}</h3>
          {g.warehouses.length === 0 ? (
            <p className="m-0 text-sm text-muted">{t("noWarehouses")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse" aria-label={t("groups")}>
                <thead>
                  <tr>
                    <th className={thCls}>{t("warehouse")}</th>
                    <th className={thCls}>{t("stores")}</th>
                  </tr>
                </thead>
                <tbody>
                  {g.warehouses.map((w) => (
                    <tr key={w.id}>
                      <td className={`${tdCls} align-top`}>
                        <ConnectionChip type={w.type} name={w.name} />
                      </td>
                      <td className={tdCls}>
                        {w.stores.length === 0 ? (
                          <span className="text-sm text-muted">{t("noStores")}</span>
                        ) : (
                          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                            {w.stores.map((s) => (
                              <li key={s.id}>
                                <Link
                                  href={`/stores/${s.id}/inventory`}
                                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm no-underline ${
                                    s.pushMode === "LIVE"
                                      ? "border-ok text-ink"
                                      : s.pushMode === "DRY_RUN"
                                        ? "border-warn text-ink"
                                        : "border-line text-muted"
                                  }`}
                                  title={t("bufferHint", { n: s.buffer })}
                                >
                                  {s.name}
                                  <span className="text-xs text-muted">· {t(`mode.${s.pushMode}`)}</span>
                                </Link>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ))}
      <Card>
        <p className="m-0 text-xs text-muted">{t("how")}</p>
      </Card>
    </>
  );
}
