import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { runStoreJobAction } from "@/app/actions/stores";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls } from "@/components/ui/form";
import { DomainError } from "@/server/accounts";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { accountDb } from "@/server/db/client";
import { getStore } from "@/server/stores";
import { BackfillForm, ReplaceCredentialsForm, StoreSettingsForm } from "../forms";
import { ConnectionBadge } from "../status";

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
  const [orders, variants, unmatched, company] = await Promise.all([
    db.order.count({ where: { storeId: id } }),
    db.storeVariantLink.count({ where: { storeId: id } }),
    db.storeVariantLink.count({ where: { storeId: id, productId: null } }),
    store.companyId
      ? db.company.findUnique({ where: { id: store.companyId }, select: { name: true } })
      : null,
  ]);
  const webhook = store.webhookStatus as { ok?: boolean; at?: string; topics?: string[]; errors?: string[] };
  const cursors = store.syncCursors as { ordersSyncedAt?: string; ordersBackfilledAt?: string };
  const cursor = [cursors.ordersSyncedAt, cursors.ordersBackfilledAt].filter(Boolean).sort().pop();
  const manage = can(ctx.role, "stores.manage");
  const sync = can(ctx.role, "stores.sync");
  const job = (kind: "test" | "orders" | "products" | "webhooks", label: string) => (
    <form action={runStoreJobAction.bind(null, id, kind)}>
      <button type="submit" className={ghostButtonCls}>
        {label}
      </button>
    </form>
  );
  const fmt = (iso?: string) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }) : "—";

  return (
    <>
      <PageHeader
        title={store.name}
        subtitle={`${company?.name ?? "—"} · ${store.domain} · ${store.code}`}
        actions={
          <Link href="/stores" className={ghostButtonCls + " inline-flex items-center"}>
            {t("back")}
          </Link>
        }
      />
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("connection")}</h2>
        <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
          <dt className="text-muted">{t("connection")}</dt>
          <dd className="m-0">
            <ConnectionBadge status={store.connectionStatus} />
            {store.shopName && <span className="ml-2 text-muted">{store.shopName}</span>}
          </dd>
          <dt className="text-muted">{t("webhooks")}</dt>
          <dd className="m-0">
            {webhook.at ? (
              <span className={webhook.ok ? "text-ok" : "text-block"}>
                {t("webhooksCount", { count: webhook.topics?.length ?? 0 })} · {fmt(webhook.at)}
              </span>
            ) : (
              <span className="text-muted">{t("status.pending")}</span>
            )}
            {webhook.errors?.map((e) => (
              <div key={e} className="text-xs text-block">
                {e}
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
              name: store.name,
              countries: store.countries,
              codGateways: store.codGateways,
              skuPrefix: store.skuPrefix,
              notifyCustomer: store.notifyCustomer,
              writeBackMode: store.writeBackMode,
              inventoryPushMode: store.inventoryPushMode,
              inventoryBuffer: store.inventoryBuffer,
            }}
          />
        </Card>
      )}
      {can(ctx.role, "credentials.write") && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("replaceCredentials")}</h2>
          <p className="mt-0 text-sm text-muted">{t("replaceCredentialsHelp")}</p>
          <ReplaceCredentialsForm storeId={id} />
        </Card>
      )}
    </>
  );
}
