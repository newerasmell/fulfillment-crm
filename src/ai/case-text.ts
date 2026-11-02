/**
 * The "case" of an order or a decided review as embedding text (P8-01): country, address SHAPE, phone shape,
 * payment, the validator finding codes and (for reviews) which fields the operator corrected. Shapes, not values:
 * no name, no street, no full phone number leaves the CRM for the embedding provider, and two orders with the same
 * kind of problem land close together whatever the customer's details. Pure.
 */

export interface CaseInput {
  countryCode: string | null;
  paymentMethod: "COD" | "PREPAID" | string;
  phone: string | null;
  address: {
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    zip?: string | null;
  } | null;
  findingCodes: string[];
  /** Review only: fields the operator corrected (diff), e.g. "phone", "shippingAddress.zip". */
  correctedFields?: string[];
}

/** Digits → 9, letters → A, everything else kept (spaces collapsed). */
export const shape = (v: string) =>
  v.trim().replace(/\s+/g, " ").replace(/\d/g, "9").replace(/\p{L}/gu, "A").slice(0, 24);

const norm = (v: string | null | undefined) => (v ?? "").trim();

export function phoneShape(phone: string | null) {
  const p = norm(phone).replace(/[\s().-]/g, "");
  if (!p) return ["phone:none"];
  const plus = p.startsWith("+") ? "+" : p.startsWith("00") ? "00" : "";
  const digits = p.replace(/\D/g, "");
  const prefix = plus ? `${plus}${digits.slice(0, plus === "00" ? 4 : 2)}` : digits.slice(0, 2);
  return [`phone_prefix:${prefix}`, `phone_len:${digits.length}`, `phone_intl:${plus ? "yes" : "no"}`];
}

export function caseText(c: CaseInput): string {
  const country = norm(c.countryCode).toUpperCase() || "none";
  const a = c.address ?? {};
  const street = norm(a.address1);
  const tokens = [
    // Country and the problems weigh most: those are what make two cases "the same kind".
    `country:${country}*3`,
    `payment:${c.paymentMethod}`,
    ...phoneShape(c.phone).map((t) => `${country}|${t}*2`),
    `zip_shape:${a.zip ? shape(a.zip) : "none"}`,
    `${country}|zip_shape:${a.zip ? shape(a.zip) : "none"}*2`,
    `city:${norm(a.city).toLowerCase().replace(/\s+/g, "_") || "none"}`,
    `street_number:${/\d/.test(street) ? "yes" : "no"}`,
    `street_len:${Math.min(Math.floor(street.length / 10), 6)}`,
    `address2:${norm(a.address2) ? "yes" : "no"}`,
    ...(c.findingCodes.length ? c.findingCodes : ["none"]).map((f) => `finding:${f}*3`),
    ...(c.correctedFields ?? []).map((f) => `corrected:${f}*2`),
  ];
  return tokens.join(" ");
}
