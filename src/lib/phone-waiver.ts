/** Pure helpers of the per-order phone waiver (src/server/review/phone-waiver.ts). No I/O. */

/** "+358 40 661-3033" / "00358406613033" → "+358406613033"; anything else keeps its digits (and a leading +). */
export function compactPhone(raw: string | null | undefined): string {
  const t = (raw ?? "").trim().replace(/[\s\-./()]/g, "");
  return t.startsWith("00") ? `+${t.slice(2)}` : t;
}

/** The international form the warehouse gets: "+" and 8–15 digits (E.164), else null (not allowed). */
export function internationalPhone(raw: string | null | undefined): string | null {
  const c = compactPhone(raw);
  return /^\+[1-9]\d{7,14}$/.test(c) ? c : null;
}

export interface PhoneWaiverView {
  phoneKey: string;
  sentPhone: string;
  reason: string;
  createdById: string | null;
  createdAt: Date;
}

/** The phone to send instead of the rule's verdict, when the waiver is about this very phone. */
export function waivedPhone(
  waiver: Pick<PhoneWaiverView, "phoneKey" | "sentPhone"> | null | undefined,
  raw: string | null | undefined,
) {
  if (!waiver || !raw) return null;
  return compactPhone(raw) === waiver.phoneKey ? waiver.sentPhone : null;
}

/**
 * Phone check codes a waiver answers (shown with the "Позволи" button). euShipments only: FHB already takes any
 * number with its country code (E.164), so its own phone check is never waived.
 */
export const WAIVABLE_PHONE_CODES = ["order.phone_invalid", "eushipments.phone_invalid"] as const;

/** The phone a waiver is about and the euShipments payload sends: the shipping address's, else the order's. */
export function orderPhoneOf(order: { phone: string | null; shippingAddress: unknown }): string | null {
  const a = (order.shippingAddress ?? {}) as { phone?: string | null };
  return a.phone?.trim() ? a.phone : order.phone;
}
