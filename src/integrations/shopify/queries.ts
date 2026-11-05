import { z } from "zod";

/** Shapes of the Shopify responses we use (API 2026-10). Unknown extra fields are ignored. */

export const SHOP_QUERY = /* GraphQL */ `
  query Shop {
    shop {
      name
      myshopifyDomain
      currencyCode
    }
  }
`;

export const ShopResponse = z.object({
  shop: z.object({ name: z.string(), myshopifyDomain: z.string(), currencyCode: z.string() }),
});

/** Scopes the app was granted on this store (connection test: what is missing from REQUIRED_SCOPES). */
export const APP_SCOPES_QUERY = /* GraphQL */ `
  query AppScopes {
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
  }
`;

export const AppScopesResponse = z.object({
  currentAppInstallation: z.object({ accessScopes: z.array(z.object({ handle: z.string() })) }),
});
