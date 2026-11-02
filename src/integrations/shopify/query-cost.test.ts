import { describe, expect, it } from "vitest";
import { ORDER_BY_ID_QUERY, ORDER_LINES_QUERY, ORDERS_PAGE_QUERY, ORDERS_PAGE_SIZE } from "./orders";
import { PRODUCT_VARIANTS_QUERY, VARIANTS_PAGE_QUERY, VARIANTS_PAGE_SIZE } from "./products";
import { estimateQueryCost } from "./query-cost";
import { SHOP_QUERY } from "./queries";
import { WEBHOOK_CREATE_MUTATION, WEBHOOK_SUBSCRIPTIONS_QUERY } from "./webhooks";

describe("Shopify query cost (single-query cap 1000)", () => {
  it("the estimator matches the documented example", () => {
    // Shopify docs: products(first: 1) { edges { node { title } } } → requestedQueryCost 3
    expect(
      estimateQueryCost("query { products(first: 1) { edges { node { title } } } }"),
    ).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ["OrdersPage", ORDERS_PAGE_QUERY, { first: ORDERS_PAGE_SIZE }],
    ["OrderById", ORDER_BY_ID_QUERY, {}],
    ["OrderLines", ORDER_LINES_QUERY, {}],
    ["VariantsPage", VARIANTS_PAGE_QUERY, { first: VARIANTS_PAGE_SIZE }],
    ["ProductVariants", PRODUCT_VARIANTS_QUERY, {}],
    ["Shop", SHOP_QUERY, {}],
    ["WebhookSubscriptions", WEBHOOK_SUBSCRIPTIONS_QUERY, {}],
    ["WebhookCreate", WEBHOOK_CREATE_MUTATION, {}],
  ])("%s stays under the cap", (_name, doc, vars) => {
    const cost = estimateQueryCost(doc, vars);
    expect(cost).toBeLessThan(1000);
  });
});
