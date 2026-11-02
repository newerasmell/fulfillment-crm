/**
 * Database guards of the override track (P4-09, prisma/migrations/*_order_override): triggers that refuse a second
 * active shipment of one order and a second open reroute of one order. Their errors are recognised here so callers
 * can answer "already submitted" instead of failing with a raw database error.
 */

const messageOf = (err: unknown): string => {
  if (!err || typeof err !== "object") return String(err ?? "");
  const e = err as { message?: unknown; cause?: unknown; meta?: unknown };
  return [e.message, e.cause && messageOf(e.cause), e.meta && JSON.stringify(e.meta)]
    .filter(Boolean)
    .join(" ");
};

/** The fulfillment_one_active trigger refused a write (the order already has an active shipment). */
export const isTwoActiveShipments = (err: unknown) => messageOf(err).includes("crm_two_active_shipments");

/** The order_reroute_one_open trigger refused a write (the order already has an open reroute). */
export const isRerouteOpen = (err: unknown) => messageOf(err).includes("crm_reroute_open");

/** Shipment states in which nothing is (or may be) live at a warehouse — the same set the pipeline uses. */
export const INACTIVE_SHIPMENT = ["SUBMIT_FAILED", "CANCELLED"] as const;
