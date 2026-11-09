import { orderNeighbours, orderListQuery, parseOrderListContext } from "@/server/orders";
import { OrderNav } from "../order-nav";
import { DesignToggle } from "../design-toggle";
import { CarrierPick } from "./carrier-pick";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { ghostButtonCls } from "@/components/ui/form";
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
  RESTARTABLE_STATUSES,
  type TimelineEntry,
} from "@/server/review";
import { normaliseAddress, shopifyPhone } from "@/server/shopify/orders";
import { CARRIER_TASK, CARRIER_UNKNOWN, orderWriteBacks } from "@/server/fulfill";
import { SHOPIFY_TRACKING_COMPANIES } from "@/integrations/shopify/fulfillments";
import { FulfillButton } from "../selection";
import { StatusChip } from "../status";
import {
  CHOICE_STATUSES,
  rerouteView,
  warehouseCancelView,
  warehouseOptions,
  warehouseReasonCodes,
} from "@/server/override";
import type { StockCheck } from "@/server/routing";
import {
  CancelCanaryConfirm,
  RerouteForm,
  WarehouseCancelButton,
  WarehouseChooser,
  type OptionView,
} from "./override-ui";
import { AddressEditor, ApplyFixButton, DecisionBar, RawDetails, RecheckButton } from "./review-ui";
import { AiCard } from "./ai-card";
import { CodEditor, CodRestoreButton, LineProductPicker, MarkGatewaysCodButton } from "./line-product-ui";
import { CopyValue } from "@/components/ui/CopyValue";
import { EditableCard } from "@/components/ui/EditableCard";
import { Field, fieldGridCls, Fold } from "@/components/ui/Fold";
import { ChevronDownIcon } from "@/components/ui/icons";
import { shopifyPaymentOf } from "@/server/shopify/payment-facts";
import { PhoneRuleForm } from "@/components/rules-weights/PhoneRuleForm";
import { WeightForm } from "@/components/rules-weights/WeightForm";
import {
  orderSourceFixes,
  PHONE_FINDING_CODES,
  productOfWeightFinding,
} from "@/server/countries/order-fixes";

/** Order detail (DESIGN.md screen 3, SPEC §6.1, P4-04): review an order and decide. */

const json = (v: unknown) => JSON.stringify(v ?? null, null, 2);

function WarehouseChip({ type, name }: { type: string; name: string }) {
  const cls = type === "EUSHIPMENTS" ? "bg-eu-chip text-eu-text" : "bg-fhb-chip text-fhb-text";
  return <span className={`rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${cls}`}>{name}</span>;
}

const WRITE_BACK_MUTATION = {
  FULFIL: "fulfillmentCreate",
  TRACKING: "fulfillmentTrackingInfoUpdate",
  EVENT: "fulfillmentEventCreate",
} as const;

