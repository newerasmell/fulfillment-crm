import { getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { tdCls, thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { requireAccountContext } from "@/server/auth/session";
import { accountDb } from "@/server/db/client";
import { listUnmatchedVariants, stripSkuPrefix } from "@/server/shopify/products";
import { MatchVariant } from "./forms";

export default async function ProductsPage() {
  const ctx = await requireAccountContext();
  const t = await getTranslations("products");
  const unmatched = await listUnmatchedVariants(ctx);
  const products = await accountDb(ctx.accountId).product.findMany({
    where: { archived: false },
    select: {
      id: true,
      sku: true,
      name: true,
      _count: { select: { variantLinks: true } },
    },
    orderBy: { sku: "asc" },
    take: 500,
  });
  const match = can(ctx.role, "products.match");
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("intro")} />
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("unmatchedTitle", { count: unmatched.length })}</h2>
        {products.length === 0 && unmatched.length > 0 && (
          <p role="note" className="mt-0 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent-strong">
            {t("waitWarehouses")}
          </p>
        )}
        {unmatched.length === 0 ? (
          <p className="m-0 text-muted">{t("unmatchedEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>{t("store")}</th>
                  <th className={thCls}>{t("variant")}</th>
                  <th className={thCls}>{t("sku")}</th>
                  <th className={thCls}>{t("barcode")}</th>
                  {match && <th className={thCls} />}
                </tr>
              </thead>
              <tbody>
                {unmatched.map((v) => (
                  <tr key={v.id}>
                    <td className={tdCls}>{v.store.name}</td>
                    <td className={tdCls}>{v.title}</td>
                    <td className={`${tdCls} font-mono text-[13px]`}>{v.sku ?? "—"}</td>
                    <td className={`${tdCls} font-mono text-[13px] text-muted`}>{v.barcode ?? "—"}</td>
                    {match && (
                      <td className={tdCls}>
                        <MatchVariant
                          linkId={v.id}
                          title={v.title}
                          suggestion={stripSkuPrefix(v.sku, v.store.skuPrefix)}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("masterTitle", { count: products.length })}</h2>
        {products.length === 0 ? (
          <p className="m-0 text-muted">{t("masterEmpty")}</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>{t("sku")}</th>
                <th className={thCls}>{t("name")}</th>
                <th className={thCls}>{t("storeVariants")}</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <td className={`${tdCls} font-mono text-[13px]`}>{p.sku}</td>
                  <td className={tdCls}>{p.name}</td>
                  <td className={tdCls}>{p._count.variantLinks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
