import { z } from "zod";

/** Variant queries (API 2026-10: barcodes are a connection, `barcodes { nodes { value } }`). */

const VARIANT_FIELDS = /* GraphQL */ `
  fragment VariantFields on ProductVariant {
    id
    sku
    title
    displayName
    updatedAt
    barcodes(first: 5) {
      nodes {
        value
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
  query ProductVariants($id: ID!) {
    product(id: $id) {
      id
      variants(first: 250) {
        nodes {
          ...VariantFields
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
  product: z.object({ id: z.string(), variants: z.object({ nodes: z.array(ShopifyVariant) }) }).nullable(),
});
