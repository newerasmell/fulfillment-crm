import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { tdCls, thCls } from "@/components/ui/form";
import { DomainError } from "@/server/accounts";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import type { Finding } from "@/server/checks/findings";
import { canaryView } from "@/server/fulfill";
import { getManualShipment } from "@/server/labels";
import { StatusChip } from "../../orders/status";
import { KindChip } from "../chips";
import { CanaryConfirm, RefetchButton, ResendButton, VoidButton } from "./actions";

/** One manual shipment: label, what was sent and in which mode, tracking, timeline (SPEC §6.6). */
export default async function ManualShipmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAccountContext();
  const actor = actorFrom(ctx);
  const t = await getTranslations("manual");
  const tm = await getTranslations("mode");
  const format = await getFormatter();
  let data;
  try {
    data = await getManualShipment(actor, id);
  } catch (err) {
    if (err instanceof DomainError) notFound();
    throw err;
  }
  const { ms, requests, bulkLabels, voidable, openRequest } = data;
  const f = ms.fulfillment;
  const when = (d: Date) => format.dateTime(d, { dateStyle: "medium", timeStyle: "short" });
  const isLabel = ms.kind !== "WAREHOUSE";
  const canFulfill = can(ctx.role, "orders.fulfill");
  const canary =
    openRequest &&
    ms.connection.liveMode === "CANARY" &&
    ["PENDING", "AWAITING_CONFIRMATION"].includes(openRequest.status) &&
    can(ctx.role, "outbox.confirmCanary")
      ? await canaryView(actor, openRequest.id).catch(() => null)
      : null;
  const resendable =
    isLabel &&
    canFulfill &&
    f &&
    ["QUEUED", "SUBMIT_FAILED"].includes(f.status) &&
    openRequest &&
    ["DRY_RUN_RECORDED", "REFUSED", "FAILED"].includes(openRequest.status);
  const softCodes = ((ms.order.check?.findings ?? []) as unknown as Finding[])
    .filter((x) => x.severity === "soft")
    .map((x) => x.code);
  const address = (ms.order.shippingAddress ?? {}) as Record<string, string | null>;
  const params_ = (ms.params ?? {}) as Record<string, unknown>;
  const timeline = [
    ...ms.order.events.map((e) => ({
      at: e.createdAt,
      what: `${e.fromStatus ?? "—"} → ${e.toStatus}`,
      source: e.source ?? e.cause,
    })),
    ...(f?.events ?? []).map((e) => ({
      at: e.occurredAt,
      what:
        [e.rawStatus, (e.payload as { event?: string } | null)?.event].filter(Boolean).join(" · ") ||
        (e.status ?? ""),
      source: e.source,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  return (
    <>
      <PageHeader
        title={`${t("detail.title")} ${ms.order.number}`}
        subtitle={`${ms.connection.name} · ${tm(ms.connection.liveMode)}`}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <KindChip kind={ms.kind} label={t(`kind.${ms.kind}`)} />
            <StatusChip status={f?.status ?? ms.order.status} />
            <Link href={`/orders/${ms.orderId}`}>{t("detail.openOrder")}</Link>
          </span>
        }
      />
      {ms.kind === "WAREHOUSE" && !f && (
        <Card>
          <p className="m-0">{t("detail.warehouseNext")}</p>
          <Link href={`/orders/${ms.orderId}`} className="mt-2 inline-block font-semibold">
            {t("detail.toReview")}
          </Link>
        </Card>
      )}
      {isLabel && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("detail.label")}</h2>
          <div className="flex flex-wrap items-center gap-3">
            {f?.labelFileKey ? (
              <a
                href={`/api/labels/${f.labelFileKey}`}
                target="_blank"
                rel="noopener"
                className="font-semibold"
              >
                {t("label.download")}
              </a>
            ) : (
              <span className="text-muted">{t("label.none")}</span>
            )}
            {f &&
              canFulfill &&
              ["ACCEPTED", "PROCESSING", "SHIPPED"].includes(f.status) &&
              ms.kind !== "PRE_AWB" && <RefetchButton fulfillmentId={f.id} id={ms.id} />}
            {voidable && can(ctx.role, "orders.cancelAtWarehouse") && <VoidButton id={ms.id} />}
            {resendable && <ResendButton id={ms.id} codes={softCodes} />}
          </div>
          {f && f.labels.length > 0 && (
            <ul className="mb-0 text-sm text-muted">
              {f.labels.map((l) => (
                <li key={l.id}>
                  <a href={`/api/labels/${l.id}`} target="_blank" rel="noopener">
                    {l.source}
                  </a>{" "}
                  · {when(l.createdAt)} · {Math.round(l.sizeBytes / 1024)} KB
                </li>
              ))}
              {bulkLabels.map((l) => (
                <li key={l.id}>
                  <a href={`/api/labels/${l.id}`} target="_blank" rel="noopener">
                    {t("detail.bulkPdf")}
                  </a>{" "}
                  · {when(l.createdAt)}
                </li>
              ))}
            </ul>
          )}
          {ms.kind === "JOY_LABEL" && <p className="mb-0 text-sm text-muted">{t("detail.joyReprint")}</p>}
        </Card>
      )}
      {canary && (
        <Card className="border-warn">
          <h2 className="mt-0 text-base font-semibold">{t("detail.canaryTitle")}</h2>
          <p className="mt-0 text-sm">
            {t("detail.canaryBody", { remaining: canary.remaining, cap: canary.cap })}
          </p>
          <pre className="max-h-72 overflow-auto rounded-lg bg-hover p-2 font-mono text-xs">
            {JSON.stringify(canary.payload, null, 2)}
          </pre>
          {canary.confirmed ? (
            <p className="m-0 text-ok">{t("detail.canaryDone")}</p>
          ) : (
            <CanaryConfirm requestId={canary.requestId} payloadHash={canary.payloadHash} />
          )}
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("detail.recipient")}</h2>
          <dl className="m-0 grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-label">{t("form.name")}</dt>
            <dd className="m-0">{ms.order.customerName}</dd>
            <dt className="text-label">{t("form.phone")}</dt>
            <dd className="m-0 font-mono">{ms.order.phone}</dd>
            <dt className="text-label">{t("form.email")}</dt>
            <dd className="m-0">{ms.order.email ?? "—"}</dd>
            <dt className="text-label">{t("detail.address")}</dt>
            <dd className="m-0">
              {[address.address1, address.address2, address.zip, address.city, address.countryCode]
                .filter(Boolean)
                .join(", ")}
            </dd>
            <dt className="text-label">{t("form.cod")}</dt>
            <dd className="m-0 font-mono">
              {ms.order.codAmount ? `${ms.order.codAmount.toString()} ${ms.order.currency}` : "—"}
            </dd>
            <dt className="text-label">{t("form.parcels")}</dt>
            <dd className="m-0 font-mono">{String(params_.parcels ?? "1")}</dd>
            {f && (
              <>
                <dt className="text-label">{t("detail.externalId")}</dt>
                <dd className="m-0 font-mono">{f.externalId}</dd>
                <dt className="text-label">{t("detail.carrier")}</dt>
                <dd className="m-0 font-mono">{f.carrier ?? "—"}</dd>
              </>
            )}
          </dl>
          {ms.order.lines.length > 0 && (
            <ul className="mb-0 text-sm">
              {ms.order.lines.map((l) => (
                <li key={l.id}>
                  {l.quantity} × {l.sku} {l.title}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("detail.tracking")}</h2>
          {f ? (
            <dl className="m-0 grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-label">{t("detail.status")}</dt>
              <dd className="m-0">
                <StatusChip status={f.status} /> <span className="text-muted">{f.rawStatus ?? ""}</span>
              </dd>
              <dt className="text-label">{t("col.tracking")}</dt>
              <dd className="m-0 font-mono">{f.trackingNumbers.join(", ") || "—"}</dd>
              {f.vendorOrderId && (
                <>
                  <dt className="text-label">{ms.kind === "PRE_AWB" ? t("detail.preAwbId") : "AWB"}</dt>
                  <dd className="m-0 font-mono">{f.vendorOrderId}</dd>
                </>
              )}
              {f.trackingUrls.map((u) => (
                <dd key={u} className="col-span-2 m-0">
                  <a href={u} target="_blank" rel="noopener noreferrer">
                    {u}
                  </a>
                </dd>
              ))}
              <dt className="text-label">{t("detail.trackedAt")}</dt>
              <dd className="m-0">{ms.trackedAt ? when(ms.trackedAt) : "—"}</dd>
              {ms.trackError && <dd className="col-span-2 m-0 text-warn">{ms.trackError}</dd>}
            </dl>
          ) : (
            <p className="m-0 text-muted">{t("detail.noShipment")}</p>
          )}
        </Card>
      </div>
      {requests.length > 0 && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("detail.requests")}</h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={thCls}>{t("detail.operation")}</th>
                  <th className={thCls}>{t("detail.requestStatus")}</th>
                  <th className={thCls}>{t("detail.mode")}</th>
                  <th className={thCls}>{t("detail.attempts")}</th>
                  <th className={thCls}>{t("detail.lastError")}</th>
                  <th className={thCls}>{t("col.created")}</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td className={`${tdCls} font-mono text-xs`}>{r.operation}</td>
                    <td className={tdCls}>
                      {t.has(`outbox.${r.status}`) ? t(`outbox.${r.status}`) : r.status}
                    </td>
                    <td className={tdCls}>{r.evaluatedMode ? tm(r.evaluatedMode) : "—"}</td>
                    <td className={`${tdCls} font-mono`}>{r.attempts}</td>
                    <td className={`${tdCls} text-xs text-muted`}>{r.lastError ?? ""}</td>
                    <td className={`${tdCls} whitespace-nowrap text-muted`}>{when(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Card>
        <h2 className="mt-0 text-base font-semibold">{t("detail.timeline")}</h2>
        <ol className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
          {timeline.map((e, i) => (
            <li key={i} className="flex flex-wrap gap-3 border-b border-line-soft py-1">
              <span className="w-40 shrink-0 font-mono text-xs text-muted">{when(e.at)}</span>
              <span>{e.what}</span>
              <span className="text-xs text-label">{e.source}</span>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
