import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls } from "@/components/ui/form";
import { DomainError } from "@/server/accounts";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { accountDb } from "@/server/db/client";
import { getStore } from "@/server/stores";
import {
  deleteBlockers,
  needsWebhookRemoval,
  storeEditLocks,
  storeUsage,
  type WebhookStatusView,
} from "@/server/store-lifecycle";
import { ArchiveStoreForm, DeleteStoreForm, RestoreStoreForm, StoreDetailsForm } from "./lifecycle-forms";
import { BackfillForm, ReplaceCredentialsForm, StoreOrderTagForm, StoreSettingsForm } from "../forms";
import { storeOrderTag } from "@/server/shopify/order-tag";
import { MissingScopes, ShopifySetupGuide } from "../setup-guide";
import { ConnectionBadge } from "../status";
import { JobButton } from "../JobButton";

export default async function StorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAccountContext();
  const t = await getTranslations("stores");
  const format = await getFormatter();
  let store;
  try {
    store = await getStore(actorFrom(ctx), id);
  } catch (err) {
    if (err instanceof DomainError) notFound();
    throw err;
  }
  const db = accountDb(ctx.accountId);
  const [usage, variants, unmatched, company] = await Promise.all([
    storeUsage(ctx.accountId, id),
    db.storeVariantLink.count({ where: { storeId: id } }),
    db.storeVariantLink.count({ where: { storeId: id, productId: null } }),
    store.companyId
      ? db.company.findUnique({ where: { id: store.companyId }, select: { name: true } })
      : null,
  ]);
  const orders = usage.orders;
  const latestOrder = await db.order.findFirst({
    where: { storeId: id },
    orderBy: { placedAt: "desc" },
    select: { number: true },
  });
  const webhook = store.webhookStatus as WebhookStatusView & { note?: string };
  const archived = !!store.archivedAt;
  const locks = storeEditLocks(usage);
  const blockers = deleteBlockers(usage);
  const owner = can(ctx.role, "stores.archive");
  // The company picker: the member's companies, plus the current one if it is archived/outside the menu.
  const companies =
    store.companyId && !ctx.companies.some((c) => c.id === store.companyId)
      ? [{ id: store.companyId, name: company?.name ?? "—" }, ...ctx.companies]
      : ctx.companies;
  const cursors = store.syncCursors as { ordersSyncedAt?: string; ordersBackfilledAt?: string };
  const cursor = [cursors.ordersSyncedAt, cursors.ordersBackfilledAt].filter(Boolean).sort().pop();
  const manage = can(ctx.role, "stores.manage") && !archived;
  const sync = can(ctx.role, "stores.sync") && !archived;
  const job = (kind: "test" | "orders" | "products" | "webhooks" | "removeWebhooks", label: string) => (
    <JobButton storeId={id} kind={kind} label={label} />
  );
  const fmt = (iso?: string) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }) : "—";

  return (
    <>
      <PageHeader
        title={store.name}
        subtitle={`${company?.name ?? "—"} · ${store.domain} · ${store.code}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href={`/stores/${id}/inventory`} className={ghostButtonCls + " inline-flex items-center"}>
              {(await getTranslations("stock.push"))("title")}
            </Link>
            <Link href="/stores" className={ghostButtonCls + " inline-flex items-center"}>
              {t("back")}
            </Link>
          </div>
        }
      />
      {archived && (
        <Card>
          <p role="status" className="m-0 rounded-lg bg-warn-bg px-3 py-2 text-warn">
            <span className="font-semibold">{t("archived")}</span> ·{" "}
            {t("archivedSince", { at: fmt(store.archivedAt!.toISOString()) })}
          </p>
          {webhook.deleteRequested && webhook.ok !== false && (
            <p className="mb-0 text-sm text-muted">{t("deletePending")}</p>
          )}
          {owner && (
            <div className="mt-4 flex flex-wrap items-start gap-3">
              <RestoreStoreForm storeId={id} />
              {!webhook.removed && job("removeWebhooks", t("removeWebhooks"))}
            </div>
          )}
          {owner && <p className="mb-0 text-xs text-muted">{t("restoreHelp")}</p>}
        </Card>
      )}
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("connection")}</h2>
        <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
          <dt className="text-muted">{t("connection")}</dt>
          <dd className="m-0">
            <ConnectionBadge status={store.connectionStatus} />
            {store.shopName && <span className="ml-2 text-muted">{store.shopName}</span>}
            <MissingScopes status={store.connectionStatus} />
          </dd>
          <dt className="text-muted">{t("webhooks")}</dt>
          <dd className="m-0">
            {webhook.removed ? (
              <span className="text-muted">
                {t("webhooksRemoved")} · {fmt(webhook.at)}
                {webhook.note && <span className="ml-1 text-xs">({t(`errors.${webhook.note}`)})</span>}
              </span>
            ) : webhook.at ? (
              <span className={webhook.ok ? "text-ok" : "text-block"}>
                {t("webhooksCount", { count: webhook.topics?.length ?? 0 })} · {fmt(webhook.at)}
              </span>
            ) : (
              <span className="text-muted">{t("status.pending")}</span>
            )}
            {webhook.errors?.map((e) => (
              <div key={e} className="text-xs text-block">
                {t.has(`errors.${e}`) ? t(`errors.${e}`) : e}
              </div>
            ))}
          </dd>
          <dt className="text-muted">{t("ordersImported")}</dt>
          <dd className="m-0">
            {orders} · <span className="text-muted">{t("lastSync", { at: fmt(cursor) })}</span>
          </dd>
          <dt className="text-muted">{t("variants")}</dt>
          <dd className="m-0">
            {variants}
            {unmatched > 0 && (
              <Link href="/products" className="ml-2 text-warn hover:underline">
                {t("unmatched", { count: unmatched })}
              </Link>
            )}
          </dd>
          <dt className="text-muted">{t("credential")}</dt>
          <dd className="m-0">{store.credentialId ? t("credentialSet") : t("credentialMissing")}</dd>
        </dl>
        <div className="mt-3">
          <ShopifySetupGuide
            open={
              (store.connectionStatus as { ok?: boolean } | null)?.ok === false ||
              !!(store.connectionStatus as { missingScopes?: string[] } | null)?.missingScopes?.length
            }
          />
        </div>
        {sync && (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
            {job("test", t("testConnection"))}
            {job("orders", t("syncOrders"))}
            {job("products", t("syncProducts"))}
            {manage && job("webhooks", t("registerWebhooks"))}
          </div>
        )}
      </Card>
      {manage && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("details")}</h2>
          <p className="mt-0 text-sm text-muted">{t("detailsHelp")}</p>
          <StoreDetailsForm
            storeId={id}
            companies={companies}
            locks={{ code: !!locks.code, domain: !!locks.domain }}
            s={{
              name: store.name,
              companyId: store.companyId,
              currency: store.currency,
              countries: store.countries,
              domain: store.domain,
              code: store.code,
              vendorIdPrefix: store.vendorIdPrefix,
              sampleNumber: latestOrder?.number ?? null,
            }}
          />
        </Card>
      )}
      {manage && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("orderTag.title")}</h2>
          <StoreOrderTagForm storeId={id} tag={await storeOrderTag(ctx.accountId, id)} />
        </Card>
      )}
      {manage && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("backfill")}</h2>
          <p className="mt-0 text-sm text-muted">{t("backfillHelp")}</p>
          <BackfillForm storeId={id} />
        </Card>
      )}
      {manage && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("settings")}</h2>
          <StoreSettingsForm
            storeId={id}
            canRaise={can(ctx.role, "stores.raiseMode")}
            s={{
              codGateways: store.codGateways,
              skuPrefix: store.skuPrefix,
              notifyCustomer: store.notifyCustomer,
              fulfilTrigger: store.fulfilTrigger,
              writeBackMode: store.writeBackMode,
              inventoryPushMode: store.inventoryPushMode,
              weightWriteMode: store.weightWriteMode,
              inventoryBuffer: store.inventoryBuffer,
            }}
          />
        </Card>
      )}
      {can(ctx.role, "credentials.write") && !archived && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("replaceCredentials")}</h2>
          <p className="mt-0 text-sm text-muted">{t("replaceCredentialsHelp")}</p>
          <ReplaceCredentialsForm storeId={id} />
        </Card>
      )}
      {owner && (
        <Card>
          <h2 className="mt-0 text-base font-semibold text-block">{t("danger")}</h2>
          {!archived && (
            <section className="mb-5 border-b border-line pb-5" aria-label={t("archive")}>
              <h3 className="mt-0 text-sm font-semibold">{t("archive")}</h3>
              <p className="mt-0 text-sm text-muted">{t("archiveHelp")}</p>
              <ArchiveStoreForm storeId={id} notSent={usage.notSent} />
            </section>
          )}
          <section aria-label={t("delete")}>
            <h3 className="mt-0 text-sm font-semibold">{t("delete")}</h3>
            <p className="mt-0 text-sm text-muted">{t("deleteHelp")}</p>
            {blockers.length > 0 ? (
              <p role="note" className="m-0 text-sm text-warn">
                {t("deleteBlocked")} {blockers.map((b) => t(`errors.${b}`)).join(", ")}.{" "}
                {!archived && t("deleteUseArchive")}
              </p>
            ) : (
              <DeleteStoreForm
                storeId={id}
                code={store.code}
                canForce={!!webhook.deleteRequested && webhook.ok === false && needsWebhookRemoval(store)}
              />
            )}
          </section>
        </Card>
      )}
    </>
  );
}
