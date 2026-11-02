import { randomUUID } from "node:crypto";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls } from "@/components/ui/form";
import { requireAccountContext } from "@/server/auth/session";
import { accountDb } from "@/server/db/client";
import { boardProductWhere } from "@/server/stock/board";
import { inboundConnections } from "@/server/stock/inbound";
import { NewInboundForm } from "../forms";

/** New stock receipt / booking request (P5-02). The request token is minted here, once per form. */
export default async function NewInboundPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string }>;
}) {
  const ctx = await requireAccountContext("inbound.manage");
  const t = await getTranslations("stock.inbound");
  const sp = await searchParams;
  const connections = (await inboundConnections(ctx)).filter((c) => c.enabled);
  let initial = null;
  if (sp.product) {
    const p = await accountDb(ctx.accountId).product.findFirst({
      where: { id: sp.product, archived: false, AND: [boardProductWhere(ctx)] },
      select: {
        id: true,
        sku: true,
        name: true,
        vendorProducts: {
          where: { connectionId: { in: connections.map((c) => c.id) }, archived: false },
          select: { connectionId: true, vendorId: true },
          take: 1,
        },
      },
    });
    const vp = p?.vendorProducts[0];
    if (p && vp)
      initial = {
        connectionId: vp.connectionId,
        line: { productId: p.id, sku: p.sku, name: p.name, vendorId: vp.vendorId, quantity: 1 },
      };
  }
  return (
    <>
      <PageHeader
        title={t("newTitle")}
        subtitle={t("newIntro")}
        actions={
          <Link href="/inbound" className={`${ghostButtonCls} inline-flex items-center`}>
            {t("back")}
          </Link>
        }
      />
      <Card>
        {connections.length === 0 ? (
          <p className="m-0 text-muted">{t("noConnections")}</p>
        ) : (
          <NewInboundForm
            requestToken={randomUUID().replace(/-/g, "")}
            initial={initial}
            connections={connections.map((c) => ({
              id: c.id,
              name: c.name,
              type: c.type,
              liveMode: c.liveMode,
              warehouses: c.eushipmentsWarehouses,
              carriers: c.fhbCarriers,
            }))}
          />
        )}
      </Card>
    </>
  );
}
