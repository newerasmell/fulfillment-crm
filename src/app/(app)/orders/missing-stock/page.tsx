import { getTranslations } from "next-intl/server";
import { hrefWith, Tabs } from "@/app/(app)/warehouses/fhb/ui";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import {
  outOfStockAutoTagStores,
  STOCK_WAIT_TABS,
  stockWaitOverview,
  type StockWaitTab,
} from "@/server/stock/waiting";
import { AutoTagSettings } from "./auto-tag";
import { StockWaitList } from "./list";

/**
 * "Липсващи артикули" (owner request 2026-11-10): orders tagged out_of_stock / waiting_for_stock in Shopify, followed
 * until they can be shipped. Tabs: Липсват · Чакат зареждане · Частично налични · За потвърждение.
 */
export default async function MissingStockPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const ctx = await requireAccountContext();
  const t = await getTranslations("missingStock");
  const sp = await searchParams;
  const tab: StockWaitTab = (STOCK_WAIT_TABS as readonly string[]).includes(sp.tab ?? "")
    ? (sp.tab as StockWaitTab)
    : "out";
  // The sidebar's product line / company, like every list (owner request 2026-11-11).
  const view = {
    ...actorFrom(ctx),
    activeCompanyId: ctx.activeCompanyId,
    lineCompanyIds: ctx.lineCompanyIds,
  };
  const [data, stores] = await Promise.all([stockWaitOverview(view, tab), outOfStockAutoTagStores(view)]);
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("intro")} />
      <Tabs
        label={t("title")}
        items={STOCK_WAIT_TABS.map((k) => ({
          href: hrefWith("/orders/missing-stock", {}, { tab: k === "out" ? undefined : k }),
          title: t(`tab.${k}`),
          active: k === tab,
          count: data.count[k],
        }))}
      />
      <Card>
        <AutoTagSettings
          canEdit={can(ctx.role, "stores.manage")}
          stores={stores.map((st) => ({
            id: st.id,
            name: st.name,
            enabled: !!st.outOfStockAutoTagSince,
            readOnly: st.writeBackMode === "READ_ONLY",
          }))}
        />
        <p className="m-0 mb-3 text-sm text-muted">{t(`tabHint.${tab}`)}</p>
        {data.rows.length === 0 ? (
          <p className="m-0 text-sm text-muted" data-testid="missing-stock-empty">
            {t("empty")}
          </p>
        ) : (
          <StockWaitList
            tab={tab}
            canDecide={can(ctx.role, "orders.review")}
            connections={[...data.connections.values()]}
            rows={data.rows.map((r) => ({
              orderId: r.orderId,
              number: r.order.number,
              placedAt: r.order.placedAt.toISOString(),
              customerName: r.order.customerName,
              storeName: r.order.store?.name ?? null,
              storeMode: r.order.store?.writeBackMode ?? null,
              canWriteTags: r.canWriteTags,
              expected: r.expected,
              readyConnectionId: r.readyConnectionId,
              lines: r.detail.lines,
              evaluated: !!r.evaluatedAt,
              lastWrite: r.lastWrite
                ? {
                    status: r.lastWrite.status,
                    add: r.lastWrite.add,
                    remove: r.lastWrite.remove,
                    lastError: r.lastWrite.lastError,
                  }
                : null,
            }))}
          />
        )}
      </Card>
    </>
  );
}
