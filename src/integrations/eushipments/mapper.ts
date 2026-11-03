import { normalisePhone, type PhoneResult, type PhoneRule } from "./phone";
import type { CreateOrderBody, CreateProductBody, CreateRequestBody, CreateTransferBody } from "./schemas";

/**
 * CRM → euShipments payload builders. Pure: no DB, no network. Field names and limits come from
 * docs/integrations/eushipments.md; the business rules from INTEGRATION_NOTES §4.
 * Missing values are JSON null / omitted — never the string "null".
 */

const toCents = (v: string | number) => Math.round(Number(v) * 100);
const fromCents = (c: number) => Math.round(c) / 100;

export interface PricedLine {
  refNumber: string;
  qty: number;
  /** Unit price after discounts, in the order currency. */
  unitPrice: string | number;
}

export type PriceDistribution =
  | { ok: true; lines: { refNumber: string; qty: number; price: number }[] }
  | { ok: false; reason: "no_lines" | "cannot_split_rounding" };

/**
 * Unit prices whose Σ(price × qty) equals the COD exactly (cash-receipt senders, INTEGRATION_NOTES §4.3).
 * Line totals after discounts are scaled to the COD (which is in the destination currency and may include
 * shipping), rounded to cents per unit, and the rounding difference is put on the LAST line whose quantity
 * divides it (normally a qty-1 line). If no line can take it, the operator has to decide (never guessed).
 */
export function distributeCod(lines: PricedLine[], cod: string | number): PriceDistribution {
  if (!lines.length) return { ok: false, reason: "no_lines" };
  const codCents = toCents(cod);
  const totals = lines.map((l) => toCents(l.unitPrice) * l.qty);
  const sum = totals.reduce((a, b) => a + b, 0);
  const weights = sum > 0 ? totals : lines.map((l) => l.qty); // all-free lines: split by quantity
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const units = lines.map((l, i) => Math.round((codCents * weights[i]!) / weightSum / l.qty));
  const diff = codCents - units.reduce((a, u, i) => a + u * lines[i]!.qty, 0);
  if (diff !== 0) {
    let idx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const q = lines[i]!.qty;
      if (diff % q === 0 && units[i]! + diff / q >= 0) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return { ok: false, reason: "cannot_split_rounding" };
    units[idx]! += diff / lines[idx]!.qty;
  }
  return {
    ok: true,
    lines: lines.map((l, i) => ({ refNumber: l.refNumber, qty: l.qty, price: fromCents(units[i]!) })),
  };
}

/** Σ(price × qty) in cents, for the validator. Lines without a price count as 0. */
export function productsSumCents(products: { qty: number; price?: number }[]) {
  return products.reduce((a, p) => a + toCents(p.price ?? 0) * p.qty, 0);
}

export interface OrderAddress {
  name?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  countryCode?: string | null;
  phone?: string | null;
}

export interface BuildOrderInput {
  /** Our deterministic {STORECODE}-{number}: awb.referenceNumber (unique in OUR DB, not at the vendor). */
  referenceNumber: string;
  senderId: number;
  /** YYYY-MM-DD, today … +9 days. */
  waybillAvailableDate: string;
  courierId?: number | null;
  serviceName?: CreateOrderBody["serviceName"];
  address: OrderAddress;
  /** Order-level phone (fallback when the address has none). */
  phone?: string | null;
  /** The group's own phone rule for the destination (only for a country without a built-in rule). */
  phoneRule?: PhoneRule | null;
  email?: string | null;
  /** PUDO: office id from offices-by-courier (INTEGRATION_NOTES §4.3 — never the streetName keyword). */
  officeId?: number | null;
  /** COD in the destination country's local currency; null/0 for prepaid. */
  codLocal?: string | number | null;
  lines: PricedLine[];
  totalWeightKg: number;
  /** Sender has the Econt/Speedy cash-receipt configuration. */
  cashReceiptCod: boolean;
  shipmentPayer?: "sender" | "recipient";
  observations?: string | null;
}

export interface BuiltOrder {
  body: CreateOrderBody;
  phone: PhoneResult;
  priceProblem: Extract<PriceDistribution, { ok: false }>["reason"] | null;
}

const clean = (v: string | null | undefined) => {
  const t = (v ?? "").replace(/\s+/g, " ").trim();
  return t ? t : null;
};

/**
 * Builds the create-order body. Values are NOT truncated here — over-long values fail the validator
 * (hard block) or produce a truncation warning (addressText / buildingNumber are cut by the vendor).
 * The phone is sent normalised when possible (validators block when it is not).
 */
