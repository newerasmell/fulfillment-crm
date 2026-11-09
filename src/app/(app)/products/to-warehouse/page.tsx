import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ConnectionChip } from "@/app/(app)/products/stock/ui";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, inputCls, buttonCls } from "@/components/ui/form";
import { can } from "@/server/auth/rbac";
import { requireAccountContext } from "@/server/auth/session";
import { productsMissingAt, warehouseCreateTargets } from "@/server/products/to-warehouse";
import { ToWarehousePicker } from "./picker";

/**
 * "Създаване в склада" (owner request 2026-11-09): master products the chosen warehouse does not have yet, created
 * there from the CRM through the outbox (the connection's live mode decides what is sent).
 */
export default async function ToWarehousePage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; q?: string; page?: string; ready?: string }>;
}) {
  const ctx = await requireAccountContext();
  const t = await getTranslations("toWarehouse");
  const sp = await searchParams;
  const targets = await warehouseCreateTargets(ctx);
  const conn = targets.find((c) => c.id === sp.c) ?? targets[0] ?? null;
  const q = (sp.q ?? "").slice(0, 100);
  const onlyReady = sp.ready === "1";
  const page = Math.max(1, Number(sp.page) || 1);
  const data = conn ? await productsMissingAt(ctx, conn.id, { q, page, onlyReady }) : null;
  const href = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const all = { c: conn?.id, q: q || undefined, ready: onlyReady ? "1" : undefined, ...patch };
    for (const [k, v] of Object.entries(all)) if (v) p.set(k, v);
    return `/products/to-warehouse?${p}`;
  };
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("intro")} />
      {!conn ? (
        <Card>
          <p className="m-0 text-sm text-muted">{t("noWarehouses")}</p>
        </Card>
      ) : (
        <Card>
          <nav className="mb-3 flex flex-wrap gap-2" aria-label={t("warehouses")}>
            {targets.map((c) => (
              <Link
                key={c.id}
                href={href({ c: c.id, page: undefined })}
                aria-current={c.id === conn.id ? "page" : undefined}
                className={`rounded-full border px-3 py-1 text-sm no-underline ${
                  c.id === conn.id ? "border-accent bg-accent/10 font-semibold" : "border-line hover:bg-hover"
                }`}
              >
                <ConnectionChip type={c.type} name={c.name} />
              </Link>
            ))}
          </nav>
          <p className="mt-0 text-sm" data-testid="to-warehouse-mode">
            {t(`mode.${conn.liveMode}`)}
          </p>
          <form className="mb-3 flex flex-wrap items-center gap-2" action="/products/to-warehouse">
            <input type="hidden" name="c" value={conn.id} />
            <input
              name="q"
              defaultValue={q}
              placeholder={t("search")}
              aria-label={t("search")}
              className={`${inputCls} w-72`}
            />
            <label className="inline-flex items-center gap-1 text-sm">
              <input type="checkbox" name="ready" value="1" defaultChecked={onlyReady} />
              {t("onlyReady")}
            </label>
            <button type="submit" className={buttonCls}>
              {t("filter")}
            </button>
          </form>
          <p className="mt-0 text-sm text-muted">{t("count", { n: data!.total })}</p>
          {data!.rows.length === 0 ? (
            <p className="m-0 text-sm text-muted">{t("none")}</p>
          ) : (
            <ToWarehousePicker
              key={`${conn.id}:${page}:${q}:${onlyReady}`}
              connectionId={conn.id}
              rows={data!.rows}
              canWrite={can(ctx.role, "vendorProducts.write") && can(ctx.role, "connections.manage")}
            />
          )}
          {data!.pages > 1 && (
            <div className="mt-3 flex items-center gap-3 text-sm">
              {page > 1 && (
                <Link href={href({ page: String(page - 1) })} className={ghostButtonCls}>
                  ← {t("prev")}
                </Link>
              )}
              <span>{t("pageOf", { page, pages: data!.pages })}</span>
              {page < data!.pages && (
                <Link href={href({ page: String(page + 1) })} className={ghostButtonCls}>
                  {t("next")} →
                </Link>
              )}
            </div>
          )}
          <p className="mb-0 mt-3 text-xs text-muted">
            {t(conn.type === "EUSHIPMENTS" ? "noteEu" : "noteFhb")}
          </p>
        </Card>
      )}
    </>
  );
}
