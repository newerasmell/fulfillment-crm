import { z } from "zod";

/** Order queries and shapes (API 2026-10; fields checked against the schema on 2026-11-02). */

const ADDRESS = `name firstName lastName company address1 address2 city province provinceCode zip country countryCodeV2 phone`;
// presentmentMoney = what the customer sees and owes (destination currency); kept for local-currency COD.
const MONEY = `shopMoney { amount currencyCode } presentmentMoney { amount currencyCode }`;

/**
 * Page sizes are bounded by Shopify's 1000-point single-query cost cap (connections cost first × node cost).
 * Lines beyond the first page are fetched with ORDER_LINES_QUERY. The cost test keeps these honest.
 */
export const ORDERS_PAGE_SIZE = 4;
export const ORDER_LINES_FIRST = 20;
export const ORDER_LINES_PAGE_SIZE = 100;

const LINE_FIELDS = `
        id
        name
        sku
        quantity
        currentQuantity
        variant { id }
        product { id }
        discountedUnitPriceAfterAllDiscountsSet { ${MONEY} }`;

export const ORDER_FIELDS = /* GraphQL */ `
  fragment OrderFields on Order {
    id
    name
    createdAt
    processedAt
    updatedAt
    cancelledAt
    email
    phone
    note
    tags
    test
    currencyCode
    presentmentCurrencyCode
    displayFinancialStatus
    displayFulfillmentStatus
    paymentGatewayNames
    subtotalPriceSet { ${MONEY} }
    totalPriceSet { ${MONEY} }
    totalOutstandingSet { ${MONEY} }
    customer { id firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
    shippingAddress { ${ADDRESS} }
    billingAddress { ${ADDRESS} }
    risk { recommendation assessments { riskLevel } }
    lineItems(first: ${ORDER_LINES_FIRST}) {
      nodes {${LINE_FIELDS}
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const ORDERS_PAGE_QUERY = /* GraphQL */ `
  ${ORDER_FIELDS}
  query OrdersPage($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      nodes {
        ...OrderFields
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const ORDER_BY_ID_QUERY = /* GraphQL */ `
  ${ORDER_FIELDS}
  query OrderById($id: ID!) {
    order(id: $id) {
      ...OrderFields
    }
  }
`;

export const ORDER_LINES_QUERY = /* GraphQL */ `
  query OrderLines($id: ID!, $after: String) {
    order(id: $id) {
      lineItems(first: ${ORDER_LINES_PAGE_SIZE}, after: $after) {
        nodes {${LINE_FIELDS}
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const MoneyV2 = z.object({ amount: z.string(), currencyCode: z.string() });
const Money = z.object({ shopMoney: MoneyV2, presentmentMoney: MoneyV2.nullish() });
const PageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() });
const Address = z
  .object({
    name: z.string().nullish(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    company: z.string().nullish(),
    address1: z.string().nullish(),
    address2: z.string().nullish(),
    city: z.string().nullish(),
    province: z.string().nullish(),
    provinceCode: z.string().nullish(),
    zip: z.string().nullish(),
    country: z.string().nullish(),
    countryCodeV2: z.string().nullish(),
    phone: z.string().nullish(),
  })
  .nullish();

const LineItem = z.object({
  id: z.string(),
  name: z.string(),
  sku: z.string().nullish(),
  quantity: z.number().int(),
  currentQuantity: z.number().int(),
  variant: z.object({ id: z.string() }).nullish(),
  product: z.object({ id: z.string() }).nullish(),
  discountedUnitPriceAfterAllDiscountsSet: Money,
});
/** pageInfo is optional so fully-fetched orders (lines merged) and fixtures validate too. */
const LineItems = z.object({ nodes: z.array(LineItem), pageInfo: PageInfo.nullish() });

export const ShopifyOrder = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  processedAt: z.string(),
  updatedAt: z.string(),
  cancelledAt: z.string().nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  note: z.string().nullish(),
  tags: z.array(z.string()),
  test: z.boolean(),
  currencyCode: z.string(),
  presentmentCurrencyCode: z.string().nullish(),
  displayFinancialStatus: z.string().nullish(),
  displayFulfillmentStatus: z.string(),
  paymentGatewayNames: z.array(z.string()),
  subtotalPriceSet: Money.nullish(),
  totalPriceSet: Money,
  totalOutstandingSet: Money,
  customer: z
    .object({
      id: z.string(),
      firstName: z.string().nullish(),
      lastName: z.string().nullish(),
      defaultEmailAddress: z.object({ emailAddress: z.string() }).nullish(),
      defaultPhoneNumber: z.object({ phoneNumber: z.string() }).nullish(),
    })
    .nullish(),
  shippingAddress: Address,
  billingAddress: Address,
  risk: z
    .object({ recommendation: z.string(), assessments: z.array(z.object({ riskLevel: z.string() })) })
    .nullish(),
  lineItems: LineItems,
});
export type ShopifyOrder = z.infer<typeof ShopifyOrder>;

export const OrdersPage = z.object({
  orders: z.object({
    nodes: z.array(ShopifyOrder),
    pageInfo: PageInfo,
  }),
});

export const OrderById = z.object({ order: ShopifyOrder.nullable() });

export const OrderLines = z.object({
  order: z.object({ lineItems: z.object({ nodes: z.array(LineItem), pageInfo: PageInfo }) }).nullable(),
});