export function buildCreateOrder(input: BuildOrderInput): BuiltOrder {
  const a = input.address;
  const country = clean(a.countryCode)?.toUpperCase() ?? null;
  const phone = normalisePhone(a.phone ?? input.phone, country, input.phoneRule);
  const cod = input.codLocal == null ? 0 : Number(input.codLocal);

  let products: CreateOrderBody["products"] = input.lines.map((l) => ({
    refNumber: l.refNumber,
    qty: l.qty,
  }));
  let priceProblem: BuiltOrder["priceProblem"] = null;
  if (cod > 0) {
    const d = distributeCod(input.lines, cod);
    if (d.ok) products = d.lines;
    // Prices are only mandatory-exact for cash-receipt senders; others simply go without prices.
    else if (input.cashReceiptCod) priceProblem = d.reason;
  }

  const toOffice = input.officeId != null;
  const addressText = [clean(a.address2), clean(a.company)].filter(Boolean).join(", ") || null;
  const body: CreateOrderBody = {
    senderId: input.senderId,
    ...(input.courierId ? { courierId: input.courierId } : {}),
    waybillAvailableDate: input.waybillAvailableDate,
    ...(input.serviceName ? { serviceName: input.serviceName } : {}),
    recipient: {
      name: clean(a.name) ?? "",
      countryIsoCode: country,
      cityName: clean(a.city),
      zipCode: clean(a.zip),
      region: clean(a.province),
      officeId: toOffice ? input.officeId : null,
      streetName: toOffice ? null : clean(a.address1),
      buildingNumber: null,
      addressText,
      contactPerson: clean(a.name),
      phoneNumber: phone.ok ? phone.value : (clean(phone.original) ?? ""),
      email: clean(input.email),
    },
    awb: {
      parcels: 1,
      envelopes: 0,
      totalWeight: Math.max(0.01, Math.round(input.totalWeightKg * 1000) / 1000),
      bankRepayment: fromCents(toCents(cod)),
      ...(input.shipmentPayer ? { shipmentPayer: input.shipmentPayer } : {}),
      ...(input.observations ? { observations: input.observations } : {}),
      referenceNumber: input.referenceNumber,
    },
    products,
  };
  return { body, phone, priceProblem };
}

export interface ProductMaster {
  name: string;
  /** refNumber at euShipments (SKU with the connection's prefix rule applied). */
  refNumber: string;
  barcode: string;
  description?: string | null;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  hsCode?: string | null;
}

const mmToCm = (mm: number | null) => (mm == null ? null : Math.round(mm) / 10);
const gToKg = (g: number | null) => (g == null ? null : Math.round(g) / 1000);

/**
 * create-product body. The four size/weight fields are required flat fields at the vendor (cm / kg);
 * returns null for each one that is missing so the caller blocks creation (INTEGRATION_NOTES §4.2).
 */
export function buildCreateProduct(companyId: number, p: ProductMaster) {
  const dims = {
    length: mmToCm(p.lengthMm),
    width: mmToCm(p.widthMm),
    height: mmToCm(p.heightMm),
    weight: gToKg(p.weightGrams),
  };
  const missing = Object.entries(dims)
    .filter(([, v]) => v == null || v <= 0)
    .map(([k]) => k);
  if (missing.length) return { ok: false as const, missing };
  const body: CreateProductBody = {
    companyId,
    product: {
      name: p.name,
      barcode: p.barcode,
      refNumber: p.refNumber,
      ...(p.description ? { description: p.description } : {}),
      length: dims.length!,
      width: dims.width!,
      height: dims.height!,
      weight: dims.weight!,
      ...(p.hsCode ? { hsCode: p.hsCode } : {}),
    },
  };
  return { ok: true as const, body };
}

/** The connection's SKU prefix rule ({"prefix":"SK-"}) applied to a master SKU. */
export function vendorRefNumber(sku: string, rule: unknown): string {
  const prefix =
    rule && typeof rule === "object" && typeof (rule as { prefix?: unknown }).prefix === "string"
      ? (rule as { prefix: string }).prefix
      : "";
  return prefix && !sku.startsWith(prefix) ? `${prefix}${sku}` : sku;
}

/** Deterministic transfer externalRef derived from our transfer row (unique per company at the vendor). */
export const transferExternalRef = (transferId: string) => `CRM-TRF-${transferId}`;

/** Booking request body: our inbound document number goes into clientReference (printable ASCII ≤100). */
export function buildCreateRequest(input: {
  companyId: number;
  warehouseId: number;
  clientReference: string;
  deliveryDate?: string | null;
  courierInc?: string | null;
  trackNumb?: string | null;
  packagesCount?: number | null;
  products: { refNumber: string; quantity: number }[];
}): CreateRequestBody {
  return {
    companyId: input.companyId,
    warehouseId: input.warehouseId,
    // "If sent, cannot be empty": only sent when there is a value.
    ...(clean(input.courierInc) ? { courierInc: clean(input.courierInc)! } : {}),
    ...(clean(input.trackNumb) ? { trackNumb: clean(input.trackNumb)! } : {}),
    ...(input.deliveryDate ? { deliveryDate: input.deliveryDate } : {}),
    ...(input.packagesCount ? { packagesCount: input.packagesCount } : {}),
    clientReference: input.clientReference,
    products: input.products,
  };
}

export function buildCreateTransfer(input: {
  companyId: number;
  transferId: string;
  sourceWarehouseId: number;
  destinationWarehouseId?: number | null;
  protocolType: 1 | 3;
  comments?: string | null;
  items: { refNumber: string; quantity: number; batchNo?: string | null; batchDate?: string | null }[];
}): CreateTransferBody {
  return {
    companyId: input.companyId,
    sourceWarehouseId: input.sourceWarehouseId,
    ...(input.destinationWarehouseId ? { destinationWarehouseId: input.destinationWarehouseId } : {}),
    protocolType: input.protocolType,
    ...(clean(input.comments) ? { comments: clean(input.comments)! } : {}),
    externalRef: transferExternalRef(input.transferId),
    items: input.items.map((i) => ({
      refNumber: i.refNumber,
      quantity: i.quantity,
      ...(i.batchNo && i.batchDate ? { batchNo: i.batchNo, batchDate: i.batchDate } : {}),
    })),
  };
}
