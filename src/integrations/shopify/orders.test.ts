import { describe, expect, it } from "vitest";
import { ShopifyOrderLineItem } from "./orders";

// The line's variant image (order page thumbnail, owner request 2026-11-13). Synthetic values.
describe("Shopify order line item", () => {
  const base = {
    id: "gid://shopify/LineItem/1",
    name: "Example",
    sku: "SKU-1",
    quantity: 1,
    currentQuantity: 1,
    discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: "10.00", currencyCode: "EUR" } },
  };
  it("keeps the image url, and accepts a line without an image", () => {
    expect(
      ShopifyOrderLineItem.parse({ ...base, image: { url: "https://cdn.shopify.com/x.png" } }).image?.url,
    ).toBe("https://cdn.shopify.com/x.png");
    expect(ShopifyOrderLineItem.parse({ ...base, image: null }).image).toBeNull();
    expect(ShopifyOrderLineItem.parse(base).image).toBeUndefined();
    expect(ShopifyOrderLineItem.parse({ ...base, image: { url: "not a url" } }).image).toBeNull();
  });
});
