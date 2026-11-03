import { parseFhbDate } from "./client";
import { normalisePhoneE164 } from "./phone";
import {
  FHB_NOTE_MAX,
  FHB_URL_MAX,
  FhbOrderCreate,
  FhbOrderUpdate,
  FhbProductCreate,
  FhbProductUpdate,
  FhbStockReceiptCreate,
  FhbStockReceiptUpdate,
  type FhbNotificationEvent,
  type FhbOrderView,
  type FhbProductView,
} from "./schemas";
import { mapFhbOrderStatus } from "./status-map";

/**
 * CRM ↔ FHB v3 mapping (pure). Identifier rules (INTEGRATION_NOTES §2.1):
 *  - product id = connection SKU prefix + CRM SKU, immutable at FHB (renames only via `new_id`);
 *  - EAN is sent on CREATE only; an update never carries it unless a person edited it in the CRM;
 *  - order id = `{STORECODE}-{shopify order number}` (unique per FHB account, several stores share one);
 *  - variable symbol comes from the per-connection numeric sequence (never the Shopify number).
 */

/** Connection rule `{prefix: "R"}` → FHB product id. */
export function fhbProductId(sku: string, skuPrefixRule: unknown): string {
  const prefix =
    skuPrefixRule &&
    typeof skuPrefixRule === "object" &&
    typeof (skuPrefixRule as { prefix?: unknown }).prefix === "string"
      ? (skuPrefixRule as { prefix: string }).prefix
      : "";
  return `${prefix}${sku.trim()}`;
}

/** `{STORECODE}-{number}` with the "#" and anything outside [A-Za-z0-9-] removed; `-2`, `-3` … for reships. */
export function fhbOrderExternalId(storeCode: string, orderNumber: string, attempt = 1): string {
  const number = orderNumber.replace(/^#/, "").replace(/[^A-Za-z0-9-]/g, "");
  if (!storeCode.trim() || !number) throw new Error("store code and order number are required");
  return `${storeCode.trim().toUpperCase()}-${number}${attempt > 1 ? `-${attempt}` : ""}`;
}

export const MAX_VARIABLE_SYMBOL = 9_999_999_999n;

/** Money for FHB: a number with at most 2 decimals. */
export const fhbAmount = (v: number) => Math.round(v * 100) / 100;

export interface FhbOrderDraft {
  externalId: string;
  variableSymbol: string;
  address: {
    name: string;
    street: string;
    city: string;
    zip: string;
    province?: string | null;
    country: string;
  };
  email: string;
  phone: string;
  /** The group's own phone rule for the destination (used only for a country the ITU table lacks). */
  phoneRule?: { cc: string; trunk: string } | null;
  /** FHB product ids with quantities; the same id on several lines is merged. */
  items: { id: string; quantity: number }[];
  /** Already in the destination's local currency. 0 / null = not COD. */
  cod?: number | null;
  /** Insurance value in local currency; omitted when null. */
  value?: number | null;
  parcelService?: string | null;
  deliveryPoint?: string | null;
  deliveryPointParameters?: Record<string, unknown> | null;
  sender?: string | null;
  note?: string | null;
  notification?: Partial<Record<FhbNotificationEvent, string>>;
}

function mergeItems(items: { id: string; quantity: number }[]) {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.id, (m.get(i.id) ?? 0) + i.quantity);
  return [...m].map(([id, quantity]) => ({ id, quantity }));
}

function orderCore(d: FhbOrderDraft) {
  const phone = normalisePhoneE164(d.phone, d.address.country, d.phoneRule) ?? d.phone.trim();
  const notification = Object.fromEntries(
    Object.entries(d.notification ?? {}).filter(([, url]) => !!url && url.length <= FHB_URL_MAX),
  );
  return {
    ...(d.parcelService ? { parcel_service: d.parcelService } : {}),
    ...(d.deliveryPoint ? { delivery_point: d.deliveryPoint } : {}),
    ...(d.deliveryPointParameters ? { delivery_point_parameters: d.deliveryPointParameters } : {}),
    ...(d.cod && d.cod > 0 ? { cod: fhbAmount(d.cod) } : {}),
    ...(d.value != null && d.value > 0 ? { value: fhbAmount(d.value) } : {}),
    ...(d.sender ? { sender: d.sender } : {}),
    recipient: {
      address: {
        name: d.address.name.trim(),
        street: d.address.street.trim(),
        city: d.address.city.trim(),
        zip: d.address.zip.trim(),
        ...(d.address.province?.trim() ? { province: d.address.province.trim() } : {}),
        country: d.address.country.trim().toUpperCase(),
      },
      contact: { email: d.email.trim(), phone },
    },
    items: mergeItems(d.items),
    ...(Object.keys(notification).length ? { notification } : {}),
    ...(d.note?.trim() ? { note: d.note.trim().slice(0, FHB_NOTE_MAX) } : {}),
  };
}

