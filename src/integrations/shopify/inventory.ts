import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Shopify inventory (P5-03, SPEC §4 "Inventory"), Admin GraphQL API 2026-10. Every field, argument and enum
 * below was checked against the 2026-10 Admin schema with the Shopify schema tool:
 *  - QueryRoot.locations(first, after, includeInactive, includeLegacy) → LocationConnection {nodes, pageInfo};
 *    Location {id name isActive fulfillmentService {handle} inventoryLevels(first, after)};
 *  - InventoryLevel {quantities(names: [String!]!) → [InventoryQuantity {name quantity}], item: InventoryItem};
 *    InventoryItem {id tracked variants(first) inventoryLevel(locationId: ID!)}; QueryRoot.nodes(ids: [ID!]!);
 *  - Mutation.inventorySetQuantities(input: InventorySetQuantitiesInput!) with {name, reason, referenceDocumentUri,
 *    quantities [InventoryQuantityInput {inventoryItemId, locationId, quantity, changeFromQuantity}]} →
 *    InventorySetQuantitiesPayload {inventoryAdjustmentGroup {id}, userErrors {code field message}}.
 *    Since 2026-04 the @idempotent(key:) directive is REQUIRED on this mutation (docs, 2026-10 reference), and
 *    changeFromQuantity is the compare-and-set value (null opts out — we never opt out).
 * Scopes: read_locations, read_inventory, write_inventory.
 */

/** Quantity names we read; we only ever SET "available". */
export const INVENTORY_NAMES = ["available", "on_hand"] as const;
export const LOCATIONS_PAGE = 50;
export const LOCATION_LEVELS_PAGE = 50;
export const READBACK_PAGE = 50;
/** Quantities per inventorySetQuantities call (no documented maximum; kept small on purpose). */
export const PUSH_BATCH = 100;
/** Accepted reason values per the "Manage inventory quantities and states" guide: correction is the general one. */
export const PUSH_REASON = "correction";

export const LOCATIONS_QUERY = /* GraphQL */ `
  query StoreLocations($first: Int!, $after: String) {
    locations(first: $first, after: $after, includeInactive: true, includeLegacy: true) {
      nodes {
        id
        name
        isActive
        fulfillmentService {
          handle
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const LocationsPage = z.object({
  locations: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        isActive: z.boolean(),
        fulfillmentService: z.object({ handle: z.string() }).nullable(),
      }),
    ),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
  }),
});

export const LOCATION_LEVELS_QUERY = /* GraphQL */ `
  query LocationInventory($id: ID!, $first: Int!, $after: String) {
    location(id: $id) {
      id
      inventoryLevels(first: $first, after: $after) {
        nodes {
          quantities(names: ["available", "on_hand"]) {
            name
            quantity
          }
          item {
            id
            tracked
            variants(first: 3) {
              nodes {
                id
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const Quantity = z.object({ name: z.string(), quantity: z.number().int() });

export const LocationLevelsPage = z.object({
  location: z
    .object({
      id: z.string(),
      inventoryLevels: z.object({
        nodes: z.array(
          z.object({
            quantities: z.array(Quantity),
            item: z.object({
              id: z.string(),
              tracked: z.boolean(),
              variants: z.object({ nodes: z.array(z.object({ id: z.string() })) }).nullable(),
            }),
          }),
        ),
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
      }),
    })
    .nullable(),
});
export type LocationLevelsPage = z.infer<typeof LocationLevelsPage>;

/** Current "available" of some inventory items at ONE location (read right before every push and after it). */
export const READBACK_QUERY = /* GraphQL */ `
  query InventoryReadBack($ids: [ID!]!, $locationId: ID!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        tracked
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["available"]) {
            name
            quantity
          }
        }
      }
    }
  }
`;

export const ReadBack = z.object({
  nodes: z.array(
    z
      .object({
        id: z.string().optional(),
        tracked: z.boolean().optional(),
        inventoryLevel: z.object({ quantities: z.array(Quantity) }).nullish(),
      })
      .nullable(),
  ),
});
export type ReadBack = z.infer<typeof ReadBack>;

export const PUSH_MUTATION = /* GraphQL */ `
  mutation InventoryPush($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup {
        id
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

export const PushPayload = z.object({
  inventorySetQuantities: z
    .object({
      inventoryAdjustmentGroup: z.object({ id: z.string() }).nullable(),
      userErrors: z.array(
        z.object({
          code: z.string().nullable(),
          field: z.array(z.string()).nullable(),
          message: z.string(),
        }),
      ),
    })
    .nullable(),
});
export type PushPayload = z.infer<typeof PushPayload>;

export interface PushQuantity {
  inventoryItemId: string;
  locationId: string;
  quantity: number;
  changeFromQuantity: number;
}

export interface PushInput {
  name: "available";
  reason: string;
  referenceDocumentUri: string;
  quantities: PushQuantity[];
}

/** Pure: available quantity out of a quantities list (null when Shopify did not return it). */
export function availableOf(quantities: { name: string; quantity: number }[] | undefined | null) {
  return quantities?.find((q) => q.name === "available")?.quantity ?? null;
}

/**
 * Deterministic idempotency key (UUID-shaped) for one batch of one push: the same batch is always retried with
 * the same key and the same stored variables, so Shopify applies it at most once. `generation` moves on only
 * after Shopify said the previous attempt with that key FAILED (IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED).
 */
export function pushIdempotencyKey(pushId: string, batch: number, generation = 0) {
  const h = createHash("sha256").update(`inventory-push:${pushId}:${batch}:${generation}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** userError codes after which the batch was certainly not applied and a retry with the same input is pointless. */
export const DEFINITE_PUSH_ERRORS = new Set([
  "INVALID_INVENTORY_ITEM",
  "INVALID_LOCATION",
  "INVALID_NAME",
  "INVALID_QUANTITY_NEGATIVE",
  "INVALID_QUANTITY_TOO_HIGH",
  "INVALID_QUANTITY_TOO_LOW",
  "INVALID_REASON",
  "INVALID_REFERENCE_DOCUMENT",
  "NON_MUTABLE_INVENTORY_ITEM",
  "NO_DUPLICATE_INVENTORY_ITEM_ID_GROUP_ID_PAIR",
  "IDEMPOTENCY_KEY_PARAMETER_MISMATCH",
  "COMPARE_QUANTITY_REQUIRED",
]);
