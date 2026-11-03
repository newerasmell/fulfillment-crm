import { z } from "zod";
import { ShopifyWeight } from "./weights";

/**
 * Variant queries (API 2026-10: barcodes are a connection, `barcodes { nodes { value } }`; the variant weight
 * is `inventoryItem.measurement.weight { unit value }` — a suggestion for the master weight, never a key).
 */

/** Bounded by the 1000-point query cost cap (see query-cost.test.ts). */
export const VARIANTS_PAGE_SIZE = 50;
export const PRODUCT_VARIANTS_PAGE_SIZE = 50;

/** One barcode is enough: it is shown as a hint only, never used as a key. */
const VARIANT_FIELDS = /* GraphQL */ `
  fragment VariantFields on ProductVariant {
    id
    sku
    title
    displayName
    updatedAt
    barcodes(first: 1) {
      nodes {
        value
      }
    }
    inventoryItem {
      measurement {
        weight {
          unit
          value
        }
      }
    }
    product {
      id
      title
      vendor
      status
    }
  }
`;

export const VARIANTS_PAGE_QUERY = /* GraphQL */ `
  ${VARIANT_FIELDS}
  query VariantsPage($first: Int!, $after: String, $query: String) {
    productVariants(first: $first, after: $after, query: $query, sortKey: ID) {
      nodes {
        ...VariantFields
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const PRODUCT_VARIANTS_QUERY = /* GraphQL */ `
  ${VARIANT_FIELDS}
  query ProductVariants($id: ID!, $after: String) {
    product(id: $id) {
      id
      variants(first: ${PRODUCT_VARIANTS_PAGE_SIZE}, after: $after) {
        nodes {
          ...VariantFields
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const ShopifyVariant = z.object({
  id: z.string(),
  sku: z.string().nullish(),
  title: z.string(),
  displayName: z.string(),
  updatedAt: z.string(),
  barcodes: z.object({ nodes: z.array(z.object({ value: z.string() })) }),
  inventoryItem: z.object({ measurement: z.object({ weight: ShopifyWeight }).nullish() }).nullish(),
  product: z.object({ id: z.string(), title: z.string(), vendor: z.string(), status: z.string() }),
});
export type ShopifyVariant = z.infer<typeof ShopifyVariant>;

export const VariantsPage = z.object({
  productVariants: z.object({
    nodes: z.array(ShopifyVariant),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
  }),
});

export const ProductVariants = z.object({
  product: z
    .object({
      id: z.string(),
      variants: z.object({
        nodes: z.array(ShopifyVariant),
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
      }),
    })
    .nullable(),
});
