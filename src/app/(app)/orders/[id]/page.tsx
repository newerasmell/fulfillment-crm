import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, tdCls, thCls } from "@/components/ui/form";
import { DomainError } from "@/server/accounts";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { jsonEqual } from "@/lib/json-equal";
import { orderWriteBacks } from "@/server/fulfill";
import { getOrder } from "@/server/orders";
import { normaliseAddress } from "@/server/shopify/orders";
import { FulfillButton } from "../selection";
import { StatusChip } from "../status";

type Addr = Record<string, string | null> | null;

function AddressBlock({ a }: { a: Addr }) {
  if (!a) return <p className="m-0 text-muted">—</p>;
  const lines = [
    a.name,
    a.company,
    a.address1,
    a.address2,
    [a.zip, a.city].filter(Boolean).join(" "),
    [a.province, a.country ?? a.countryCode].filter(Boolean).join(", "),
    a.phone,
  ].filter(Boolean);
  return (
    <address className="not-italic">
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </address>
  );
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAccountContext();
  const t = await getTranslations("orders");
  const format = await getFormatter();
  let order;
  try {
    order = await getOrder(actorFrom(ctx), id);
  } catch (err) {
    if (err instanceof DomainError) notFound();
    throw err;
  }
  const writeBacks = await orderWriteBacks(ctx.accountId, order.id);
  const tw = await getTranslations("fulfill.writeBack");
  const money = (v: unknown) => format.number(Number(v), { style: "currency", currency: order.currency });
  const original = order.shippingAddressOriginal as Record<string, string | null> | null;
  const corrected = order.shippingAddress as Addr;
  const risk = order.risk as { recommendation?: string; levels?: string[] } | null;

  return (
    <>
      <PageHeader
        title={`${t("order")} ${order.number}`}
        subtitle={`${order.store?.name ?? "—"} · ${order.company?.name ?? "—"} · ${format.dateTime(
          order.placedAt,
          {
            dateStyle: "medium",
            timeStyle: "short",
          },
        )}`}
        actions={
          <span className="flex flex-wrap items-center gap-3">
            {can(ctx.role, "orders.fulfill") &&
              ["APPROVED", "SUBMIT_FAILED", "QUEUED"].includes(order.status) && (
                <FulfillButton orderId={order.id} />
              )}
            <Link href="/orders" className={ghostButtonCls + " inline-flex items-center"}>
              {t("back")}
            </Link>
          </span>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <StatusChip status={order.status} />
        <span className="text-muted">
          Shopify: {order.shopifyFinancialStatus ?? "—"} / {order.shopifyFulfillmentStatus ?? "—"}
        </span>
        {order.tags.map((tag) => (
          <span key={tag} className="rounded-full bg-hover px-2 py-0.5 text-xs">
            {tag}
          </span>
        ))}
      </div>
      {order.alerts
        .filter((a) => a.status !== "RESOLVED")
        .map((a) => (
          <p key={a.id} role="status" className="m-0 rounded-lg bg-warn-bg px-3 py-2 text-warn">
            {a.title}
          </p>
        ))}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("customer")}</h2>
          <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted">{t("name")}</dt>
            <dd className="m-0">{order.customerName ?? "—"}</dd>
            <dt className="text-muted">{t("email")}</dt>
            <dd className="m-0 font-mono text-[13px]">{order.email ?? "—"}</dd>
            <dt className="text-muted">{t("phone")}</dt>
            <dd className="m-0 font-mono text-[13px]">{order.phone ?? "—"}</dd>
          </dl>
          {order.note && <p className="mb-0 rounded-lg bg-hover px-3 py-2">{order.note}</p>}
        </Card>
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("shippingAddress")}</h2>
          <AddressBlock a={corrected} />
          {original && !jsonEqual(normaliseAddress(original), corrected) && (
            <details className="mt-2 text-sm text-muted">
              <summary>{t("originalAddress")}</summary>
              <AddressBlock
                a={{
                  ...original,
                  country: original.country ?? null,
                  countryCode: original.countryCodeV2 ?? null,
                }}
              />
            </details>
          )}
        </Card>
      </div>
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("items")}</h2>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={thCls}>{t("product")}</th>
              <th className={thCls}>{t("sku")}</th>
              <th className={thCls}>{t("master")}</th>
              <th className={`${thCls} text-right`}>{t("qty")}</th>
              <th className={`${thCls} text-right`}>{t("unitPrice")}</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((l) => (
              <tr key={l.id}>
                <td className={tdCls}>{l.title}</td>
                <td className={`${tdCls} font-mono text-[13px]`}>{l.sku ?? "—"}</td>
                <td className={tdCls}>
                  {l.product ? (
                    <span className="font-mono text-[13px]">{l.product.sku}</span>
                  ) : (
                    <Link href="/products" className="text-warn hover:underline">
                      {t("unmatched")}
                    </Link>
                  )}
                </td>
                <td className={`${tdCls} text-right font-mono`}>{l.quantity}</td>
                <td className={`${tdCls} text-right font-mono`}>{money(l.unitPrice)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="mt-4 mb-0 ml-auto grid w-fit grid-cols-[max-content_max-content] gap-x-6 gap-y-1 text-right">
          <dt className="text-muted">{t("subtotal")}</dt>
          <dd className="m-0 font-mono">{money(order.subtotal)}</dd>
          <dt className="font-semibold">{t("total")}</dt>
          <dd className="m-0 font-mono font-semibold">{money(order.total)}</dd>
          <dt className="text-muted">{t("payment")}</dt>
          <dd className="m-0">
            {order.paymentMethod === "COD" ? `${t("cod")} · ${money(order.codAmount)}` : t("prepaid")}
          </dd>
        </dl>
      </Card>
      {writeBacks.length > 0 && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{tw("title")}</h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {writeBacks.map((w) => (
              <li key={w.id} data-testid="writeback" className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-[13px]">{w.trackingNumber}</span>
                  <span className="rounded-full bg-hover px-2 py-0.5 text-xs">
                    {tw(`status.${w.status}`)}
                  </span>
                  {w.lastError && <span className="text-sm text-warn">{w.lastError}</span>}
                </span>
                {w.request && can(ctx.role, "outbox.payloads") && (
                  <details>
                    <summary className="text-sm text-muted">{tw("request")}</summary>
                    <pre className="m-0 overflow-auto rounded-lg bg-hover p-3 font-mono text-xs">
                      {JSON.stringify((w.request as { variables?: unknown }).variables ?? w.request, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {risk?.recommendation && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("risk")}</h2>
          <p className="m-0">
            {risk.recommendation} {risk.levels?.length ? `· ${risk.levels.join(", ")}` : ""}
          </p>
        </Card>
      )}
    </>
  );
}
