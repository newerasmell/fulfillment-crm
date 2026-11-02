export type ShopifyErrorCode =
  | "shop_not_permitted" // client credentials grant: app and store are not in the same Shopify organisation
  | "auth_failed"
  | "graphql_error"
  | "http_error"
  | "throttled"
  | "invalid_response";

export class ShopifyError extends Error {
  constructor(
    public readonly code: ShopifyErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ShopifyError";
  }
}
