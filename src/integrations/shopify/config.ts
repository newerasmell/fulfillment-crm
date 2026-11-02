/**
 * Shopify GraphQL Admin API version, pinned (SPEC §4). 2026-10 is the latest stable at build time
 * (released 2026-10-01, supported until 2027-10-16). Bump it deliberately, after reading the release notes;
 * the API-change watcher (phase 9) flags upcoming deprecations.
 */
export const SHOPIFY_API_VERSION = "2026-10";

/** Only real Shopify admin hosts: the app's client secret is never sent anywhere else. */
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,98}\.myshopify\.com$/;

export function normaliseShopDomain(raw: string): string {
  const d = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!SHOP_DOMAIN.test(d)) throw new Error("invalid_shop_domain");
  return d;
}

export const isShopDomain = (d: string) => SHOP_DOMAIN.test(d);
