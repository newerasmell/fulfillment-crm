import { ExternalLinkIcon, iconButtonCls } from "@/components/ui/icons";
import { shopifyAdminOrderUrl } from "@/lib/shopify-admin-url";

/** Square icon link: the order in the store's Shopify admin, in a new tab (owner request 2026-11-11). */
export function OpenInShopifyLink({
  domain,
  orderGid,
  label,
}: {
  domain: string | null | undefined;
  orderGid: string | null | undefined;
  label: string;
}) {
  const href = shopifyAdminOrderUrl(domain, orderGid);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      data-testid="open-in-shopify"
      className={iconButtonCls}
    >
      <ExternalLinkIcon />
    </a>
  );
}
