import { describe, expect, it } from "vitest";
import {
  ACTIVATE_MUTATION,
  activationIdempotencyKey,
  availableOf,
  locationDisplayName,
  LOCATION_LEVELS_PAGE,
  LOCATION_LEVELS_QUERY,
  LOCATIONS_PAGE,
  LOCATIONS_QUERY,
  PUSH_MUTATION,
  READBACK_QUERY,
} from "./inventory";
import { estimateQueryCost } from "./query-cost";

describe("Shopify inventory documents", () => {
  it.each([
    ["StoreLocations", LOCATIONS_QUERY, { first: LOCATIONS_PAGE }],
    ["LocationInventory", LOCATION_LEVELS_QUERY, { first: LOCATION_LEVELS_PAGE }],
    ["InventoryReadBack", READBACK_QUERY, {}],
    ["InventoryPush", PUSH_MUTATION, {}],
    ["InventoryActivate", ACTIVATE_MUTATION, {}],
  ])("%s stays under the single-query cost cap", (_n, doc, vars) => {
    expect(estimateQueryCost(doc, vars)).toBeLessThan(1000);
  });

  it("the push carries the required @idempotent directive and never opts out of compare-and-set", () => {
    expect(PUSH_MUTATION).toMatch(/@idempotent\(key: \$idempotencyKey\)/);
    expect(PUSH_MUTATION).not.toMatch(/ignoreCompareQuantity/);
  });

  it("reads available", () => {
    expect(
      availableOf([
        { name: "on_hand", quantity: 3 },
        { name: "available", quantity: 2 },
      ]),
    ).toBe(2);
    expect(availableOf(undefined)).toBeNull();
  });

  it("activation: required @idempotent key, never sets quantities; key deterministic per (store, item, location)", () => {
    expect(ACTIVATE_MUTATION).toMatch(/@idempotent\(key: \$idempotencyKey\)/);
    expect(ACTIVATE_MUTATION).not.toMatch(/available|onHand/);
    const k = activationIdempotencyKey("s1", "gid://shopify/InventoryItem/1", "gid://shopify/Location/2");
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(activationIdempotencyKey("s1", "gid://shopify/InventoryItem/1", "gid://shopify/Location/2")).toBe(
      k,
    );
    expect(
      activationIdempotencyKey("s2", "gid://shopify/InventoryItem/1", "gid://shopify/Location/2"),
    ).not.toBe(k);
    expect(
      activationIdempotencyKey("s1", "gid://shopify/InventoryItem/1", "gid://shopify/Location/3"),
    ).not.toBe(k);
    expect(
      activationIdempotencyKey("s1", "gid://shopify/InventoryItem/1", "gid://shopify/Location/2", 1),
    ).not.toBe(k);
  });

  it("location names: the merchant's name wins; placeholders fall back to the service name, then the city", () => {
    expect(locationDisplayName({ name: "Склад София" })).toBe("Склад София");
    expect(locationDisplayName({ name: "#2", fulfillmentService: { serviceName: "Синтетичен склад" } })).toBe(
      "Синтетичен склад (#2)",
    );
    expect(locationDisplayName({ name: "3", address: { city: "Пловдив" } })).toBe("Пловдив (3)");
    expect(locationDisplayName({ name: "#2", fulfillmentService: null, address: null })).toBe("#2");
    expect(locationDisplayName({ name: " ", fulfillmentService: { serviceName: "X" } })).toBe("X");
  });
});
