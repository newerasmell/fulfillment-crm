import { parseFhbDate } from "./client";
import {
  FHB_COD_STATUSES,
  type FhbCod,
  type FhbReturn,
  type FhbStockMovement,
  type FhbOrderListItem,
} from "./schemas";
import { mapFhbOrderStatus } from "./status-map";

/**
 * FHB read side → local mirror rows (pure, P2-02). Raw values are always kept next to mapped ones; nothing here
 * throws on an unknown enum value. EAN is never used to match anything (INTEGRATION_NOTES §2.1).
 */

/** The prefix of a connection rule `{prefix: "R"}` ("" when none). */
export function skuPrefixOf(skuPrefixRule: unknown): string {
  return skuPrefixRule &&
    typeof skuPrefixRule === "object" &&
    typeof (skuPrefixRule as { prefix?: unknown }).prefix === "string"
    ? (skuPrefixRule as { prefix: string }).prefix
    : "";
}

/**
 * The CRM SKU an FHB product id points to: the connection prefix stripped (the reverse of fhbProductId).
 * Ids without the prefix are taken as they are; an id that IS only the prefix gives null.
 */
export function crmSkuFromFhbId(vendorId: string, skuPrefixRule: unknown): string | null {
  const id = vendorId.trim();
  const prefix = skuPrefixOf(skuPrefixRule);
  const sku = prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id;
  return sku.trim() || null;
}

const amount = (v: number | null | undefined) =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;

/**
 * Mirror key of an FHB order: its id, or `uid:{uid}` for orders FHB lists without an id (created outside an
 * integration). Ours always have an id ({STORECODE}-{number}), so the two can never collide.
 */
export function fhbMirrorKey(v: { id?: string | null; uid?: string | null }) {
  return v.id ?? (v.uid ? `uid:${v.uid}` : null);
}

/** One order of order/history, GET /order or rma/list as a mirror row (null when it has neither id nor uid). */
export function mapFhbOrderMirror(v: FhbOrderListItem, opts: { fromRma?: boolean } = {}) {
  const externalId = fhbMirrorKey(v);
  if (!externalId) return null;
  const mapping = mapFhbOrderStatus(v.status, { returnedAt: v.returned_at });
  return {
    externalId,
    uid: v.uid ?? null,
    variableSymbol: v.variable_symbol ?? null,
    rawStatus: mapping.raw,
    status: mapping.status,
    alert: mapping.alert,
    parcelService: v.parcel_service ?? null,
    deliveryPoint: v.delivery_point ?? null,
    cod: amount(v.cod),
    value: amount(v.value),
    country: v.recipient?.address?.country?.toUpperCase() ?? null,
    recipientName: v.recipient?.address?.name ?? null,
    trackingNumbers: (v.tracking_numbers ?? []).filter(Boolean),
    vendorCreatedAt: parseFhbDate(v.created_at),
    shippedAt: parseFhbDate(v.shipped_at),
    deliveredAt: parseFhbDate(v.delivered_at),
    returnedAt: parseFhbDate(v.returned_at),
    returnType: v.return_type ?? null,
    inRma: opts.fromRma === true,
  };
}
export type FhbOrderMirrorRow = NonNullable<ReturnType<typeof mapFhbOrderMirror>>;

/** COD status: the documented three, anything else kept raw and flagged. */
export function mapFhbCodStatus(raw: string | null | undefined) {
  const value = raw?.trim() || null;
  const known = !!value && (FHB_COD_STATUSES as readonly string[]).includes(value.toLowerCase());
  return { raw: value, known, alert: !known && value !== null };
}

export function mapFhbCod(v: FhbCod) {
  const externalId = fhbMirrorKey(v);
  if (!externalId) return null;
  const status = mapFhbCodStatus(v.status);
  return {
    externalId,
    uid: v.uid ?? null,
    variableSymbol: v.variable_symbol ?? null,
    parcelService: v.parcel_service ?? null,
    cod: amount(v.cod),
    status: status.raw,
    unknownStatus: status.alert,
    receivedAt: parseFhbDate(v.received_at),
    paidAt: parseFhbDate(v.paid_at),
    vendorCreatedAt: parseFhbDate(v.created_at),
  };
}

export function mapFhbReturn(v: FhbReturn) {
  return {
    uid: v.uid,
    vendorId: v.id ?? null,
    depotId: v.depot_id ?? null,
    type: v.type ?? null,
    status: v.status ?? null,
    weight: typeof v.weight === "number" ? v.weight : null,
    barcodes: (v.barcodes ?? []).filter(Boolean),
    items: v.items ?? [],
    photos: v.photos ?? [],
    vendorCreatedAt: parseFhbDate(v.created_at),
  };
}

/** A movement row for StockMovement: kind = raw direction (in|out|…), quantity = signed change. */
export function mapFhbMovement(v: FhbStockMovement) {
  const change = typeof v.change === "number" ? Math.trunc(v.change) : 0;
  return {
    externalId: v.id,
    productId: v.product ?? null,
    kind: v.type?.trim() || "unknown",
    quantity: change,
    occurredAt: parseFhbDate(v.date),
    resulting: typeof v.quantity === "number" ? v.quantity : null,
    reason: v.reason ?? null,
    order: v.order ?? null,
    stockReceipt: v.stock_receipt ?? null,
  };
}

/** ISO date (YYYY-MM-DD, UTC) for the list filters documented as "ISO 8601 date". */
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
