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
    /** GraphQL `errors[].extensions.code` values (e.g. ACCESS_DENIED, undefinedField), when Shopify sent any. */
    public readonly graphqlCodes: readonly string[] = [],
  ) {
    super(message);
    this.name = "ShopifyError";
  }
}
