import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { WeightForm } from "@/components/rules-weights/WeightForm";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, tdCls, thCls } from "@/components/ui/form";
import { DomainError } from "@/server/accounts";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { productWeightView } from "@/server/products/weights";

/** Product detail: master weight (for every order), suggestions, and the weight writes to Shopify. */
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAccountContext();
  const t = await getTranslations("weights");
  const st = await getTranslations("stores");
  const format = await getFormatter();
  let v;
  try {
    v = await productWeightView(actorFrom(ctx), id);
  } catch (err) {
    if (err instanceof DomainError) notFound();
    throw err;
  }
  const { product } = v;
  const edit = can(ctx.role, "products.weight") && !product.archived;
  const payloads = can(ctx.role, "outbox.payloads");
  return (
    <>
      <PageHeader
        title={product.name}
        subtitle={product.sku}
        actions={
          <Link href="/products" className={ghostButtonCls + " inline-flex items-center"}>
            ←
          </Link>
        }
      />
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("title")}</h2>
        <p className="mt-0 text-sm" data-testid="product-weight">
          {product.weightGrams ? (
            <>
              <span className="font-mono">{t("current", { grams: product.weightGrams })}</span>
              {product.weightSource && (
                <span className="text-muted">
                  {" · "}
                  {t("setBy", {
                    source: t.has(`source.${product.weightSource}`)
                      ? t(`source.${product.weightSource}`)
                      : product.weightSource,
                    who: v.setByName ?? "—",
                  })}
                  {product.weightSetAt
                    ? ` · ${format.dateTime(product.weightSetAt, { dateStyle: "medium", timeStyle: "short" })}`
                    : ""}
                </span>
              )}
            </>
          ) : (
            <span className="text-block">{t("missing")}</span>
          )}
        </p>
        {edit ? (
          <WeightForm
            productId={product.id}
            productLabel={`${product.sku} · ${product.name}`}
            current={product.weightGrams}
            suggestions={v.suggestions}
            shopifyAllowed={v.shopifyAllowed}
          />
        ) : v.suggestions.length === 0 ? (
          <p className="m-0 text-sm text-muted">{t("noSuggestions")}</p>
        ) : null}
      </Card>
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("variants")}</h2>
        {v.variants.length === 0 ? (
          <p className="m-0 text-muted">—</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>Shopify</th>
                <th className={thCls}>SKU</th>
                <th className={thCls}>{t("title")}</th>
                <th className={thCls}>{st("weightWriteMode")}</th>
              </tr>
            </thead>
            <tbody>
              {v.variants.map((l) => (
                <tr key={l.id}>
                  <td className={tdCls}>
                    {l.store.name} · {l.title}
                  </td>
                  <td className={`${tdCls} font-mono text-[13px]`}>{l.sku ?? "—"}</td>
                  <td className={`${tdCls} font-mono`}>
                    {l.shopifyWeightGrams ? t("shopifyWeight", { grams: l.shopifyWeightGrams }) : "—"}
                  </td>
                  <td className={tdCls}>{st(`weightModes.${l.store.weightWriteMode}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {v.writes.length > 0 && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("writesTitle")}</h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {v.writes.map((w) => (
              <li key={w.id} data-testid="weight-write" className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-3">
                  <span>{w.store.name}</span>
                  <span className="font-mono">{w.weightGrams} g</span>
                  <span className="rounded-full bg-hover px-2 py-0.5 text-xs">
                    {t.has(`status.${w.status}`) ? t(`status.${w.status}`) : w.status}
                  </span>
                  {w.lastError && <span className="text-sm text-warn">{w.lastError}</span>}
                  <time className="font-mono text-xs text-muted">
                    {format.dateTime(w.updatedAt, { dateStyle: "medium", timeStyle: "short" })}
                  </time>
                </span>
                {w.request && payloads && (
                  <details open={w.status === "DRY_RUN_RECORDED"}>
                    <summary className="text-sm text-muted">{t("request")}</summary>
                    <pre
                      data-testid="weight-write-request"
                      className="m-0 overflow-auto rounded-lg bg-hover p-3 font-mono text-xs"
                    >
                      {JSON.stringify((w.request as { variables?: unknown }).variables ?? w.request, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
