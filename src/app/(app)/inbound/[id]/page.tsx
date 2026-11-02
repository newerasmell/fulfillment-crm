import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConnectionChip, monoCls, TesterBadge } from "@/app/(app)/products/stock/ui";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, tdCls, thCls } from "@/components/ui/form";
import { requireAccountContext } from "@/server/auth/session";
import { inboundDetail } from "@/server/stock/inbound";
import { StatusText } from "../ui";

/** One inbound: expected vs received per line, the outbox requests behind it, its tasks. */
export default async function InboundDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAccountContext();
  const t = await getTranslations("stock.inbound");
  const format = await getFormatter();
  const d = await inboundDetail(ctx, id);
  if (!d) notFound();
  const { inbound, totals } = d;
  const raw = (inbound.raw ?? {}) as { name?: string };
  return (
    <>
      <PageHeader
        title={`${t("detailTitle")} ${inbound.externalRef}`}
        subtitle={raw.name ?? inbound.connection.name}
        actions={
          <Link href="/inbound" className={`${ghostButtonCls} inline-flex items-center`}>
            {t("back")}
          </Link>
        }
      />
      <Card>
        <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted">{t("warehouse")}</dt>
          <dd className="m-0">
            <ConnectionChip type={inbound.connection.type} name={inbound.connection.name} />{" "}
            <span className="text-xs text-muted">{inbound.connection.liveMode}</span>
          </dd>
          <dt className="text-muted">{t("status")}</dt>
          <dd className="m-0" data-testid="inbound-status">
            <StatusText status={inbound.status} t={t} />
          </dd>
          <dt className="text-muted">{t("vendorId")}</dt>
          <dd className={`m-0 ${monoCls}`}>{inbound.vendorId ?? "—"}</dd>
          <dt className="text-muted">{t("expectedDate")}</dt>
          <dd className="m-0">
            {inbound.expectedAt ? format.dateTime(inbound.expectedAt, { dateStyle: "medium" }) : "—"}
          </dd>
          <dt className="text-muted">{t("tracking")}</dt>
          <dd className={`m-0 ${monoCls}`}>{inbound.tracking ?? "—"}</dd>
          <dt className="text-muted">{t("totals")}</dt>
          <dd className={`m-0 ${monoCls}`}>
            {totals.received ?? "—"} / {totals.expected}
            {totals.differing > 0 && (
              <span className="ml-2 text-warn">{t("differing", { n: totals.differing })}</span>
            )}
          </dd>
        </dl>
      </Card>
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("lines")}</h2>
        <table className="w-full border-collapse" aria-label={t("lines")}>
          <thead>
            <tr>
              <th className={thCls}>SKU</th>
              <th className={thCls}>{t("product")}</th>
              <th className={`${thCls} text-right`}>{t("expected")}</th>
              <th className={`${thCls} text-right`}>{t("received")}</th>
              <th className={`${thCls} text-right`}>{t("difference")}</th>
              <th className={thCls}>{t("comment")}</th>
            </tr>
          </thead>
          <tbody>
            {inbound.lines.map((l) => {
              const diff = l.receivedQty === null ? null : l.receivedQty - l.expectedQty;
              return (
                <tr key={l.id} data-testid={`inbound-line-${l.product.sku}`}>
                  <td className={`${tdCls} ${monoCls}`}>{l.product.sku}</td>
                  <td className={tdCls}>
                    {l.product.name}
                    {l.product.isTester && <TesterBadge />}
                  </td>
                  <td className={`${tdCls} ${monoCls} text-right`}>{l.expectedQty}</td>
                  <td className={`${tdCls} ${monoCls} text-right`}>{l.receivedQty ?? "—"}</td>
                  <td className={`${tdCls} ${monoCls} text-right ${diff ? "font-semibold text-warn" : ""}`}>
                    {diff === null ? "—" : diff > 0 ? `+${diff}` : diff}
                  </td>
                  <td className={tdCls}>{l.comment ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("requests")}</h2>
        {d.requests.length === 0 ? (
          <p className="m-0 text-sm text-muted">—</p>
        ) : (
          <ul className="m-0 list-none p-0 text-sm">
            {d.requests.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap justify-between gap-2 border-b border-line-soft py-1.5"
              >
                <span className={monoCls}>{r.operation}</span>
                <span>
                  <span className="font-semibold">{r.status}</span>
                  {r.evaluatedMode && <span className="ml-1 text-xs text-muted">({r.evaluatedMode})</span>}
                  {r.lastError && (
                    <span className="ml-2 text-xs text-block">{r.lastError.slice(0, 160)}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mb-0 mt-2 text-xs text-muted">{t("requestsNote")}</p>
      </Card>
      {d.alerts.length > 0 && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("tasks")}</h2>
          <ul className="m-0 list-none p-0 text-sm">
            {d.alerts.map((a) => (
              <li key={a.id} className="border-b border-line-soft py-1.5">
                <span className={a.status === "RESOLVED" ? "text-muted line-through" : "font-semibold"}>
                  {a.title}
                </span>
                {a.body && <div className={`${monoCls} whitespace-pre-line text-muted`}>{a.body}</div>}
              </li>
            ))}
          </ul>
          <Link href="/alerts" className="text-sm text-accent hover:underline">
            {t("toAlerts")}
          </Link>
        </Card>
      )}
    </>
  );
}
