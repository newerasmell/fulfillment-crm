/** Where a delete the warehouse confirmed is recorded on the shipment (effect, AWB check, by hand). */
export const CONFIRMED_DELETE_EVENT = {
  status: "CANCELLED" as const,
  OR: [
    { source: "crm", payload: { path: ["event"], equals: "deleted_at_vendor" } },
    { source: { in: ["eushipments:awb", "manual:deleted_at_warehouse"] } },
  ],
};
/** Task: recorded as deleted at euShipments, then shown live again by a stale status (owner report 2026-11-25). */
export const REVIVED_TASK = "eushipments_revived_after_delete";
/** Marker in the task body naming its shipment (one task per shipment, ever). */
export const revivedMarker = (fulfillmentId: string) => `fulfillment=${fulfillmentId}`;
