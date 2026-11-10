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
 *
 * Lifecycle (owner request 2026-11-03), also checked against the 2026-10 schema + docs:
 *  - fulfillmentTrackingInfoUpdate(fulfillmentId: ID!, trackingInfoInput: FulfillmentTrackingInput!,
 *    notifyCustomer: Boolean) → FulfillmentTrackingInfoUpdatePayload {fulfillment, userErrors}; scope: one of
 *    write_merchant_managed_fulfillment_orders / write_assigned_… / write_third_party_fulfillment_orders.
 *  - fulfillmentEventCreate(fulfillmentEvent: FulfillmentEventInput! {fulfillmentId: ID!, status:
 *    FulfillmentEventStatus!, happenedAt, message, …}) → FulfillmentEventCreatePayload {fulfillmentEvent,
 *    userErrors}; scope: write_fulfillments. FulfillmentEventStatus: ATTEMPTED_DELIVERY CARRIER_PICKED_UP
 *    CONFIRMED DELAYED DELIVERED FAILURE IN_TRANSIT LABEL_PRINTED LABEL_PURCHASED OUT_FOR_DELIVERY READY_FOR_PICKUP.
 *  - fulfillment(id: ID!) {id status trackingInfo{…} fulfillmentLineItems(first){nodes{quantity lineItem{id}}
 *    pageInfo{hasNextPage}} events(first, reverse: true){nodes{id status} pageInfo{hasNextPage}}} for the
 *    read-back of those two (events newest first: carrier events can be many); scope read_orders (or a
 *    read_*_fulfillment_orders scope). A page with hasNextPage is an incomplete read-back (thrown, never "not
 *    there").
 *  - fulfillmentOrderMove(id: ID!, newLocationId: ID!, fulfillmentOrderLineItems: [FulfillmentOrderLineItemInput!])
 *    → FulfillmentOrderMovePayload {movedFulfillmentOrder{id status}, userErrors{field message}}; supported action
 *    MOVE; scope write_merchant_managed_fulfillment_orders (owner report 2026-11-10: Shopify split an order over two
 *    locations, the parcel left one warehouse). Moving to the location an item is already at is never asked: every
 *    attempt reads first and moves only what is still elsewhere.
 * Neither mutation has an idempotency key: the fulfillment is read back (tracking number / event status present?)
 * before every send and retry.
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
      pageInfo { hasNextPage }
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

export const FULFILLMENT_STATE_LINES_PAGE = 40;
export const FULFILLMENT_STATE_EVENTS_PAGE = 50;

/** Read-back of one Shopify fulfillment (tracking update / event / fulfilment created without tracking). */
export const WRITE_BACK_STATE_QUERY = `#graphql
query FulfillmentWriteBackState($id: ID!) {
  fulfillment(id: $id) {
    id
    status
    trackingInfo { number company url }
    fulfillmentLineItems(first: ${FULFILLMENT_STATE_LINES_PAGE}) {
      nodes { quantity lineItem { id } }
      pageInfo { hasNextPage }
    }
    events(first: ${FULFILLMENT_STATE_EVENTS_PAGE}, reverse: true) {
      nodes { id status }
      pageInfo { hasNextPage }
    }
  }
}`;

export const FULFILLMENT_TRACKING_UPDATE_MUTATION = `#graphql
mutation FulfillmentTrackingWriteBack($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
  fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) {
    fulfillment { id status }
    userErrors { field message }
  }
}`;

export const FULFILLMENT_EVENT_CREATE_MUTATION = `#graphql
mutation FulfillmentEventWriteBack($fulfillmentEvent: FulfillmentEventInput!) {
  fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
    fulfillmentEvent { id status }
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
        // Every partial move adds a fulfillment order: an incomplete page is never planned from (see readComplete).
        pageInfo: z.object({ hasNextPage: z.boolean() }).optional(),
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

/**
 * Moves fulfillment order lines to another location (Shopify: only merchant-managed locations, only open lines;
 * fails if the location does not stock the item). Used before fulfilling a shipment Shopify split over several
 * locations: the parcel left ONE warehouse, so its lines belong at that warehouse's location.
 */
export const FULFILLMENT_ORDER_MOVE_MUTATION = `#graphql
mutation FulfillmentOrderMoveWriteBack($id: ID!, $newLocationId: ID!, $items: [FulfillmentOrderLineItemInput!]) {
  fulfillmentOrderMove(id: $id, newLocationId: $newLocationId, fulfillmentOrderLineItems: $items) {
    movedFulfillmentOrder { id status }
    userErrors { field message }
  }
}`;

export const FulfillmentOrderMoveSchema = z.object({
  fulfillmentOrderMove: z
    .object({
      movedFulfillmentOrder: z.object({ id: z.string(), status: z.string() }).nullable(),
      userErrors: z.array(z.object({ field: z.array(z.string()).nullable(), message: z.string() })),
    })
    .nullable(),
});

const PageInfo = z.object({ hasNextPage: z.boolean() });
const UserErrors = z.array(z.object({ field: z.array(z.string()).nullable(), message: z.string() }));

export const WriteBackStateSchema = z.object({
  fulfillment: z
    .object({
      id: z.string(),
      status: z.string(),
      trackingInfo: z.array(TrackingInfo),
      fulfillmentLineItems: z.object({
        nodes: z.array(
          z.object({ quantity: z.number().int().nullable(), lineItem: z.object({ id: z.string() }) }),
        ),
        pageInfo: PageInfo,
      }),
      events: z.object({
        nodes: z.array(z.object({ id: z.string(), status: z.string() })),
        pageInfo: PageInfo,
      }),
    })
    .nullable(),
});
export type WriteBackState = z.infer<typeof WriteBackStateSchema>;

export const FulfillmentTrackingUpdateSchema = z.object({
  fulfillmentTrackingInfoUpdate: z
    .object({
      fulfillment: z.object({ id: z.string(), status: z.string() }).nullable(),
      userErrors: UserErrors,
    })
    .nullable(),
});

export const FulfillmentEventCreateSchema = z.object({
  fulfillmentEventCreate: z
    .object({
      fulfillmentEvent: z.object({ id: z.string(), status: z.string() }).nullable(),
      userErrors: UserErrors,
    })
    .nullable(),
});

export interface TrackingInput {
  number: string;
  company?: string;
  url?: string;
}

export interface FulfillmentInput {
  lineItemsByFulfillmentOrder: {
    fulfillmentOrderId: string;
    fulfillmentOrderLineItems: { id: string; quantity: number }[];
  }[];
  notifyCustomer: boolean;
  /** Absent when the fulfillment is created on acceptance, before the warehouse has a tracking number. */
  trackingInfo?: TrackingInput;
}

/**
 * Carrier names Shopify lists as supported tracking companies (FulfillmentTrackingInfo, 2026-10 docs: "Supported
 * tracking companies", incl. the Bulgaria entry "Speedy"). Our carrier (as the warehouse reports it) maps to the
 * exact Shopify spelling only when it is one of these; any other name is sent as we have it.
 */
export const SHOPIFY_TRACKING_COMPANIES = [
  "Speedy",
  "ACS Courier",
  "Inpost",
  "GLS",
  "DPD",
  "DPD Local",
  "DPD UK",
  "DHL Express",
  "DHL eCommerce",
  "Deutsche Post",
  "Packeta",
  "Venipak",
  "UPS",
  "FedEx",
  "TNT",
  "Cyprus Post",
  "Latvia Post",
  "Poste Italiane",
  "PostNL",
  "PostNord",
  "Swiss Post",
  "Royal Mail",
  "Evri",
  "Correos",
  "CTT",
  "Chronopost",
  "Colissimo",
  "Mondial Relay",
  "BPost",
  "An Post",
];
const COMPANY_BY_KEY = new Map(
  SHOPIFY_TRACKING_COMPANIES.map((c) => [c.toLowerCase().replace(/\s+/g, " "), c]),
);

/**
 * Warehouse courier names carry a country and a variant ("Greece ACS", "Hungary GLS New"): a known carrier word in
 * the name maps to Shopify's spelling (owner report 2026-11-06: an ACS Greece number shown as "DHL Express", because
 * no company was sent and Shopify guessed from the number's shape).
 */
const CARRIER_WORDS: [RegExp, string][] = [
  [/\bacs\b/, "ACS Courier"],
  [/\bspeedy\b/, "Speedy"],
  [/\bgls\b/, "GLS"],
  [/\bdpd\b/, "DPD"],
  [/\b(packeta|z[aá]silkovna)\b/, "Packeta"],
  [/\binpost\b/, "Inpost"],
  [/\bcyprus post\b/, "Cyprus Post"],
  [/\bdhl\b/, "DHL Express"],
];

/** Normalised key of a courier name (trimmed, lower case, single spaces). */
export const carrierKey = (carrier: string) => carrier.trim().toLowerCase().replace(/\s+/g, " ");

/** The documented Shopify tracking company exactly as Shopify spells it, or null when `name` is not one. */
export function shopifyCompanyNamed(name: string | null | undefined): string | null {
  return name ? (COMPANY_BY_KEY.get(carrierKey(name)) ?? null) : null;
}

/**
 * The Shopify tracking company our carrier name is or names (exact, or a known carrier word in it); null when it is
 * none of them — then Shopify would guess the carrier from the number, so the write-back waits for a person.
 */
export function knownShopifyCompany(carrier: string | null | undefined): string | null {
  const c = carrier?.trim();
  if (!c) return null;
  const key = carrierKey(c);
  const exact = COMPANY_BY_KEY.get(key);
  if (exact) return exact;
  for (const [re, name] of CARRIER_WORDS) if (re.test(key)) return name;
  return null;
}

/**
 * The Shopify-supported spelling of our carrier name when it is (or names) a documented one; else the name as we have
 * it, so Shopify never has to guess the carrier from the number.
 */
export function shopifyTrackingCompany(carrier: string | null | undefined): string | null {
  const c = carrier?.trim();
  if (!c) return null;
  const key = c.toLowerCase().replace(/\s+/g, " ");
  const exact = COMPANY_BY_KEY.get(key);
  if (exact) return exact;
  for (const [re, name] of CARRIER_WORDS) if (re.test(key)) return name;
  return c;
}

/** FulfillmentTrackingInput for one tracking number (company mapped, empty fields left out). */
export function trackingInput(t: {
  number: string;
  company: string | null;
  url: string | null;
}): TrackingInput {
  const company = shopifyTrackingCompany(t.company);
  return { number: t.number, ...(company ? { company } : {}), ...(t.url ? { url: t.url } : {}) };
}

/**
 * Our shipment status → the FulfillmentEventStatus reported to Shopify (2026-10 enum, see the header). Returns map
 * to FAILURE — the documented closest ("The fulfillment request failed"). A courier exception is often temporary
 * (delay, failed attempt, address problem) and maps to DELAYED, which is not final: DELIVERED may still follow.
 * ACCEPTED / PROCESSING report nothing (the fulfillment itself says it).
 */
export const EVENT_FOR_STATUS: Readonly<Record<string, ShopifyEventStatus>> = {
  SHIPPED: "IN_TRANSIT",
  DELIVERED: "DELIVERED",
  COD_PAID: "DELIVERED",
  RETURNING: "FAILURE",
  RETURN_RECEIVED: "FAILURE",
  EXCEPTION: "DELAYED",
};
export type ShopifyEventStatus = "IN_TRANSIT" | "DELAYED" | "DELIVERED" | "FAILURE";

/**
 * Order of the events we report: never an earlier one after a later one (no "in transit" after "delivered").
 * DELIVERED and FAILURE are both final: once one of them is reported nothing else follows.
 */
export const EVENT_RANK: Readonly<Record<ShopifyEventStatus, number>> = {
  IN_TRANSIT: 1,
  DELAYED: 1.5,
  DELIVERED: 2,
  FAILURE: 2,
};

/** Final FulfillmentEventStatus values: once Shopify shows one (ours or the carrier's), nothing else is reported. */
export const FINAL_EVENTS: ReadonlySet<string> = new Set<ShopifyEventStatus>(["DELIVERED", "FAILURE"]);

/**
 * FulfillmentStatus in 2026-10 (schema tool): CANCELLED, ERROR, FAILURE, SUCCESS. CANCELLED does not count;
 * ERROR / FAILURE are a failed fulfillment (an operator decides, see failedFulfillment). Anything else —
 * SUCCESS, or a value Shopify adds later — counts as done: an unknown status never leads to a second one.
 */
const NOT_DONE = new Set(["CANCELLED", "ERROR", "FAILURE"]);
const FAILED_STATUSES = new Set(["ERROR", "FAILURE"]);
const hasTracking = (f: { trackingInfo: { number: string | null }[] }, n: string) =>
  f.trackingInfo.some((t) => t.number === n);

/** A Shopify fulfillment of ours already exists for this tracking number (cancelled / failed ones do not count). */
export function existingFulfillment(read: WriteBackRead, trackingNumber: string) {
  return (
    read.order?.fulfillments.find((f) => !NOT_DONE.has(f.status) && hasTracking(f, trackingNumber)) ?? null
  );
}

/** A Shopify fulfillment with our tracking number that ended in ERROR / FAILURE. */
export function failedFulfillment(read: WriteBackRead, trackingNumber: string) {
  return (
    read.order?.fulfillments.find((f) => FAILED_STATUSES.has(f.status) && hasTracking(f, trackingNumber)) ??
    null
  );
}

/**
 * GraphQL error codes (errors[].extensions.code) that mean the document was rejected before execution, so
 * nothing was created: access, parse/validation, cost limits. Throttling is handled by the client. Any other
 * code (INTERNAL_SERVER_ERROR, timeouts) or no code at all means the outcome is unknown.
 */
export const DEFINITE_GRAPHQL_CODES: ReadonlySet<string> = new Set([
  "ACCESS_DENIED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "GRAPHQL_PARSE_FAILED",
  "GRAPHQL_VALIDATION_FAILED",
  "BAD_USER_INPUT",
  "MAX_COST_EXCEEDED",
  "THROTTLED",
  "undefinedField",
  "undefinedType",
  "argumentNotAccepted",
  "missingRequiredArguments",
  "missingRequiredInputObjectAttribute",
  "argumentLiteralsIncompatible",
  "variableMismatch",
  "variableNotUsed",
  "variableNotDefined",
  "parseError",
]);

/** True only when every reported code says "rejected before execution" (and there is at least one). */
export const isDefiniteGraphqlRejection = (codes: readonly string[]) =>
  codes.length > 0 && codes.every((c) => DEFINITE_GRAPHQL_CODES.has(c));

export type PlanResult =
  | { ok: true; input: FulfillmentInput; lines: { lineItemId: string; quantity: number }[] }
  | { ok: false; reason: "order_not_found" | "nothing_to_fulfil" | "multiple_locations" | "lines_unmatched" };

type FulfillmentOrderNode = NonNullable<WriteBackRead["order"]>["fulfillmentOrders"]["nodes"][number];

/** Fulfillment orders at `location` first (stable otherwise): quantities are taken where the parcel left from. */
const targetFirst = (fos: FulfillmentOrderNode[], location: string | null) =>
  location
    ? [
        ...fos.filter((fo) => fo.assignedLocation.location?.id === location),
        ...fos.filter((fo) => fo.assignedLocation.location?.id !== location),
      ]
    : fos;

/** The read holds every fulfillment order of the order (one page): otherwise nothing may be planned from it. */
export const readComplete = (read: WriteBackRead) => !read.order?.fulfillmentOrders.pageInfo?.hasNextPage;

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
  tracking: { number: string; company: string | null; url: string | null } | null,
  notifyCustomer: boolean,
  /** The location of the warehouse the parcel left: its fulfillment orders are taken first. */
  preferLocation: string | null = null,
): PlanResult {
  if (!read.order) return { ok: false, reason: "order_not_found" };
  const need = new Map<string, number>();
  for (const l of lines) need.set(l.shopifyLineGid, (need.get(l.shopifyLineGid) ?? 0) + l.quantity);
  if (need.size === 0) return { ok: false, reason: "lines_unmatched" };
  const byFo = new Map<string, { location: string | null; items: { id: string; quantity: number }[] }>();
  const planned = new Map<string, number>();
  for (const fo of targetFirst(read.order.fulfillmentOrders.nodes.filter(fulfillable), preferLocation)) {
    for (const li of fo.lineItems.nodes) {
      const want = need.get(li.lineItem.id) ?? 0;
      const take = Math.min(want, li.remainingQuantity);
      if (take <= 0) continue;
      need.set(li.lineItem.id, want - take);
      const entry = byFo.get(fo.id) ?? { location: fo.assignedLocation.location?.id ?? null, items: [] };
      entry.items.push({ id: li.id, quantity: take });
      planned.set(li.lineItem.id, (planned.get(li.lineItem.id) ?? 0) + take);
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
      ...(tracking ? { trackingInfo: trackingInput(tracking) } : {}),
    },
    lines: [...planned].map(([lineItemId, quantity]) => ({ lineItemId, quantity })),
  };
}

export interface LocationMove {
  fulfillmentOrderId: string;
  items: { id: string; quantity: number }[];
}

/**
 * The moves that put a shipment's open lines at `targetLocation` (pure): per fulfillment order assigned elsewhere
 * that Shopify lets us move, the shipment's lines on it (never more than remains). Same matching as
 * planFulfillment, so after the moves one fulfillmentCreate covers the shipment.
 */
export function planLocationMoves(
  read: WriteBackRead,
  lines: { shopifyLineGid: string; quantity: number }[],
  targetLocation: string,
): { ok: true; moves: LocationMove[] } | { ok: false; reason: "not_movable" } {
  const need = new Map<string, number>();
  for (const l of lines) need.set(l.shopifyLineGid, (need.get(l.shopifyLineGid) ?? 0) + l.quantity);
  const moves: LocationMove[] = [];
  // Target first: what already sits at the warehouse's location is taken there and never moved.
  for (const fo of targetFirst(
    read.order?.fulfillmentOrders.nodes.filter(fulfillable) ?? [],
    targetLocation,
  )) {
    const items: { id: string; quantity: number }[] = [];
    for (const li of fo.lineItems.nodes) {
      const want = need.get(li.lineItem.id) ?? 0;
      const take = Math.min(want, li.remainingQuantity);
      if (take <= 0) continue;
      need.set(li.lineItem.id, want - take);
      items.push({ id: li.id, quantity: take });
    }
    if (!items.length || fo.assignedLocation.location?.id === targetLocation) continue;
    if (!fo.supportedActions.some((a) => a.action === "MOVE")) return { ok: false, reason: "not_movable" };
    moves.push({ fulfillmentOrderId: fo.id, items });
  }
  return { ok: true, moves };
}

/**
 * Fulfillments of the order that did not exist before our first attempt and are not cancelled: candidates for the
 * one our fulfillmentCreate (without tracking) may have created. Confirmed by their line items (sameLines).
 */
export function newFulfillments(read: WriteBackRead, knownIds: readonly string[]) {
  const known = new Set(knownIds);
  return (read.order?.fulfillments ?? []).filter((f) => !known.has(f.id) && f.status !== "CANCELLED");
}

/** The Shopify fulfillment holds exactly our line items and quantities. */
export function sameLines(state: WriteBackState, lines: readonly { lineItemId: string; quantity: number }[]) {
  // Only part of the fulfillment's lines were read: we cannot tell, and "not ours" could lead to a second create.
  if (state.fulfillment?.fulfillmentLineItems.pageInfo.hasNextPage)
    throw new Error("Shopify fulfillment has more line items than one read-back page");
  const sum = (xs: readonly { id: string; q: number }[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x.id, (m.get(x.id) ?? 0) + x.q);
    return m;
  };
  const a = sum(
    state.fulfillment?.fulfillmentLineItems.nodes.map((n) => ({ id: n.lineItem.id, q: n.quantity ?? 0 })) ??
      [],
  );
  const b = sum(lines.map((l) => ({ id: l.lineItemId, q: l.quantity })));
  return a.size > 0 && a.size === b.size && [...b].every(([id, q]) => a.get(id) === q);
}
