import { describe, expect, it } from "vitest";
import {
  availableOf,
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
});