/** POST /order body. Always `validate: true` (FHB refuses undeliverable addresses at import). */
export function buildFhbOrderCreate(d: FhbOrderDraft): FhbOrderCreate {
  return FhbOrderCreate.parse({
    id: d.externalId,
    variable_symbol: d.variableSymbol,
    validate: true,
    ...orderCore(d),
  });
}

/** PUT /order?id= body (only while `pending`; replaces the line set). */
export function buildFhbOrderUpdate(d: FhbOrderDraft): FhbOrderUpdate {
  return FhbOrderUpdate.parse({ variable_symbol: d.variableSymbol, ...orderCore(d) });
}

export interface FhbProductDraft {
  vendorProductId: string;
  name: string;
  photo?: string | null;
  notifyUrl?: string | null;
  hsCode?: string | null;
  countryOfOrigin?: string | null;
  /** Multi-product components (FHB ids). */
  components?: { id: string; quantity: number }[];
}

function productCore(d: FhbProductDraft) {
  const customs = {
    ...(d.hsCode?.trim() ? { hs_code: d.hsCode.trim() } : {}),
    ...(d.countryOfOrigin && /^[A-Za-z]{2}$/.test(d.countryOfOrigin)
      ? { country_of_origin: d.countryOfOrigin.toUpperCase() }
      : {}),
  };
  return {
    name: d.name.trim(),
    ...(d.photo && d.photo.length <= FHB_URL_MAX ? { photo: d.photo } : {}),
    ...(d.notifyUrl ? { notify_url: d.notifyUrl } : {}),
    ...(d.components ? { type: "multi" as const, items: mergeItems(d.components) } : {}),
    ...(Object.keys(customs).length ? { customs_information: customs } : {}),
  };
}

/** POST /product body. The EAN is sent here and only here. */
export function buildFhbProductCreate(d: FhbProductDraft & { ean?: string | null }): FhbProductCreate {
  return FhbProductCreate.parse({
    id: d.vendorProductId,
    ...productCore(d),
    ...(d.ean?.trim() ? { ean: d.ean.trim() } : {}),
  });
}

/**
 * PUT /product?id= body. FHB may have corrected the EAN to the one on the box: `explicitEan` is only for a
 * value a person typed in the CRM, never for data synced from Shopify.
 */
export function buildFhbProductUpdate(
  d: FhbProductDraft & { explicitEan?: string | null; newId?: string | null },
): FhbProductUpdate {
  return FhbProductUpdate.parse({
    ...productCore(d),
    ...(d.explicitEan?.trim() ? { ean: d.explicitEan.trim() } : {}),
    ...(d.newId?.trim() && d.newId.trim() !== d.vendorProductId ? { new_id: d.newId.trim() } : {}),
  });
}

export interface FhbStockReceiptDraft {
  externalRef: string;
  name: string;
  items: { id: string; quantity: number }[];
  expectedDate?: string | null;
  trackingCode?: string | null;
  deliveryService?: string | null;
}

function receiptCore(d: FhbStockReceiptDraft) {
  return {
    name: d.name.trim(),
    ...(d.deliveryService ? { delivery_service: d.deliveryService } : {}),
    ...(d.trackingCode?.trim() ? { tracking_code: d.trackingCode.trim() } : {}),
    ...(d.expectedDate ? { expected_date: d.expectedDate } : {}),
    items: mergeItems(d.items),
  };
}

export const buildFhbStockReceiptCreate = (d: FhbStockReceiptDraft) =>
  FhbStockReceiptCreate.parse({ id: d.externalRef, ...receiptCore(d) });
export const buildFhbStockReceiptUpdate = (d: FhbStockReceiptDraft) =>
  FhbStockReceiptUpdate.parse(receiptCore(d));

/** What the CRM stores on a Fulfillment from an FHB order read (status mapped, raw kept). */
export function mapFhbOrderView(v: FhbOrderView) {
  const mapping = mapFhbOrderStatus(v.status, { returnedAt: v.returned_at });
  return {
    externalId: v.id,
    mapping,
    vendorUid: v.uid ?? null,
    variableSymbol: v.variable_symbol ?? null,
    carrier: v.parcel_service ?? null,
    trackingNumbers: (v.tracking_numbers ?? []).filter(Boolean),
    trackingUrls: (v.tracking_links ?? []).filter(Boolean),
    shippedAt: parseFhbDate(v.shipped_at),
    deliveredAt: parseFhbDate(v.delivered_at),
    returnInfo:
      v.returned_at || v.return_type || v.package_returns?.length
        ? {
            returnedAt: v.returned_at ?? null,
            returnType: v.return_type ?? null,
            packageReturns: v.package_returns ?? [],
          }
        : null,
  };
}

/** Stock and identity from an FHB product read. `free_quantity` is the sellable stock (§2.2). */
export function mapFhbProductView(v: FhbProductView) {
  return {
    vendorId: v.id,
    vendorCode: v.internal_code ?? null,
    vendorEan: v.ean ?? null,
    archived: v.archived === true,
    type: v.type ?? null,
    physical: v.stock_quantity ?? null,
    free: v.free_quantity ?? null,
  };
}
