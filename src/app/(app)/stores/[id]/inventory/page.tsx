import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConnectionChip, monoCls } from "@/app/(app)/products/stock/ui";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, tdCls, thCls } from "@/components/ui/form";
import { DomainError } from "@/server/accounts";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { companyFilter } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import { STOCK_CONNECTION_TYPES } from "@/server/routing/engine";
import { planInventoryPush, storePushes } from "@/server/stock/push";
import { storeLocations } from "@/server/stock/shopify-inventory";
import { getStore } from "@/server/stores";
import { MapLocationForm, PushNowButton, ReadInventoryButton } from "./forms";

/**
 * Shopify inventory of one store (P5-03): which Shopify location stands for which warehouse, the dry-run preview
 * of what a push would set (sellable − buffer), "push now" and the push history. The push mode and buffer are
 * changed in the store settings (raising the mode is OWNER-only); the sender checks the mode at send time.
 */
export default async function StoreInventoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAccountContext();
  const t = await getTranslations("stock.push");
  const format = await getFormatter();
  let store;
  try {
    store = await getStore(actorFrom(ctx), id);
  } catch (err) {
    if (err instanceof DomainError) notFound();
    throw err;
  }
  const manage = can(ctx.role, "inventory.push");
  const [locations, connections, plan, pushes] = await Promise.all([
    storeLocations(ctx.accountId, id),
    accountDb(ctx.accountId).fulfillmentConnection.findMany({
      where: {
        type: { in: [...STOCK_CONNECTION_TYPES] },
        ...companyFilter({ ...ctx, activeCompanyId: null, lineCompanyIds: null }),
      },
      select: { id: true, name: true, type: true },
      orderBy: { name: "asc" },
    }),
    planInventoryPush(ctx.accountId, id),
    storePushes(ctx.accountId, id),
  ]);
  const connName = new Map(connections.map((c) => [c.id, c]));
  const locName = new Map(locations.map((l) => [l.shopifyLocationGid, l.name]));
  const lastRead = locations.reduce<Date | null>((m, l) => (!m || l.fetchedAt > m ? l.fetchedAt : m), null);
  return (
    <>
      <PageHeader
        title={`${t("title")} · ${store.name}`}
        subtitle={t("intro")}
        actions={
          <Link href={`/stores/${id}`} className={`${ghostButtonCls} inline-flex items-center`}>
            {t("back")}
          </Link>
        }
      />
      <Card>
        <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted">{t("mode")}</dt>
          <dd className="m-0 font-semibold" data-testid="push-mode">
            {t(`modes.${store.inventoryPushMode}`)}{" "}
            <span className="font-mono text-xs text-label">{store.inventoryPushMode}</span>
          </dd>
          <dt className="text-muted">{t("buffer")}</dt>
          <dd className={`m-0 ${monoCls}`}>{store.inventoryBuffer}</dd>
          <dt className="text-muted">{t("lastRead")}</dt>
          <dd className="m-0">{lastRead ? format.relativeTime(lastRead, new Date()) : t("neverRead")}</dd>
        </dl>
        <p className="mb-0 mt-3 text-xs text-muted">{t("scopes")}</p>
        {manage && (
          <div className="mt-3">
            <ReadInventoryButton storeId={id} />
          </div>
        )}
      </Card>
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("locations")}</h2>
        {locations.length === 0 ? (
          <p className="m-0 text-sm text-muted">{t("noLocations")}</p>
        ) : (
          <table className="w-full border-collapse" aria-label={t("locations")}>
            <thead>
              <tr>
                <th className={thCls}>{t("location")}</th>
                <th className={thCls}>{t("state")}</th>
                <th className={thCls}>{t("warehouse")}</th>
              </tr>
            </thead>
            <tbody>
              {locations.map((l) => (
                <tr key={l.id}>
                  <td className={tdCls}>
                    {l.name}
                    {l.fulfillmentService && <div className="text-xs text-muted">{l.fulfillmentService}</div>}
                  </td>
                  <td className={tdCls}>{l.isActive ? t("active") : t("inactive")}</td>
                  <td className={tdCls}>
                    <MapLocationForm
                      storeId={id}
                      locationId={l.id}
                      locationName={l.name}
                      current={l.connectionId}
                      connections={connections}
                      disabled={!manage}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="m-0 text-base font-semibold">{t("preview")}</h2>
          {manage && (
            <PushNowButton storeId={id} mode={store.inventoryPushMode} changes={plan.changes.length} />
          )}
        </div>
        <p className="mt-1 text-xs text-muted">{t("previewNote", { buffer: store.inventoryBuffer })}</p>
        {plan.mappedLocations === 0 ? (
          <p className="m-0 text-sm text-muted">{t("noMapping")}</p>
        ) : plan.lines.length === 0 ? (
          <p className="m-0 text-sm text-muted">{t("noLines")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" aria-label={t("preview")}>
              <thead>
                <tr>
                  <th className={thCls}>SKU</th>
                  <th className={thCls}>{t("location")}</th>
                  <th className={thCls}>{t("warehouse")}</th>
                  <th className={`${thCls} text-right`}>{t("sellable")}</th>
                  <th className={`${thCls} text-right`}>{t("target")}</th>
                  <th className={`${thCls} text-right`}>{t("shopifyNow")}</th>
                  <th className={`${thCls} text-right`}>{t("delta")}</th>
                </tr>
              </thead>
              <tbody>
                {plan.lines.map((l) => {
                  const delta = l.target - l.shopifyNow;
                  const c = connName.get(l.connectionId);
                  return (
                    <tr key={l.variantLinkId + l.locationGid} data-testid={`push-line-${l.sku ?? l.title}`}>
                      <td className={`${tdCls} ${monoCls}`}>
                        {l.sku ?? "—"}
                        <div className="font-sans text-xs text-muted">{l.title}</div>
                      </td>
                      <td className={tdCls}>{l.locationName}</td>
                      <td className={tdCls}>{c && <ConnectionChip type={c.type} name={c.name} />}</td>
                      <td className={`${tdCls} ${monoCls} text-right`}>{l.sellable}</td>
                      <td className={`${tdCls} ${monoCls} text-right font-semibold`}>{l.target}</td>
                      <td className={`${tdCls} ${monoCls} text-right`}>{l.shopifyNow}</td>
                      <td
                        className={`${tdCls} ${monoCls} text-right ${delta ? "font-semibold" : "text-label"}`}
                      >
                        {delta > 0 ? `+${delta}` : delta}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <ul
          className="m-0 mt-2 flex list-none flex-wrap gap-3 p-0 text-xs text-muted"
          aria-label={t("skippedLabel")}
        >
          {Object.entries(plan.skipped)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => (
              <li key={k}>
                {t(`skipped.${k}`)}: <span className="font-mono">{n}</span>
              </li>
            ))}
        </ul>
      </Card>
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("history")}</h2>
        {pushes.length === 0 ? (
          <p className="m-0 text-sm text-muted">{t("noHistory")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label={t("history")}>
            {pushes.map((p) => {
              const by = (s: string) => p.lines.filter((l) => l.status === s).length;
              return (
                <li
                  key={p.id}
                  className="rounded-[10px] border border-line p-3 text-sm"
                  data-testid="push-history-item"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">
                      {t(`status.${p.status}`)}{" "}
                      <span className="font-mono text-xs text-label">{p.status}</span>
                    </span>
                    <span className="text-xs text-muted">
                      {t(`trigger.${p.trigger}`)} ·{" "}
                      {format.dateTime(p.createdAt, { dateStyle: "short", timeStyle: "short" })}
                      {p.evaluatedMode && ` · ${p.evaluatedMode}`}
                    </span>
                  </div>
                  <div className="text-xs text-muted">
                    {t("lineCounts", {
                      total: p.lines.length,
                      applied: by("applied"),
                      dry: by("dry_run"),
                      unchanged: by("unchanged"),
                      stale: by("stale"),
                      failed: by("failed"),
                    })}
                  </div>
                  {p.lastError && <div className="text-xs text-block">{p.lastError.slice(0, 300)}</div>}
                  {p.request && can(ctx.role, "outbox.payloads") && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-accent">{t("showRequest")}</summary>
                      <pre className="mt-1 max-h-64 overflow-auto rounded bg-hover p-2 text-[11px]">
                        {JSON.stringify(p.request, null, 2)}
                      </pre>
                    </details>
                  )}
                  <ul className="m-0 mt-1 list-none p-0 text-xs">
                    {p.lines.slice(0, 10).map((l) => (
                      <li key={l.id} className="font-mono">
                        {locName.get(l.locationGid) ?? l.locationGid}: {l.shopifyBefore ?? "?"} → {l.target} (
                        {l.status})
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