export async function NewOrderView({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  // The orders list this page was opened from (tab + filters): J / K and "back" stay in it.
  const listCtx = parseOrderListContext((await searchParams) ?? {});
  const listQuery = orderListQuery(listCtx);
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
  const o = await getTranslations("override");
  const [wOptions, wCodes, rv, wc] = await Promise.all([
    warehouseOptions(actorFrom(ctx), order.id),
    warehouseReasonCodes(ctx.accountId),
    rerouteView(actorFrom(ctx), order.id),
    warehouseCancelView(actorFrom(ctx), order.id),
  ]);
  const cancelRow = (fulfillmentId: string) => wc.rows.find((x) => x.fulfillmentId === fulfillmentId) ?? null;
  /** What happened to the last "Откажи в склада" request (the sender's liveMode decision included). */
  const cancelRequestText = (req: NonNullable<(typeof wc.rows)[number]["request"]>) =>
    req.status === "REFUSED" && req.lastError === "read_only"
      ? o("warehouseCancel.request.READ_ONLY")
      : req.status === "FAILED" && req.lastError === "unauthenticated"
        ? o("warehouseCancel.request.FAILED_AUTH")
        : o.has(`warehouseCancel.request.${req.status}`)
          ? o(`warehouseCancel.request.${req.status}`)
          : o("warehouseCancel.request.other", { status: req.status });
  const optionView = (c: {
    id: string;
    name: string;
    type: string;
    companyName: string | null;
    crossCompany: boolean;
    stock: StockCheck;
  }): OptionView => ({
    id: c.id,
    name: c.name,
    type: c.type,
    companyName: c.companyName,
    crossCompany: c.crossCompany,
    stockStatus: c.stock.status,
    lines: c.stock.lines.map((l) => ({ title: l.title, need: l.need, available: l.available })),
  });
  const reasonCodes = wCodes.map((c) => ({ code: c.code, label: locale === "en" ? c.labelEn : c.labelBg }));
  const manual = check?.routing.via === "manual" ? (check.routing.manual ?? null) : null;
  const manualView = manual
    ? {
        who: manual.userName,
        via: manual.via,
        reason:
          ((locale === "en" ? manual.reasonLabel?.en : manual.reasonLabel?.bg) ?? manual.reasonCode) +
          (manual.reasonText ? ` — ${manual.reasonText}` : ""),
      }
    : null;
  const writeBacks = await orderWriteBacks(ctx.accountId, order.id);
  const nav = await orderNeighbours(ctx, order.id, listCtx);
  // Shipments whose Shopify tracking waits for a person to pick the carrier (one entry per shipment).
  const heldCarriers = [
    ...new Map(
      writeBacks
        .filter((w) => w.status === "AWAITING_CONFIRMATION" && w.lastError === CARRIER_UNKNOWN)
        .map((w) => [
          w.fulfillmentId,
          {
            fulfillmentId: w.fulfillmentId,
            carrier: w.fulfillment.carrier,
            tracking: w.kind === "TRACKING" ? w.value : w.trackingNumber,
          },
        ]),
    ).values(),
  ];
  // Fixes at the source (a country's phone rule, a product's weight) for the findings that allow them.
  const fixes = await orderSourceFixes(actorFrom(ctx), order, check?.findings ?? []);
  const cf = await getTranslations("countries");
  const wt = await getTranslations("weights");
  // The phone rule form is offered once, on the first phone finding.
  const phoneFixAt = (check?.findings ?? []).findIndex((f) => PHONE_FINDING_CODES.has(f.code));
  const tw = await getTranslations("fulfill.writeBack");
  const money = (v: unknown) => format.number(Number(v), { style: "currency", currency: order.currency });
  const when = (d: Date) => format.dateTime(d, { dateStyle: "medium", timeStyle: "short" });
  const msg = (f: Finding) => (locale === "en" ? f.message_en : f.message_bg);
  const payment = order.source === "SHOPIFY" ? shopifyPaymentOf(order.raw) : null;
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
    decisions: c.decisions.filter((k): k is "approve" | "hold" | "block" => k !== "warehouse"),
  }));

  /** Items grid: product · qty · price · one column per warehouse · actions (sm and wider). */
  const itemCols = `minmax(0,1fr) 64px 104px repeat(${data.connections.length}, minmax(112px,140px)) 80px`;
  const whTone = (type: string) =>
    type === "EUSHIPMENTS"
      ? {
          head: "border-eu bg-eu-chip/60 text-eu-text",
          cell: "border-eu bg-eu-chip/40",
          text: "text-eu-text",
        }
      : {
          head: "border-fhb bg-fhb-chip/60 text-fhb-text",
          cell: "border-fhb bg-fhb-chip/40",
          text: "text-fhb-text",
        };

  const timelineText = (e: TimelineEntry) => {
    if (e.kind === "status" && o.has(`timeline.${e.cause}`)) return o(`timeline.${e.cause}`);
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
          <div className="flex flex-wrap items-start gap-2">
            <OrderNav {...nav} query={listQuery} />
            <DesignToggle current="new" />
            {can(ctx.role, "orders.fulfill") &&
              ["APPROVED", "SUBMIT_FAILED", "QUEUED"].includes(order.status) && (
                <FulfillButton orderId={order.id} />
              )}
            {can(ctx.role, "reviews.read") && (
              <Link href="/orders/reviews" className={ghostButtonCls + " inline-flex items-center"}>
                {r("reviewsLink")}
              </Link>
            )}
            <Link
              href={listQuery ? `/orders?${listQuery}` : "/orders"}
              className={ghostButtonCls + " inline-flex items-center"}
            >
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
      {heldCarriers.length > 0 && (
        <CarrierPick
          orderId={order.id}
          shipments={heldCarriers}
          companies={SHOPIFY_TRACKING_COMPANIES}
          canSet={can(ctx.role, "orders.fulfill")}
        />
      )}
      {order.alerts
        .filter((a) => a.status !== "RESOLVED" && !(a.kind === CARRIER_TASK && heldCarriers.length > 0))
        .map((a) => (
          <p key={a.id} role="status" className="m-0 rounded-lg bg-warn-bg px-3 py-2 text-warn">
            {a.title}
          </p>
        ))}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="grid gap-5 md:grid-cols-2">
            <EditableCard
              title={t("customer")}
              editLabel={r("cod.edit")}
              editTestId="cod-edit-open"
              canEdit={data.editable && data.canReview}
              editor={
                <CodEditor
                  orderId={order.id}
                  current={
                    order.paymentMethod === "COD" && order.codAmount ? order.codAmount.toString() : null
                  }
                  total={order.total.toString()}
                  currency={order.currency}
                />
              }
            >
              <div className={fieldGridCls}>
                <Field label={t("name")}>
                  {order.customerName ? <CopyValue value={order.customerName} /> : "—"}
                </Field>
                <Field label={t("email")} wide>
                  {order.email ? <CopyValue value={order.email} mono /> : "—"}
                </Field>
                <Field label={t("payment")} wide>
                  <CopyValue
                    value={
                      order.paymentMethod === "COD" ? Number(order.codAmount ?? 0).toFixed(2) : t("prepaid")
                    }
                  >
                    {order.paymentMethod === "COD" ? (
                      <>
                        {t("cod")} · <strong>{money(order.codAmount)}</strong>
                      </>
                    ) : (
                      t("prepaid")
                    )}
                  </CopyValue>
                  {payment && payment.gateways.length > 0 && (
                    <div className="mt-0.5 text-xs text-muted" data-testid="payment-gateways">
                      Shopify: {payment.gateways.join(", ")}
                      {(payment.outstanding ?? 0) > 0 &&
                        ` · ${r("payment.outstanding", { amount: money(payment.outstanding) })}`}
                    </div>
                  )}
                  {order.codOverride && (
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                      <span data-testid="cod-manual">
                        {r("cod.manualBadge")}
                        {order.codOverride.note ? ` · ${order.codOverride.note}` : ""}
                      </span>
                      {data.editable && data.canReview && <CodRestoreButton orderId={order.id} />}
                    </div>
                  )}
                </Field>
                {risk?.recommendation && risk.recommendation.toUpperCase() !== "NONE" && (
                  <Field label={t("risk")} wide>
                    <span className="rounded-full bg-block-bg px-2 py-0.5 text-xs font-medium text-block">
                      {risk.recommendation}
                      {risk.levels?.length ? ` · ${risk.levels.join(", ")}` : ""}
                    </span>
                  </Field>
                )}
              </div>
              {order.note && <p className="mt-3 mb-0 rounded-lg bg-hover px-3 py-2 text-sm">{order.note}</p>}
            </EditableCard>
            <AddressEditor
              title={r("address.title")}
              orderId={order.id}
              version={data.version}
              values={data.editor}
              original={original}
              editable={data.editable}
              canReview={data.canReview}
              statusLabel={statusLabel}
            />
          </div>

          <Card>
            <h2 className="mt-0 mb-3 text-base font-semibold">{t("items")}</h2>
            <div
              role="table"
              aria-label={t("items")}
              className="flex flex-col gap-3 sm:gap-0"
              style={{ "--cols": itemCols } as React.CSSProperties}
            >
              <div
                role="row"
                className="hidden border-b border-line sm:grid sm:[grid-template-columns:var(--cols)]"
              >
                <div role="columnheader" className="px-3 py-2.5 text-[13px] font-bold text-black">
                  {t("product")}
                </div>
                <div role="columnheader" className="px-3 py-2.5 text-right text-[13px] font-bold text-black">
                  {t("qty")}
                </div>
                <div role="columnheader" className="px-3 py-2.5 text-right text-[13px] font-bold text-black">
                  {t("unitPrice")}
                </div>
                {data.connections.map((c) => (
                  <div
                    key={c.id}
                    role="columnheader"
                    className={`rounded-t-lg border-t-[3px] px-3 py-2.5 text-center text-[13px] font-bold uppercase ${whTone(c.type).head}`}
                  >
                    {c.name}
                  </div>
                ))}
                <div role="columnheader" aria-label={r("lineProduct.choose")} />
              </div>
              {order.lines.map((l) => (
                <div
                  key={l.id}
                  role="row"
                  className="relative flex flex-col gap-2 rounded-lg border border-line-soft p-3 sm:grid sm:gap-0 sm:rounded-none sm:border-0 sm:border-b sm:p-0 sm:[grid-template-columns:var(--cols)]"
                >
                  <div role="cell" className="min-w-0 pr-16 sm:px-3 sm:py-3.5 sm:pr-3">
                    <div className="font-medium">
                      <CopyValue value={l.title} />
                    </div>
                    {l.sku && (
                      <div className="text-xs text-muted">
                        <CopyValue value={l.sku} mono className="!text-xs" />
                      </div>
                    )}
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-label">
                      {l.product ? (
                        <>
                          <span aria-hidden>→</span>
                          <span className="font-mono" title={l.product.name}>
                            {l.product.sku}
                          </span>
                        </>
                      ) : (
                        <Link href="/products" className="text-warn hover:underline">
                          {t("unmatched")}
                        </Link>
                      )}
                      {l.productChoice && (
                        <span
                          className="rounded-full bg-hover px-1.5"
                          title={l.productChoice.note ?? undefined}
                          data-testid={`line-product-chosen-${l.id}`}
                        >
                          {r("lineProduct.chosenBadge")}
                          {l.productChoice.note ? ` · ${l.productChoice.note}` : ""}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-4 text-sm sm:contents">
                    <div role="cell" className="font-mono sm:px-3 sm:py-3.5 sm:text-right sm:self-center">
                      <span className="mr-1 font-sans text-muted sm:hidden">{t("qty")}</span>
                      {l.quantity}
                    </div>
                    <div role="cell" className="font-mono sm:px-3 sm:py-3.5 sm:text-right sm:self-center">
                      <span className="mr-1 font-sans text-muted sm:hidden">{t("unitPrice")}</span>
                      {money(l.unitPrice)}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:contents">
                    {data.connections.map((c) => {
                      const tone = whTone(c.type);
                      const linked = l.productId ? data.stock.get(l.productId) : undefined;
                      const cell = linked?.get(c.id);
                      const short = !!cell && cell.sellable < l.quantity;
                      return (
                        <div
                          key={c.id}
                          role="cell"
                          className={`flex flex-col justify-center rounded-lg border-t-[3px] px-3 py-2 text-left sm:rounded-none sm:border-t-0 sm:py-3.5 sm:text-center ${tone.cell}`}
                          title={
                            cell
                              ? r("stock.detail", {
                                  free: cell.free,
                                  physical: cell.physical,
                                  reserved: cell.reserved,
                                  source: cell.source,
                                  age: format.relativeTime(cell.snapshotAt),
                                })
                              : undefined
                          }
                        >
                          <span className={`text-[11px] font-bold uppercase sm:hidden ${tone.text}`}>
                            {c.name}
                          </span>
                          {!linked?.has(c.id) || !cell ? (
                            <span className="text-sm text-muted">
                              <span className="font-mono">—</span>{" "}
                              <span className="block text-xs">
                                {!linked?.has(c.id) ? r("stock.noLink") : r("stock.noSnapshot")}
                              </span>
                            </span>
                          ) : (
                            <span>
                              <span
                                className={`font-mono text-lg leading-tight font-semibold ${short ? "text-warn" : tone.text}`}
                              >
                                {cell.sellable}
                              </span>{" "}
                              <span className={`block text-xs ${short ? "text-warn" : "text-muted"}`}>
                                {short
                                  ? r("stock.shortNeeds", { need: l.quantity })
                                  : r("stock.sellableLabel")}
                              </span>
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div
                    role="cell"
                    className="absolute top-2 right-2 sm:static sm:flex sm:items-center sm:justify-end sm:px-2"
                  >
                    {data.editable && data.canReview && (
                      <LineProductPicker
                        orderId={order.id}
                        lineId={l.id}
                        title={l.title}
                        chosen={!!l.productChoice}
                        qty={l.quantity}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
            <dl className="mt-4 mb-0 ml-auto grid w-fit grid-cols-[max-content_max-content] gap-x-6 gap-y-1 text-right">
              <dt className="text-muted">{t("subtotal")}</dt>
              <dd className="m-0 font-mono">{money(order.subtotal)}</dd>
              <dt className="font-semibold">{t("total")}</dt>
              <dd className="m-0 font-mono font-semibold">{money(order.total)}</dd>
            </dl>
          </Card>

          <Card>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
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
                        {f.code === "order.payment_unclear" &&
                          payment &&
                          payment.gateways.length > 0 &&
                          can(ctx.role, "stores.manage") && (
                            <div className="mt-2">
                              <MarkGatewaysCodButton orderId={order.id} gateways={payment.gateways} />
                            </div>
                          )}
                        {fixes.phone && i === phoneFixAt && (
                          <details className="mt-2" data-testid="phone-rule-fix">
                            <summary className="cursor-pointer text-sm font-semibold text-accent">
                              {cf("addRule", { cc: fixes.phone.country })}
                            </summary>
                            <div className="mt-2 rounded-lg bg-surface p-3">
                              <PhoneRuleForm
                                country={fixes.phone.country}
                                initial={fixes.phone.initial}
                                samplePhone={fixes.phone.samplePhone}
                                needsCurrency={fixes.phone.needsCurrency}
                                defaultCurrency={fixes.phone.defaultCurrency}
                                canRemove={false}
                              />
                            </div>
                          </details>
                        )}
                        {(() => {
                          const pid = productOfWeightFinding(f);
                          const w = pid ? fixes.weights.get(pid) : undefined;
                          if (!w) return null;
                          return (
                            <details className="mt-2" data-testid="weight-fix" open>
                              <summary className="cursor-pointer text-sm font-semibold text-accent">
                                {wt("enter")} · {w.label}
                              </summary>
                              <div className="mt-2 rounded-lg bg-surface p-3">
                                <WeightForm
                                  productId={w.productId}
                                  productLabel={w.label}
                                  current={w.current}
                                  suggestions={w.suggestions}
                                  shopifyAllowed={w.shopifyAllowed}
                                  compact
                                />
                              </div>
                            </details>
                          );
                        })()}
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
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Card>
            <h2 className="mt-0 text-base font-semibold">{o("title")}</h2>
            <p className="mt-0 mb-2 text-sm text-muted">{o("subtitle")}</p>
            <WarehouseChooser
              orderId={order.id}
              options={wOptions.map(optionView)}
              currentId={check?.connectionId ?? null}
              routedId={manual ? manual.routed.connectionId : (check?.routing.connectionId ?? null)}
              manual={manualView}
              codes={reasonCodes}
              canChoose={data.canReview && CHOICE_STATUSES.includes(order.status)}
            />
            {data.canReview && !CHOICE_STATUSES.includes(order.status) && (
              <p className="mb-0 text-xs text-muted">{o("notNow", { status: statusLabel })}</p>
            )}
            <details className="group mt-3 border-t border-line-soft pt-3">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm text-muted [&::-webkit-details-marker]:hidden">
                <span className="transition-transform group-open:rotate-180">
                  <ChevronDownIcon />
                </span>
                {r("routing.title")} — {r("routing.why")}
              </summary>
              <div className="mt-2 text-sm">
                {!check ? (
                  <p className="m-0 text-muted">{r("routing.none")}</p>
                ) : (
                  <>
                    <p className="m-0" data-testid="review-routing">
                      {locale === "en" ? check.routing.explanation.en : check.routing.explanation.bg}
                    </p>
                    {check.routing.connectionName && check.routing.connectionType && (
                      <p className="m-0 mt-2 flex items-center gap-2">
                        <WarehouseChip
                          type={check.routing.connectionType}
                          name={check.routing.connectionName}
                        />
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
              </div>
            </details>
          </Card>

          <AiCard actor={actorFrom(ctx)} orderId={order.id} />

          <Fold
            title={o("shipments.title")}
            hint={data.fulfillments.length}
            testId="fold-shipments"
            open={!!rv.open}
          >
            {data.fulfillments.length === 0 ? (
              <p className="m-0 text-muted">{o("shipments.none")}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="shipments">
                {data.fulfillments.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-2 border-b border-line-soft pb-2">
                    <WarehouseChip type={f.connectionType} name={f.connection} />
                    <span className="font-mono text-[13px]">{f.externalId}</span>
                    <StatusChip status={f.status} />
                    {f.rawStatus && (
                      <span className="text-xs text-muted">
                        {o("shipments.raw")}: {f.rawStatus}
                      </span>
                    )}
                    {(() => {
                      const row = cancelRow(f.id);
                      if (!row) return null;
                      return (
                        <div
                          className="flex w-full flex-col gap-1"
                          data-testid={`warehouse-cancel-row-${f.externalId}`}
                        >
                          {row.request && (
                            <span className="text-xs text-muted" data-testid="warehouse-cancel-request">
                              {cancelRequestText(row.request)}
                              {row.request.status === "FAILED" && row.request.lastError
                                ? ` (${row.request.lastError})`
                                : ""}
                            </span>
                          )}
                          {row.request &&
                            row.liveMode === "CANARY" &&
                            !row.request.confirmedAt &&
                            ["PENDING", "AWAITING_CONFIRMATION"].includes(row.request.status) &&
                            can(ctx.role, "outbox.confirmCanary") && (
                              <CancelCanaryConfirm requestId={row.request.id} />
                            )}
                          {!wc.canCancel ? null : row.refusal === null ? (
                            <WarehouseCancelButton
                              orderId={order.id}
                              fulfillmentId={f.id}
                              externalId={f.externalId}
                              connection={f.connection}
                              connectionType={f.connectionType}
                              liveMode={row.liveMode}
                              codes={reasonCodes}
                            />
                          ) : row.refusal === "label" && row.manualShipmentId ? (
                            <Link
                              href={`/manual-shipments/${encodeURIComponent(row.manualShipmentId)}`}
                              className="text-xs text-accent hover:underline"
                            >
                              {o("warehouseCancel.refusal.label")}
                            </Link>
                          ) : (
                            <span className="text-xs text-muted" data-testid="warehouse-cancel-refusal">
                              {o.has(`warehouseCancel.refusal.${row.refusal}`)
                                ? o(`warehouseCancel.refusal.${row.refusal}`)
                                : o("warehouseCancel.refusal.vendor")}
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </li>
                ))}
              </ul>
            )}
            {rv.open && (
              <div
                className="mt-3 flex flex-col gap-2 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn"
                data-testid="reroute-open"
              >
                <span className="font-semibold">
                  {o("reroute.pending", {
                    from: rv.shipment?.connectionName ?? "—",
                    to: rv.history.find((h) => h.id === rv.open!.id)?.toConnection.name ?? "—",
                  })}
                </span>
                {rv.open.request && (
                  <span>{o("reroute.requestStatus", { status: rv.open.request.status })}</span>
                )}
                {rv.open.request &&
                  rv.shipment?.liveMode === "CANARY" &&
                  !rv.open.request.confirmedAt &&
                  ["PENDING", "AWAITING_CONFIRMATION"].includes(rv.open.request.status) &&
                  can(ctx.role, "outbox.confirmCanary") && (
                    <CancelCanaryConfirm requestId={rv.open.request.id} />
                  )}
              </div>
            )}
            {rv.shipment && !rv.open && (
              <div className="mt-3 flex flex-col gap-2">
                {!rv.canReroute ? (
                  <p className="m-0 text-xs text-muted">{o("reroute.onlyAdmins")}</p>
                ) : rv.refusal ? (
                  <p className="m-0 text-xs text-muted" data-testid="reroute-refusal">
                    {o(`reroute.refusal.${rv.refusal}`)}
                  </p>
                ) : (
                  <RerouteForm
                    orderId={order.id}
                    from={rv.shipment.connectionName}
                    targets={rv.targets.map(optionView)}
                    codes={reasonCodes}
                  />
                )}
              </div>
            )}
            {rv.history.length > 0 && (
              <details className="mt-3 text-sm" open={rv.history.some((h) => h.status !== "DONE")}>
                <summary className="cursor-pointer text-muted">{o("reroute.history")}</summary>
                <ul className="mt-1 mb-0 flex list-none flex-col gap-1 p-0" data-testid="reroute-history">
                  {rv.history.map((h) => (
                    <li key={h.id} className="flex flex-wrap gap-2">
                      <time className="font-mono text-xs text-muted">{when(h.createdAt)}</time>
                      <span>→ {h.toConnection.name}</span>
                      <span className="font-medium">{o(`reroute.status.${h.status}`)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Fold>

          <Fold title={r("payload.title")} hint={data.payload?.connection} testId="fold-payload">
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
          </Fold>

          {writeBacks.length > 0 && (
            <Fold title={tw("title")} hint={writeBacks.length} testId="fold-writeback">
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {writeBacks.map((w) => (
                  <li key={w.id} data-testid="writeback" data-kind={w.kind} className="flex flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-3">
                      <span className="text-sm font-medium">{tw(`kind.${w.kind}`)}</span>
                      <span className="font-mono text-[13px]">
                        {w.kind === "EVENT"
                          ? tw(`event.${w.value}`)
                          : w.kind === "TRACKING"
                            ? w.value
                            : (w.trackingNumber ?? tw("noTracking"))}
                      </span>
                      <span className="rounded-full bg-hover px-2 py-0.5 text-xs">
                        {tw(`status.${w.status}`)}
                      </span>
                      {w.lastError && <span className="text-sm text-warn">{w.lastError}</span>}
                    </span>
                    {w.request && can(ctx.role, "outbox.payloads") && (
                      <details>
                        <summary className="text-sm text-muted">
                          {tw("request", { mutation: WRITE_BACK_MUTATION[w.kind] })}
                        </summary>
                        <pre className="m-0 overflow-auto rounded-lg bg-hover p-3 font-mono text-xs">
                          {JSON.stringify(
                            (w.request as { variables?: unknown }).variables ?? w.request,
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    )}
                    {w.lastResponse && can(ctx.role, "outbox.payloads") && (
                      <details>
                        <summary className="text-sm text-muted">{tw("response")}</summary>
                        <pre className="m-0 overflow-auto rounded-lg bg-hover p-3 font-mono text-xs">
                          {JSON.stringify(w.lastResponse, null, 2)}
                        </pre>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </Fold>
          )}

          {data.canRaw && (
            <Fold title={r("raw.title")} testId="fold-raw">
              <div className="flex flex-col gap-2 text-sm">
                {(["shopify", "original", "routing", "outbox"] as const).map((k) => (
                  <RawDetails key={k} orderId={order.id} section={k} summary={r(`raw.${k}`)} />
                ))}
              </div>
            </Fold>
          )}
        </div>
      </div>

      <Fold
        title={r("timeline.title")}
        hint={r("timeline.count", { n: data.timeline.length })}
        testId="fold-timeline"
      >
        {data.timeline.length === 0 ? (
          <p className="m-0 text-muted">{r("timeline.empty")}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-2 p-0" data-testid="timeline">
            {data.timeline.map((e, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3 border-b border-line-soft pb-2">
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
      </Fold>

      {data.canReview && (
        <DecisionBar
          orderId={order.id}
          allowed={data.decisions}
          hardCount={check?.hardCount ?? 0}
          changes={data.session?.diff.length ?? 0}
          codes={codes}
          openedAt={openedAt}
          canRelease={order.status === "ON_HOLD" && !order.tags.includes(SHOPIFY_TEST_TAG)}
          canRestart={
            (RESTARTABLE_STATUSES as readonly string[]).includes(order.status) &&
            data.fulfillments.every((f) => f.status === "CANCELLED" || f.status === "SUBMIT_FAILED")
          }
          afterWarehouse={(RESTARTABLE_STATUSES as readonly string[]).includes(order.status)}
          statusLabel={statusLabel}
        />
      )}
    </>
  );
}
