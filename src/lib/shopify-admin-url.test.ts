import { describe, expect, it } from "vitest";
import { shopifyAdminOrderUrl } from "./shopify-admin-url";

describe("Shopify admin order link", () => {
  it("builds the admin URL from the store domain and the order gid", () => {
    expect(shopifyAdminOrderUrl("demo-store.myshopify.com", "gid://shopify/Order/9500001")).toBe(
      "https://demo-store.myshopify.com/admin/orders/9500001",
    );
  });
  it("null without a Shopify order or a myshopify domain", () => {
    expect(shopifyAdminOrderUrl("demo-store.myshopify.com", null)).toBeNull();
    expect(shopifyAdminOrderUrl("demo-store.myshopify.com", "gid://shopify/Product/1")).toBeNull();
    expect(shopifyAdminOrderUrl("evil.example/x", "gid://shopify/Order/1")).toBeNull();
    expect(shopifyAdminOrderUrl(null, "gid://shopify/Order/1")).toBeNull();
  });
});
