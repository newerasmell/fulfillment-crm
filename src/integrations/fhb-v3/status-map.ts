import type { CrmOrderStatus } from "@/generated/prisma/client";

/**
 * FHB order status → CRM fulfillment status (INTEGRATION_NOTES §2.4). The raw status is always stored next to
 * the mapped one; an unknown value maps to UNKNOWN and raises an alert — it is never thrown.
 *
 * Two deliberate deviations from the notes' table, because CrmOrderStatus has neither RETURNED nor REJECTED:
 *  - `returned` (or `returned_at` set) → RETURN_RECEIVED: FHB documents returned_at as the date the shipment came
 *    back from the carrier (RMA = back at the warehouse), which is what RETURN_RECEIVED means in SPEC §6.5.
 *  - `rejected` → BLOCKED (vendor-side problem, needs an operator) + an alert.
 */

export interface FhbStatusMapping {
  status: CrmOrderStatus;
  /** The raw value as FHB sent it (trimmed); null when FHB sent none. */
  raw: string | null;
  known: boolean;
  /** PUT/DELETE /order are documented as allowed only in `pending`. Anything else is treated as locked. */
  editable: boolean;
  /** Why an operator must look: an unmapped value, or a rejected order. */
  alert: "unknown_status" | "rejected" | null;
}

const TABLE: Readonly<Record<string, CrmOrderStatus>> = Object.freeze({
  pending: "ACCEPTED",
  // Observed in responses but undocumented: accepted, and locked until proven otherwise.
  new: "ACCEPTED",
  imported: "ACCEPTED",
  b2b_new: "ACCEPTED",
  confirmed: "PROCESSING",
  packed: "PROCESSING",
  sent: "SHIPPED",
  delivered: "DELIVERED",
  returned: "RETURN_RECEIVED",
  rejected: "BLOCKED",
});

export function mapFhbOrderStatus(
  rawStatus: string | null | undefined,
  opts: { returnedAt?: string | null } = {},
): FhbStatusMapping {
  const raw = rawStatus?.trim() || null;
  const key = raw?.toLowerCase() ?? "";
  const known = Object.hasOwn(TABLE, key);
  let status: CrmOrderStatus = known ? TABLE[key]! : "UNKNOWN";
  // returned_at describes the return record itself, independently of `status`.
  // (An unknown raw status still raises its alert below.)
  if (opts.returnedAt) status = "RETURN_RECEIVED";
  return {
    status,
    raw,
    known,
    editable: key === "pending",
    alert: !known ? "unknown_status" : key === "rejected" ? "rejected" : null,
  };
}

/** True when the CRM may offer Edit / Cancel at the warehouse for this raw status. */
export const isFhbOrderEditable = (rawStatus: string | null | undefined) =>
  rawStatus?.trim().toLowerCase() === "pending";
