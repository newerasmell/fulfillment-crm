import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { tdCls, thCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { requireAccountContext } from "@/server/auth/session";
import { accountDb } from "@/server/db/client";
import { listUnmatchedVariants, stripSkuPrefix } from "@/server/shopify/products";
import { MatchVariant } from "./forms";
import { FillWeightsButton } from "@/components/rules-weights/WeightForm";
import { EuShipmentsProductsLink } from "../warehouses/eushipments/entry-links";
import { LineChip } from "@/components/ui/LineChip";
import { lineCoverage } from "@/server/lines/coverage";
import { lineProductWhere } from "@/server/lines/lines";
import { CoverageSummary } from "./lines/coverage";

export default async function ProductsPage() {
  const ctx = await requireAccountContext();
  const t = await getTranslations("products");
  const unmatched = await listUnmatchedVariants(ctx);
  const products = await accountDb(ctx.accountId).product.findMany({
    // Sidebar product line (P5-00): masters of that line only.
    // Members who cannot pick "all lines" also keep masters without a line (partial rollout, companiesForLine).
    where: {
      archived: false,
      ...(ctx.activeLineId
        ? ctx.role === "OWNER" || ctx.role === "ADMIN"
          ? { lineId: ctx.activeLineId }
          : lineProductWhere(ctx.activeLineId)
        : {}),
    },
    select: {
      id: true,
      sku: true,
      name: true,
      weightGrams: true,
      line: { select: { name: true, color: true } },
      _count: { select: { variantLinks: true } },
    },
    orderBy: { sku: "asc" },
    take: 500,
  });
  const match = can(ctx.role, "products.match");
  const tw = await getTranslations("weights");
  const tl = await getTranslations("lines");
  const shownLines = ctx.activeLineId ? ctx.lines.filter((l) => l.id === ctx.activeLineId) : ctx.lines;
  const coverage = await Promise.all(
    shownLines.map((l) => lineCoverage(ctx.accountId, l.id, ctx.companyScope)),
  );
  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("intro")}
        actions={
          <div className="flex flex-wrap gap-2">
            {ctx.lines.length > 0 && (
              <Link
                href="/products/lines"
                className="inline-flex min-h-10 items-center rounded-[10px] border border-line bg-surface px-3 hover:bg-hover"
              >
                {tl("toolLink")}
              </Link>
            )}
            <Link
              href="/products/stock"
              className="inline-flex min-h-10 items-center rounded-[10px] border border-line bg-surface px-3 hover:bg-hover"
            >
              {(await getTranslations("fhb"))("stock.title")}
            </Link>
          </div>
        }
      />
      {shownLines.length > 0 && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{tl("coverageTitle")}</h2>
          <div className="flex flex-col gap-3">
            {shownLines.map((l, i) => (
              <div key={l.id} className="flex flex-wrap items-center gap-3">
                <Link href={`/products/lines?line=${l.id}`} className="no-underline">
                  <LineChip name={l.name} color={l.color} />
                </Link>
                <CoverageSummary coverage={coverage[i]!} />
              </div>
            ))}
          </div>
        </Card>
      )}
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-base font-semibold">{t("masterTitle", { count: products.length })}</h2>
          {can(ctx.role, "products.weight") && <FillWeightsButton />}
        </div>
        {products.length === 0 ? (
          <p className="m-0 text-muted">{t("masterEmpty")}</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>{t("sku")}</th>
                <th className={thCls}>{t("name")}</th>
                <th className={thCls}>{t("storeVariants")}</th>
                <th className={`${thCls} text-right`}>{tw("column")}</th>
                {ctx.lines.length > 0 && <th className={thCls}>{tl("line")}</th>}
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <td className={`${tdCls} font-mono text-[13px]`}>{p.sku}</td>
                  <td className={tdCls}>
                    <Link href={`/products/${p.id}`} className="hover:underline">
                      {p.name}
                    </Link>
                  </td>
                  <td className={tdCls}>{p._count.variantLinks}</td>
                  <td className={`${tdCls} text-right font-mono`}>
                    <Link
                      href={`/products/${p.id}`}
                      className={p.weightGrams ? "hover:underline" : "text-block hover:underline"}
                    >
                      {p.weightGrams ? `${p.weightGrams} g` : tw("missing")}
                    </Link>
                  </td>
                  {ctx.lines.length > 0 && (
                    <td className={tdCls}>
                      {p.line ? (
                        <LineChip name={p.line.name} color={p.line.color} />
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <EuShipmentsProductsLink ctx={ctx} />
    </>
  );
}
