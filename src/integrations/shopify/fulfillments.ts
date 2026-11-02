import { z } from "zod";

/**
 * Shopify fulfillment write-back (P4-07, SPEC §4), Admin GraphQL API 2026-10. Every field and argument below was
 * checked against the 2026-10 Admin schema (Shopify schema tool): Order.fulfillmentOrders / Order.fulfillments,
 * FulfillmentOrder {id status supportedActions{action} assignedLocation{location{id}} lineItems{id
 * remainingQuantity lineItem{id}}}, Fulfillment {id status trackingInfo{number company url}}, and
 * fulfillmentCreate(fulfillment: FulfillmentInput!) with FulfillmentInput {lineItemsByFulfillmentOrder
 * [{fulfillmentOrderId, fulfillmentOrderLineItems [{id, quantity}]}], notifyCustomer, trackingInfo {number,
 * company, url}} → FulfillmentCreatePayload {fulfillment{id status}, userErrors{field message}}.
 * Scope: write_merchant_managed_fulfillment_orders (plus read_merchant_managed_fulfillment_orders to read).
 * fulfillmentCreate has no idempotency key in 2026-10: we read the order's fulfillments back (by tracking
 * number) before every send and every retry.
 */

export const FULFILLMENT_FO_PAGE = 5;
export const FULFILLMENT_LINES_PAGE = 40;
export const FULFILLMENTS_PAGE = 50;

export const WRITE_BACK_READ_QUERY = `#graphql
query FulfillmentWriteBackRead($id: ID!) {
  order(id: $id) {
    id
    fulfillments(first: ${FULFILLMENTS_PAGE}) {
      id
      status
      trackingInfo { number company url }
    }
    fulfillmentOrders(first: ${FULFILLMENT_FO_PAGE}) {
      nodes {
        id
        status
        supportedActions { action }
        assignedLocation { location { id } }
        lineItems(first: ${FULFILLMENT_LINES_PAGE}) {
          nodes { id remainingQuantity lineItem { id } }
        }
      }
    }
  }
}`;

export const FULFILLMENT_CREATE_MUTATION = `#graphql
mutation FulfillmentWriteBack($fulfillment: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $fulfillment) {
    fulfillment { id status }
    userErrors { field message }
  }
}`;

const TrackingInfo = z.object({
  number: z.string().nullable(),
  company: z.string().nullable(),
  url: z.string().nullable(),
});

export const WriteBackReadSchema = z.object({
  order: z
    .object({
      id: z.string(),
      fulfillments: z.array(
        z.object({ id: z.string(), status: z.string(), trackingInfo: z.array(TrackingInfo) }),
      ),
      fulfillmentOrders: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            status: z.string(),
            supportedActions: z.array(z.object({ action: z.string() })),
            assignedLocation: z.object({ location: z.object({ id: z.string() }).nullable() }),
            lineItems: z.object({
              nodes: z.array(
                z.object({
                  id: z.string(),
                  remainingQuantity: z.number().int(),
                  lineItem: z.object({ id: z.string() }),
                }),
              ),
            }),
          }),
        ),
      }),
    })
    .nullable(),
});
export type WriteBackRead = z.infer<typeof WriteBackReadSchema>;

export const FulfillmentCreateSchema = z.object({
  fulfillmentCreate: z
    .object({
      fulfillment: z.object({ id: z.string(), status: z.string() }).nullable(),
      userErrors: z.array(z.object({ field: z.array(z.string()).nullable(), message: z.string() })),
    })
    .nullable(),
});

export interface FulfillmentInput {
  lineItemsByFulfillmentOrder: {
    fulfillmentOrderId: string;
    fulfillmentOrderLineItems: { id: string; quantity: number }[];
  }[];
  notifyCustomer: boolean;
  trackingInfo: { number: string; company?: string; url?: string };
}

/** A Shopify fulfillment of ours already exists for this tracking number (cancelled ones do not count). */
export function existingFulfillment(read: WriteBackRead, trackingNumber: string) {
  return (
    read.order?.fulfillments.find(
      (f) => f.status !== "CANCELLED" && f.trackingInfo.some((t) => t.number === trackingNumber),
    ) ?? null
  );
}

export type PlanResult =
  | { ok: true; input: FulfillmentInput }
  | { ok: false; reason: "order_not_found" | "nothing_to_fulfil" | "multiple_locations" | "lines_unmatched" };

/** Fulfillment orders Shopify lets us fulfil now. */
const fulfillable = (fo: NonNullable<WriteBackRead["order"]>["fulfillmentOrders"]["nodes"][number]) =>
  (fo.status === "OPEN" || fo.status === "IN_PROGRESS") &&
  fo.supportedActions.some((a) => a.action === "CREATE_FULFILLMENT");

/**
 * Builds the fulfillmentCreate input for one shipment (pure). `lines` are the shipment's Shopify line item
 * gids and quantities. Quantities are taken from the open fulfillment-order lines of those line items (never
 * more than remains). One fulfillmentCreate covers fulfillment orders at ONE location (Shopify rule); a
 * shipment spread over several locations is left to an operator.
 */
export function planFulfillment(
  read: WriteBackRead,
  lines: { shopifyLineGid: string; quantity: number }[],
  tracking: { number: string; company: string | null; url: string | null },
  notifyCustomer: boolean,
): PlanResult {
  if (!read.order) return { ok: false, reason: "order_not_found" };
  const need = new Map<string, number>();
  for (const l of lines) need.set(l.shopifyLineGid, (need.get(l.shopifyLineGid) ?? 0) + l.quantity);
  if (need.size === 0) return { ok: false, reason: "lines_unmatched" };
  const byFo = new Map<string, { location: string | null; items: { id: string; quantity: number }[] }>();
  for (const fo of read.order.fulfillmentOrders.nodes.filter(fulfillable)) {
    for (const li of fo.lineItems.nodes) {
      const want = need.get(li.lineItem.id) ?? 0;
      const take = Math.min(want, li.remainingQuantity);
      if (take <= 0) continue;
      need.set(li.lineItem.id, want - take);
      const entry = byFo.get(fo.id) ?? { location: fo.assignedLocation.location?.id ?? null, items: [] };
      entry.items.push({ id: li.id, quantity: take });
      byFo.set(fo.id, entry);
    }
  }
  if (byFo.size === 0) return { ok: false, reason: "nothing_to_fulfil" };
  if (new Set([...byFo.values()].map((v) => v.location)).size > 1)
    return { ok: false, reason: "multiple_locations" };
  return {
    ok: true,
    input: {
      lineItemsByFulfillmentOrder: [...byFo.entries()].map(([fulfillmentOrderId, v]) => ({
        fulfillmentOrderId,
        fulfillmentOrderLineItems: v.items,
      })),
      notifyCustomer,
      trackingInfo: {
        number: tracking.number,
        ...(tracking.company ? { company: tracking.company } : {}),
        ...(tracking.url ? { url: tracking.url } : {}),
      },
    },
  };
}
