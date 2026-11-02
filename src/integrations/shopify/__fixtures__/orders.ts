import type { ShopifyOrder } from "../orders";

/**
 * SYNTHETIC orders in the 2026-10 GraphQL shape (no real customer, store or product data — the repo is
 * public). Used by the e2e seed; replace with scrubbed recordings once a real store is connected (GATE P1-G1).
 */
const money = (amount: string, currencyCode = "EUR") => ({ shopMoney: { amount, currencyCode } });
const base = (n: number, over: Partial<ShopifyOrder>): ShopifyOrder => ({
  id: `gid://shopify/Order/${900000 + n}`,
  name: `#${1000 + n}`,
  createdAt: new Date().toISOString(),
  processedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  cancelledAt: null,
  email: `buyer${n}@example.com`,
  phone: null,
  note: null,
  tags: [],
  test: false,
  currencyCode: "EUR",
  displayFinancialStatus: "PENDING",
  displayFulfillmentStatus: "UNFULFILLED",
  paymentGatewayNames: ["Cash on Delivery (COD)"],
  subtotalPriceSet: money("40.00"),
  totalPriceSet: money("45.00"),
  totalOutstandingSet: money("45.00"),
  customer: null,
  shippingAddress: {
    name: `Test Buyer ${n}`,
    address1: `${n} Example Street`,
    city: "Sofia",
    zip: "1000",
    country: "Bulgaria",
    countryCodeV2: "BG",
    phone: "+359000000000",
  },
  billingAddress: null,
  risk: { recommendation: "ACCEPT", assessments: [] },
  lineItems: {
    nodes: [
      {
        id: `gid://shopify/LineItem/${n}1`,
        name: "Sample Perfume EDP 50ml",
        sku: "DM-SAMPLE-EDP-50",
        quantity: 2,
        currentQuantity: 2,
        variant: { id: "gid://shopify/ProductVariant/501" },
        product: { id: "gid://shopify/Product/50" },
        discountedUnitPriceAfterAllDiscountsSet: money("20.00"),
      },
    ],
  },
  ...over,
});

export const SYNTHETIC_ORDERS: ShopifyOrder[] = [
  base(1, {}),
  base(2, {
    paymentGatewayNames: ["shopify_payments"],
    totalOutstandingSet: money("0.00"),
    shippingAddress: {
      name: "Test Buyer 2",
      address1: "2 Exemplu Street",
      city: "Bucharest",
      zip: "010000",
      country: "Romania",
      countryCodeV2: "RO",
    },
  }),
  base(3, { test: true, note: "Synthetic test order" }),
];
