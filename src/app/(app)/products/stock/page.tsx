import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { requireAccountContext } from "@/server/auth/session";
import { companyFilter } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import { StockBoard, type BoardParams } from "./board";

export default async function StockPage({ searchParams }: { searchParams: Promise<BoardParams> }) {
  const ctx = await requireAccountContext();
  const t = await getTranslations("fhb");
  const params = await searchParams;
  const connections = await accountDb(ctx.accountId).fulfillmentConnection.findMany({
    where: { type: "FHB_V3", ...companyFilter(ctx) },
    select: { id: true },
  });
  return (
    <>
      <PageHeader
        title={t("stock.title")}
        subtitle={t("stock.intro")}
        actions={
          <Link href="/products" className={`${ghostButtonCls} inline-flex items-center`}>
            {t("stock.toMasters")}
          </Link>
        }
      />
      {connections.length === 0 ? (
        <Card>
          <p className="m-0 text-muted">{t("stock.noConnections")}</p>
        </Card>
      ) : (
        <StockBoard
          accountId={ctx.accountId}
          connectionIds={connections.map((c) => c.id)}
          base="/products/stock"
          params={params}
          canLink={can(ctx.role, "products.match")}
        />
      )}
    </>
  );
}
