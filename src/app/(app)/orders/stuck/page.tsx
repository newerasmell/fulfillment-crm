import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { hrefWith, Tabs } from "@/app/(app)/warehouses/fhb/ui";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { warehouseCasesView } from "@/server/warehouse-cases/cases";
import {
  SKU_HISTORY_DAYS,
  SKU_HISTORY_MAX,
  skuHoldHistory,
  skuWatchList,
} from "@/server/warehouse-cases/sku";
import { CaseCard, RefreshButton, SkuHoldHistory, SkuWatchTable } from "./ui";

/**
 * „Блокирани в склад“ (owner request 2026-11-18): shipments the warehouse accepted but has not handed to the courier,
 * one case per company and warehouse, the emails ready to copy into the company's Gmail. Tabs: Кейсове · SKU под
 * наблюдение (units a warehouse could not give, kept out of sale).
 */
export default async function StuckAtWarehousePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const ctx = await requireAccountContext();
  const t = await getTranslations("warehouseCases");
  const tab = (await searchParams).tab === "sku" ? "sku" : "cases";
  const view = {
    ...actorFrom(ctx),
    activeCompanyId: ctx.activeCompanyId,
    lineCompanyIds: ctx.lineCompanyIds,
  };
  const [cases, watch, history] = await Promise.all([
    warehouseCasesView(view),
    skuWatchList(view),
    tab === "sku" ? skuHoldHistory(view) : Promise.resolve([]),
  ]);
  const canAct = can(ctx.role, "orders.review");
  const open = cases.filter((c) => !c.closedAt);
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("intro")} actions={canAct ? <RefreshButton /> : undefined} />
      <Tabs
        label={t("title")}
        items={[
          {
            href: hrefWith("/orders/stuck", {}, {}),
            title: t("tab.cases"),
            active: tab === "cases",
            count: open.length,
          },
          {
            href: hrefWith("/orders/stuck", {}, { tab: "sku" }),
            title: t("tab.sku"),
            active: tab === "sku",
            count: watch.length,
          },
        ]}
      />
      {tab === "sku" ? (
        <Card>
          <p className="m-0 mb-3 text-sm text-muted">{t("sku.intro")}</p>
          {watch.length === 0 ? (
            <p className="m-0 text-sm text-muted" data-testid="sku-watch-empty">
              {t("sku.empty")}
            </p>
          ) : (
            <SkuWatchTable
              canAct={canAct}
              rows={watch.map((w) => ({
                connectionId: w.connectionId,
                productId: w.productId,
                sku: w.sku,
                title: w.title,
                connectionName: w.connectionName,
                units: w.units,
                incidents: w.incidents,
                frozen: w.frozen,
                lastAt: w.lastAt.toISOString(),
                orders: w.orders.map((o) => ({ ...o, at: o.at.toISOString() })),
              }))}
            />
          )}
          <SkuHoldHistory
            days={SKU_HISTORY_DAYS}
            max={SKU_HISTORY_MAX}
            rows={history.map((h) => ({
              ...h,
              at: h.at.toISOString(),
              releasedAt: h.releasedAt?.toISOString() ?? null,
            }))}
          />
        </Card>
      ) : cases.length === 0 ? (
        <Card>
          <p className="m-0 text-sm text-muted" data-testid="cases-empty">
            {t("empty")}
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {can(ctx.role, "companies.manage") && cases.some((c) => !c.configured) && (
            <p className="m-0 rounded-md bg-warn-bg px-3 py-2 text-sm text-warn">
              {t("notConfigured")}{" "}
              <Link className="underline" href="/settings/warehouse-emails">
                {t("settingsLink")}
              </Link>
            </p>
          )}
          {cases.map((c) => (
            <CaseCard
              key={c.id}
              canAct={canAct}
              c={{
                id: c.id,
                companyName: c.companyName,
                connectionName: c.connectionName,
                senderEmail: c.settings.senderEmail,
                discountPercent: c.settings.discountPercent,
                configured: c.configured,
                closed: !!c.closedAt,
                level: c.level,
                oldestHours: c.oldestHours,
                lastSentLevel: c.lastSentLevel,
                lastSentAt: c.lastSentAt?.toISOString() ?? null,
                repliedSinceLast: c.repliedSinceLast,
                suggested: c.suggested,
                emails: c.emails,
                messages: c.messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
                customerInputs: c.customerInputs,
                orders: c.orders.map((o) => ({
                  id: o.id,
                  orderId: o.orderId,
                  number: o.number,
                  ref: o.ref,
                  awb: o.awb,
                  rawStatus: o.rawStatus,
                  since: o.since.toISOString(),
                  hours: o.hours,
                  level: o.level,
                  outcome: o.outcome,
                  resolved: !!o.resolvedAt,
                  warehouseConfirmed: !!o.warehouseConfirmedAt,
                  customerEmailed: !!o.customerEmailedAt,
                  cancelInFlight: o.cancelInFlight,
                  deleteUntil: o.deleteUntil?.toISOString() ?? null,
                  items: o.items.map((i) => `${i.quantity} × ${i.sku ?? i.title}`).join(", "),
                  zeroStock: o.zeroStock,
                  held: o.holds.map((h) => ({ frozen: h.frozen, units: h.units })),
                })),
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}
