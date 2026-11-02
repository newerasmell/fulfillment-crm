import type { CrmOrderStatus } from "@/generated/prisma/client";

/**
 * Joy shipment status → CRM shipment status. Documented values of GET /shipment and GET /packages:
 * `pending, confirmed, sent, delivered, returned, rejected, undefined`. The raw value is always stored next to
 * the mapped one; anything unmapped (incl. the documented `undefined`) becomes UNKNOWN + an alert, never a throw.
 *
 *  - `returned` → RETURN_RECEIVED, the same reading as FHB v3 (§2.4): the parcel came back from the carrier.
 *  - `rejected` → CANCELLED: DELETE /shipments "soft-rejects" a shipment, i.e. the label is void. A rejection we
 *    did not ask for raises an alert (the caller knows whether a reject request was sent).
 *  - Reject (DELETE /shipments) is documented as possible only in the `printed` state, which is not one of the
 *    listed statuses; the CRM offers it while the raw status is `pending` or not read yet and treats a 409 as
 *    "too late".
 */

export interface JoyStatusMapping {
  status: CrmOrderStatus;
  raw: string | null;
  known: boolean;
  alert: "unknown_status" | null;
}

const TABLE: Readonly<Record<string, CrmOrderStatus>> = Object.freeze({
  pending: "ACCEPTED",
  confirmed: "PROCESSING",
  sent: "SHIPPED",
  delivered: "DELIVERED",
  returned: "RETURN_RECEIVED",
  rejected: "CANCELLED",
});

export function mapJoyStatus(rawStatus: string | null | undefined): JoyStatusMapping {
  const raw = rawStatus?.trim() || null;
  const key = raw?.toLowerCase() ?? "";
  const known = Object.hasOwn(TABLE, key);
  return { status: known ? TABLE[key]! : "UNKNOWN", raw, known, alert: known ? null : "unknown_status" };
}

/** Statuses after which nothing changes any more (polling stops). */
export const JOY_FINAL = new Set(["delivered", "returned", "rejected"]);

/** The CRM may offer "reject the label" (DELETE /shipments) for this raw status. */
export const isJoyRejectable = (rawStatus: string | null | undefined) => {
  const k = rawStatus?.trim().toLowerCase() ?? "";
  return k === "" || k === "pending";
};
