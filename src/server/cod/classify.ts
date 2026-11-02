/**
 * COD board (P6-02): pure part. One row per CRM shipment with cash on delivery: what we expect (the order's COD
 * in the destination country's local currency, CLAUDE.md) against what the warehouse reports —
 *   FHB         cod/list (FhbCodMirror): waiting | received | paid, amount in local currency;
 *   euShipments check-cod-by-order (EushipmentsTracking): COD amount once registered, payout protocol + date.
 * Ageing counts days since delivery for delivered shipments whose COD is not paid out yet.
 */

/** not_covered: the warehouse COD data was never read for this shipment (sync not run yet, or outside its window). */
export const COD_STATES = ["none", "not_covered", "waiting", "received", "paid", "unknown"] as const;
export type CodVendorState = (typeof COD_STATES)[number];
export const COD_BUCKETS = ["in_transit", "d0_7", "d8_14", "d15_30", "d30_plus", "paid"] as const;
export type CodBucket = (typeof COD_BUCKETS)[number];
export const COD_MISMATCHES = ["amount", "missing", "unexpected"] as const;
export type CodMismatch = (typeof COD_MISMATCHES)[number];

export interface CodShipmentIn {
  fulfillmentId: string;
  connectionType: string;
  status: string;
  codStatus: string | null;
  deliveredAt: Date | null;
  order: {
    paymentMethod: string;
    currency: string;
    codAmount: number | null;
    codLocalAmount: number | null;
    codLocalCurrency: string | null;
  };
  fhb: { cod: number | null; status: string | null; receivedAt: Date | null; paidAt: Date | null } | null;
  /**
   * FHB: when the last good cod/list run covered this shipment (its window includes the shipment's creation);
   * null when the cod sync never succeeded for the connection or the shipment is outside that window.
   */
  fhbCodCheckedAt?: Date | null;
  eu: {
    codAmount: string | null;
    codPaidAt: Date | null;
    codPaidNumber: string | null;
    codCheckedAt: Date | null;
    /** Last read error on the tracking row (a failed check-cod-by-order stores its error here). */
    lastError?: string | null;
  } | null;
}

export interface CodRow {
  expected: { amount: number; currency: string } | null;
  vendor: {
    state: CodVendorState;
    raw: string | null;
    amount: number | null;
    receivedAt: Date | null;
    paidAt: Date | null;
    protocol: string | null;
    checkedAt: Date | null;
  };
  delivered: boolean;
  ageDays: number | null;
  bucket: CodBucket;
  mismatch: CodMismatch | null;
}

const cents = (n: number) => Math.round(n * 100);
const DAY = 86_400_000;

export function bucketOf(ageDays: number): Exclude<CodBucket, "in_transit" | "paid"> {
  if (ageDays <= 7) return "d0_7";
  if (ageDays <= 14) return "d8_14";
  if (ageDays <= 30) return "d15_30";
  return "d30_plus";
}

function vendorOf(s: CodShipmentIn): CodRow["vendor"] {
  const none = {
    state: "none" as CodVendorState,
    raw: null,
    amount: null,
    receivedAt: null,
    paidAt: null,
    protocol: null,
    checkedAt: null,
  };
  if (s.connectionType === "FHB_V3") {
    const checkedAt = s.fhbCodCheckedAt ?? null;
    if (!s.fhb) return { ...none, state: checkedAt ? "none" : "not_covered", checkedAt };
    const raw = s.fhb.status?.trim() || null;
    const v = raw?.toLowerCase();
    const state: CodVendorState =
      v === "paid" || v === "received" || v === "waiting" ? v : raw ? "unknown" : "none";
    return {
      ...none,
      state,
      raw,
      amount: s.fhb.cod,
      receivedAt: s.fhb.receivedAt,
      paidAt: s.fhb.paidAt,
      checkedAt,
    };
  }
  if (s.connectionType === "EUSHIPMENTS") {
    const t = s.eu;
    const amount = t?.codAmount != null && t.codAmount.trim() !== "" ? Number(t.codAmount) : null;
    const paid = !!t?.codPaidAt || s.codStatus === "PAID" || s.status === "COD_PAID";
    const registered = amount != null && Number.isFinite(amount);
    // A failed check-cod-by-order also stamps codCheckedAt (with lastError): that is not an answer.
    const answered = !!t?.codCheckedAt && (registered || !t.lastError);
    return {
      ...none,
      state: paid ? "paid" : registered ? "received" : "none",
      raw: paid ? "paid" : registered ? "registered" : null,
      amount: registered ? amount : null,
      paidAt: t?.codPaidAt ?? null,
      protocol: t?.codPaidNumber ?? null,
      checkedAt: answered ? (t?.codCheckedAt ?? null) : null,
    };
  }
  return none;
}

