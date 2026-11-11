import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Fingerprint of the order data a pre-flight check validates (recipient, address, amounts, COD, tags,
 * lines). The validator engine stores it with the OrderCheck; the approve guard recomputes it from the
 * current row and refuses when they differ — a check made before a Shopify re-import or an edit never
 * authorises the changed order. Status, timestamps and Shopify's own status fields are not part of it.
 */

type Dec = Prisma.Decimal | { toString(): string } | null | undefined;

export interface FingerprintOrder {
  /** Delivery to a courier office chosen by a person (null = automatic: not part of the hash, so old checks stay). */
  deliveryOffice?: unknown;
  customerName: string | null;
  email: string | null;
  phone: string | null;
  shippingAddress: unknown;
  countryCode: string | null;
  currency: string;
  total: Dec;
  paymentMethod: string;
  codAmount: Dec;
  codLocalAmount: Dec;
  codLocalCurrency: string | null;
  tags: string[];
  lines: { sku: string | null; productId: string | null; quantity: number; unitPrice: Dec }[];
}

const dec = (d: Dec) => (d == null ? null : Number(d.toString()));

/** JSON with sorted object keys (Json columns do not keep key order). */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
    );
  return v ?? null;
}

export function orderFingerprint(o: FingerprintOrder): string {
  const lines = o.lines
    .map((l) => [l.sku ?? null, l.productId ?? null, l.quantity, dec(l.unitPrice)] as const)
    .map((l) => JSON.stringify(l))
    .sort();
  const data = stable({
    customerName: o.customerName,
    email: o.email,
    phone: o.phone,
    shippingAddress: o.shippingAddress,
    countryCode: o.countryCode,
    currency: o.currency,
    total: dec(o.total),
    paymentMethod: o.paymentMethod,
    codAmount: dec(o.codAmount),
    codLocalAmount: dec(o.codLocalAmount),
    codLocalCurrency: o.codLocalCurrency,
    tags: [...o.tags].sort(),
    lines,
    ...(o.deliveryOffice != null ? { deliveryOffice: o.deliveryOffice } : {}),
  });
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

export const FINGERPRINT_SELECT = {
  customerName: true,
  email: true,
  phone: true,
  shippingAddress: true,
  countryCode: true,
  currency: true,
  total: true,
  paymentMethod: true,
  codAmount: true,
  codLocalAmount: true,
  codLocalCurrency: true,
  tags: true,
  deliveryOffice: true,
  lines: { select: { sku: true, productId: true, quantity: true, unitPrice: true } },
} as const;

/** The current fingerprint of an order (null when it does not exist), read with the caller's client. */
export async function currentOrderFingerprint(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<string | null> {
  const o = await tx.order.findUnique({ where: { id: orderId }, select: FINGERPRINT_SELECT });
  return o ? orderFingerprint(o) : null;
}

/** The fingerprint stored with an OrderCheck (inside its `normalised` JSON), null for older checks. */
export function storedFingerprint(normalised: unknown): string | null {
  const v = (normalised as { orderFingerprint?: unknown } | null)?.orderFingerprint;
  return typeof v === "string" ? v : null;
}
