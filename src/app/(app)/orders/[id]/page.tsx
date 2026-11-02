import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls, tdCls, thCls } from "@/components/ui/form";
import { DomainError } from "@/server/accounts";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import type { Finding } from "@/server/checks/findings";
import { SHOPIFY_TEST_TAG } from "@/server/pipeline";
import {
  editorValues,
  getOrderReview,
  isEditableField,
  PAYLOAD_PREVIEW_STATUSES,
  type TimelineEntry,
} from "@/server/review";
import { normaliseAddress, shopifyPhone } from "@/server/shopify/orders";
import { orderWriteBacks } from "@/server/fulfill";
import { FulfillButton } from "../selection";
import { StatusChip } from "../status";
import { AddressEditor, ApplyFixButton, DecisionBar, RawDetails, RecheckButton } from "./review-ui";
import { AiCard } from "./ai-card";

/** Order detail (DESIGN.md screen 3, SPEC §6.1, P4-04): review an order and decide. */

const json = (v: unknown) => JSON.stringify(v ?? null, null, 2);

function WarehouseChip({ type, name }: { type: string; name: string }) {
  const cls = type === "EUSHIPMENTS" ? "bg-eu-chip text-eu-text" : "bg-fhb-chip text-fhb-text";
  return <span className={`rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${cls}`}>{name}</span>;
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAccountContext();
  const t = await getTranslations("orders");
  const r = await getTranslations("review");
  const st = await getTranslations("orderStatus");
  const locale = await getLocale();
  const format = await getFormatter();
  const openedAt = new Date().toISOString();
  let data;
  try {
    data = await getOrderReview(actorFrom(ctx), id);
  } catch (err) {
    if (err instanceof DomainError) notFound();
    throw err;
  }
  const { order, check } = data;
  const writeBacks = await orderWriteBacks(ctx.accountId, order.id);
  const tw = await getTranslations("fulfill.writeBack");
  const money = (v: unknown) => format.number(Number(v), { style: "currency", currency: order.currency });
  const when = (d: Date) => format.dateTime(d, { dateStyle: "medium", timeStyle: "short" });
  const msg = (f: Finding) => (locale === "en" ? f.message_en : f.message_bg);
  const risk = order.risk as { recommendation?: string; levels?: string[] } | null;

  // Original (Shopify) values next to the corrected ones, both normalised the same way.
  const originalRaw = order.shippingAddressOriginal as Parameters<typeof normaliseAddress>[0] | null;
  const original = originalRaw
    ? editorValues(
        normaliseAddress(originalRaw),
        shopifyPhone({ ...((order.raw ?? {}) as object), shippingAddress: originalRaw } as Parameters<
          typeof shopifyPhone
        >[0]),
      )
    : null;
  const statusLabel = st(order.status);
  const codes = data.reasonCodes.map((c) => ({
    code: c.code,
    label: locale === "en" ? c.labelEn : c.labelBg,
    decisions: c.decisions,
  }));

  const timelineText = (e: TimelineEntry) => {
    if (e.kind === "status")
      return e.from
        ? r("timeline.moved", { from: st(e.from), to: st(e.to) })
        : r("timeline.created", { to: st(e.to) });
    if (e.kind === "vendor")
      return r("timeline.vendor", { connection: e.connection, raw: e.rawStatus ?? "—" });
    return r("timeline.review", {
      decision: r.has(`decision.${e.decision}`) ? r(`decision.${e.decision}`) : e.decision,
    });
  };

  return (
    <>
      <PageHeader
        title={`${t("order")} ${order.number}`}
        subtitle={`${order.store?.name ?? "—"} · ${order.company?.name ?? "—"} · ${when(order.placedAt)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {can(ctx.role, "orders.fulfill") &&
              ["APPROVED", "SUBMIT_FAILED", "QUEUED"].includes(order.status) && (
                <FulfillButton orderId={order.id} />
              )}
            {can(ctx.role, "reviews.read") && (
              <Link href="/orders/reviews" className={ghostButtonCls + " inline-flex items-center"}>
                {r("reviewsLink")}
              </Link>
            )}
            <Link href="/orders" className={ghostButtonCls + " inline-flex items-center"}>
              {t("back")}
            </Link>
          </div>
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

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <h2 className="mt-0 text-base font-semibold">{t("customer")}</h2>
              <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted">{t("name")}</dt>
                <dd className="m-0">{order.customerName ?? "—"}</dd>
                <dt className="text-muted">{t("email")}</dt>
                <dd className="m-0 font-mono text-[13px]">{order.email ?? "—"}</dd>
                <dt className="text-muted">{t("payment")}</dt>
                <dd className="m-0">
                  {order.paymentMethod === "COD" ? `${t("cod")} · ${money(order.codAmount)}` : t("prepaid")}
                </dd>
              </dl>
              {order.note && <p className="mb-0 rounded-lg bg-hover px-3 py-2">{order.note}</p>}
              {risk?.recommendation && (
                <p className="mb-0 text-sm text-muted">
                  {t("risk")}: {risk.recommendation}{" "}
                  {risk.levels?.length ? `· ${risk.levels.join(", ")}` : ""}
                </p>
              )}
            </Card>
            <Card>
              <h2 className="mt-0 text-base font-semibold">{r("address.title")}</h2>
              <AddressEditor
                orderId={order.id}
                version={data.version}
                values={data.editor}
                original={original}
                editable={data.editable}
                canReview={data.canReview}
                statusLabel={statusLabel}
              />
            </Card>
          </div>

          <Card>
            <h2 className="mt-0 text-base font-semibold">{t("items")}</h2>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse" aria-label={t("items")}>
                <thead>
                  <tr>
                    <th className={thCls}>{t("product")}</th>
                    <th className={thCls}>{t("sku")}</th>
                    <th className={thCls}>{t("master")}</th>
                    <th className={`${thCls} text-right`}>{t("qty")}</th>
                    <th className={`${thCls} text-right`}>{t("unitPrice")}</th>
                    {data.connections.map((c) => (
                      <th key={c.id} className={`${thCls} text-right`}>
                        <WarehouseChip type={c.type} name={c.name} />
                      </th>
                    ))}
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
                      {data.connections.map((c) => {
                        const linked = l.productId ? data.stock.get(l.productId) : undefined;
                        const cell = linked?.get(c.id);
                        if (!linked?.has(c.id))
                          return (
                            <td key={c.id} className={`${tdCls} text-right text-sm text-muted`}>
                              {r("stock.noLink")}
                            </td>
                          );
                        if (!cell)
                          return (
                            <td key={c.id} className={`${tdCls} text-right text-sm text-muted`}>
                              {r("stock.noSnapshot")}
                            </td>
                          );
                        const short = cell.sellable < l.quantity;
                        return (
                          <td
                            key={c.id}
                            className={`${tdCls} text-right`}
                            title={r("stock.detail", {
                              free: cell.free,
                              physical: cell.physical,
                              reserved: cell.reserved,
                              source: cell.source,
                              age: format.relativeTime(cell.snapshotAt),
                            })}
                          >
                            <span className={`font-mono ${short ? "text-block" : "text-ok"}`}>
                              {r("stock.cell", { sellable: cell.sellable })}
                            </span>
                            {short && <div className="text-xs text-block">{r("stock.short")}</div>}
                            <div className="text-xs text-muted">{format.relativeTime(cell.snapshotAt)}</div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="mt-4 mb-0 ml-auto grid w-fit grid-cols-[max-content_max-content] gap-x-6 gap-y-1 text-right">
              <dt className="text-muted">{t("subtotal")}</dt>
              <dd className="m-0 font-mono">{money(order.subtotal)}</dd>
              <dt className="font-semibold">{t("total")}</dt>
              <dd className="m-0 font-mono font-semibold">{money(order.total)}</dd>
            </dl>
          </Card>

          <Card>
            <h2 className="mt-0 text-base font-semibold">{r("timeline.title")}</h2>
            {data.timeline.length === 0 ? (
              <p className="m-0 text-muted">{r("timeline.empty")}</p>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-2 p-0" data-testid="timeline">
                {data.timeline.map((e, i) => (
                  <li
                    key={i}
                    className="flex flex-wrap items-baseline gap-x-3 border-b border-line-soft pb-2"
                  >
                    <time className="font-mono text-xs text-muted" dateTime={e.at.toISOString()}>
                      {when(e.at)}
                    </time>
                    <span className="font-medium">{timelineText(e)}</span>
                    {e.kind === "status" && (
                      <span className="text-xs text-muted">
                        {e.cause}
                        {" · "}
                        {e.who ?? (e.actorType === "ai" ? r("timeline.ai") : r("timeline.system"))}
                        {e.reason ? ` · ${e.reason}` : ""}
                      </span>
                    )}
                    {e.kind === "vendor" && e.status && <StatusChip status={e.status} />}
                    {e.kind === "review" && (
                      <span className="text-xs text-muted">
                        {e.who ?? "—"}
                        {e.reasonCode ? ` · ${e.reasonCode}` : ""}
                        {e.reasonText ? ` · ${e.reasonText}` : ""}
                        {e.changes ? ` · ${r("timeline.changes", { n: e.changes })}` : ""}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <AiCard actor={actorFrom(ctx)} orderId={order.id} />
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="m-0 text-base font-semibold">{r("findings.title")}</h2>
              {data.canReview && <RecheckButton orderId={order.id} />}
            </div>
            {!check ? (
              <p className="mb-0 text-muted">{r("findings.noCheck")}</p>
            ) : (
              <>
                <p className="mt-1 text-sm text-muted">
                  {r("findings.checkedAt", { at: when(check.checkedAt) })} ·{" "}
                  {r("findings.summary", { hard: check.hardCount, soft: check.softCount })}
                </p>
                {check.findings.length === 0 ? (
                  <p className="m-0 rounded-lg bg-ok-bg px-3 py-2 text-ok">✓ {r("findings.none")}</p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="findings">
                    {check.findings.map((f, i) => (
                      <li
                        key={`${f.code}-${i}`}
                        className={`rounded-lg px-3 py-2 ${f.severity === "hard" ? "bg-block-bg" : "bg-warn-bg"}`}
                      >
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span
                            className={`text-xs font-semibold uppercase ${f.severity === "hard" ? "text-block" : "text-warn"}`}
                          >
                            {f.severity === "hard" ? r("findings.hard") : r("findings.soft")}
                          </span>
                          <span className="text-ink">{msg(f)}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                          <code className="font-mono">{f.code}</code>
                          {f.field && <code className="font-mono">{f.field}</code>}
                        </div>
                        {f.suggestedFix &&
                          (isEditableField(f.suggestedFix.field) && data.editable && data.canReview ? (
                            <div className="mt-2">
                              <ApplyFixButton
                                orderId={order.id}
                                version={data.version}
                                field={f.suggestedFix.field}
                                value={f.suggestedFix.value}
                                code={f.code}
                              />
                            </div>
                          ) : (
                            <p className="m-0 mt-1 text-sm text-muted">
                              {r("findings.suggestion", { value: f.suggestedFix.value })}
                              {f.suggestedFix.field.startsWith("cod")
                                ? ` · ${r("findings.shopifyOnly")}`
                                : ""}
                            </p>
                          ))}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Card>

          <Card>
            <h2 className="mt-0 text-base font-semibold">{r("routing.title")}</h2>
            {!check ? (
              <p className="m-0 text-muted">{r("routing.none")}</p>
            ) : (
              <>
                <p className="m-0" data-testid="review-routing">
                  {locale === "en" ? check.routing.explanation.en : check.routing.explanation.bg}
                </p>
                {check.routing.connectionName && check.routing.connectionType && (
                  <p className="m-0 mt-2 flex items-center gap-2">
                    <WarehouseChip type={check.routing.connectionType} name={check.routing.connectionName} />
                    {check.routing.crossCompany && (
                      <span className="text-xs text-warn">{r("routing.crossCompany")}</span>
                    )}
                  </p>
                )}
                {check.routing.steps.length > 0 && (
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer text-muted">{r("routing.steps")}</summary>
                    <ol className="mt-1 mb-0 pl-5">
                      {check.routing.steps.map((s) => (
                        <li key={s.ruleId}>
                          {r("routing.step", { number: s.number, name: s.name })}:{" "}
                          {r(`routing.outcome.${s.outcome}`, { failed: s.failed ?? "" })}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </>
            )}
          </Card>

          <Card>
            <h2 className="mt-0 text-base font-semibold">{r("payload.title")}</h2>
            {!data.payload ? (
              <p className="m-0 text-muted">
                {PAYLOAD_PREVIEW_STATUSES.includes(order.status) ? r("payload.noRoute") : r("payload.sent")}
              </p>
            ) : data.payload.body == null ? (
              <p className="m-0 text-muted" data-testid="payload-preview-blocked">
                {r("payload.blocked", { connection: data.payload.connection })}
              </p>
            ) : (
              <>
                <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-muted">
                  <WarehouseChip type={data.payload.connectionType} name={data.payload.connection} />
                  {r("payload.hint")}
                </p>
                <pre
                  data-testid="payload-preview"
                  className="mt-2 mb-0 max-h-96 overflow-auto rounded-lg bg-hover p-3 font-mono text-xs"
                >
                  {json(data.payload.body)}
                </pre>
              </>
            )}
          </Card>

          {data.canRaw && (
            <Card>
              <h2 className="mt-0 text-base font-semibold">{r("raw.title")}</h2>
              <div className="flex flex-col gap-2 text-sm">
                {(["shopify", "original", "routing", "outbox"] as const).map((k) => (
                  <RawDetails key={k} orderId={order.id} section={k} summary={r(`raw.${k}`)} />
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

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

      {data.canReview && (
        <DecisionBar
          orderId={order.id}
          allowed={data.decisions}
          hardCount={check?.hardCount ?? 0}
          changes={data.session?.diff.length ?? 0}
          codes={codes}
          openedAt={openedAt}
          canRelease={order.status === "ON_HOLD" && !order.tags.includes(SHOPIFY_TEST_TAG)}
          statusLabel={statusLabel}
        />
      )}
    </>
  );
}