export function classifyCod(s: CodShipmentIn, opts: { now: Date; missingDays: number }): CodRow {
  const isCod = s.order.paymentMethod === "COD";
  const expected = isCod
    ? s.order.codLocalAmount != null
      ? { amount: s.order.codLocalAmount, currency: s.order.codLocalCurrency ?? s.order.currency }
      : s.order.codAmount != null
        ? { amount: s.order.codAmount, currency: s.order.currency }
        : null
    : null;
  const vendor = vendorOf(s);
  const delivered = !!s.deliveredAt || s.status === "DELIVERED" || s.status === "COD_PAID";
  const ageDays =
    delivered && s.deliveredAt
      ? Math.max(0, Math.floor((opts.now.getTime() - s.deliveredAt.getTime()) / DAY))
      : null;
  const bucket: CodBucket =
    vendor.state === "paid" ? "paid" : !delivered ? "in_transit" : bucketOf(ageDays ?? 0);

  let mismatch: CodMismatch | null = null;
  if (!isCod) {
    if (vendor.amount != null && cents(vendor.amount) > 0) mismatch = "unexpected";
  } else if (expected && vendor.amount != null && cents(vendor.amount) !== cents(expected.amount)) {
    mismatch = "amount";
  } else if (
    vendor.state === "none" &&
    delivered &&
    s.deliveredAt &&
    ageDays != null &&
    ageDays >= opts.missingDays &&
    vendor.checkedAt &&
    vendor.checkedAt.getTime() >= s.deliveredAt.getTime() + opts.missingDays * DAY
  ) {
    // Only when the warehouse was actually asked successfully (FHB cod/list covering this shipment,
    // euShipments check-cod-by-order) at least missingDays after delivery and still had nothing.
    mismatch = "missing";
  }
  return { expected, vendor, delivered, ageDays, bucket, mismatch };
}

export interface Totals {
  currency: string;
  expected: number;
  received: number;
  paid: number;
  outstanding: number;
  count: number;
}

/** Sums by currency (and optionally by a key such as the company), amounts in the local currency. */
export function totalsBy<K extends string>(rows: { key: K; row: CodRow }[]): Map<K, Map<string, Totals>> {
  const out = new Map<K, Map<string, Totals>>();
  for (const { key, row } of rows) {
    const currency = row.expected?.currency ?? "—";
    const byCur = out.get(key) ?? new Map<string, Totals>();
    out.set(key, byCur);
    const t = byCur.get(currency) ?? {
      currency,
      expected: 0,
      received: 0,
      paid: 0,
      outstanding: 0,
      count: 0,
    };
    byCur.set(currency, t);
    const exp = row.expected?.amount ?? 0;
    const got = row.vendor.amount ?? exp;
    t.count++;
    t.expected = (cents(t.expected) + cents(exp)) / 100;
    if (row.vendor.state === "received") t.received = (cents(t.received) + cents(got)) / 100;
    if (row.vendor.state === "paid") t.paid = (cents(t.paid) + cents(got)) / 100;
    if (row.delivered && row.vendor.state !== "paid")
      t.outstanding = (cents(t.outstanding) + cents(exp)) / 100;
  }
  return out;
}
