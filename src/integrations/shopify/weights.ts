import { z } from "zod";

/**
 * Product weight write-back (Admin API 2026-10, checked with the Shopify dev docs / schema on 2026-11-03):
 *  - read:  `productVariant(id:)` → `inventoryItem.measurement.weight { unit value }` (Weight: WeightUnit + Float);
 *           needs read_products (or read_inventory);
 *  - write: `productVariantsBulkUpdate(productId:, variants: [ProductVariantsBulkInput!]!)` with
 *           `inventoryItem: InventoryItemInput { measurement: InventoryItemMeasurementInput { weight: WeightInput
 *           { unit: WeightUnit!, value: Float! } } }`; needs the write_products access scope;
 *           payload `productVariants`, `userErrors { field message code }`.
 * WeightUnit: GRAMS | KILOGRAMS | OUNCES | POUNDS. We always send GRAMS (our master stores whole grams).
 */

export const VARIANT_WEIGHT_READ_QUERY = /* GraphQL */ `
  query VariantWeightRead($id: ID!) {
    productVariant(id: $id) {
      id
      product {
        id
      }
      inventoryItem {
        id
        measurement {
          weight {
            unit
            value
          }
        }
      }
    }
  }
`;

export const VARIANT_WEIGHT_UPDATE_MUTATION = /* GraphQL */ `
  mutation VariantWeightUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        inventoryItem {
          measurement {
            weight {
              unit
              value
            }
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/** Unknown units are kept as strings and never converted (they simply do not match a target weight). */
export const ShopifyWeight = z.object({ unit: z.string(), value: z.number() }).nullish();

export const VariantWeightReadSchema = z.object({
  productVariant: z
    .object({
      id: z.string(),
      product: z.object({ id: z.string() }),
      inventoryItem: z.object({
        id: z.string().optional(),
        measurement: z.object({ weight: ShopifyWeight }).nullish(),
      }),
    })
    .nullable(),
});
export type VariantWeightRead = z.infer<typeof VariantWeightReadSchema>;

export const VariantWeightUpdateSchema = z.object({
  productVariantsBulkUpdate: z
    .object({
      productVariants: z
        .array(
          z.object({
            id: z.string(),
            inventoryItem: z.object({ measurement: z.object({ weight: ShopifyWeight }).nullish() }).nullish(),
          }),
        )
        .nullish(),
      userErrors: z.array(
        z.object({
          field: z.array(z.string()).nullish(),
          message: z.string(),
          code: z.string().nullish(),
        }),
      ),
    })
    .nullable(),
});

const TO_GRAMS: Record<string, number> = {
  GRAMS: 1,
  KILOGRAMS: 1000,
  OUNCES: 28.349523125,
  POUNDS: 453.59237,
};

/** A Shopify Weight in whole grams (null when absent, zero or in an unknown unit). */
export function weightToGrams(w: { unit: string; value: number } | null | undefined): number | null {
  if (!w || !(w.value > 0)) return null;
  const f = TO_GRAMS[w.unit];
  return f ? Math.round(w.value * f) : null;
}

/** The variables of the one-variant update we send (exactly what DRY_RUN records). */
export function variantWeightVariables(productGid: string, variantGid: string, grams: number) {
  return {
    productId: productGid,
    variants: [
      { id: variantGid, inventoryItem: { measurement: { weight: { unit: "GRAMS", value: grams } } } },
    ],
  };
}
