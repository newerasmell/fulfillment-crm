import { carrierKey, knownShopifyCompany } from "@/integrations/shopify/fulfillments";

type AliasReader = {
  shopifyCarrierAlias: {
    findUnique(args: {
      where: { accountId_carrierKey: { accountId: string; carrierKey: string } };
      select: { company: true };
    }): Promise<{ company: string } | null>;
  };
};

/**
 * The Shopify tracking company for a shipment's carrier: the company a person picked for this courier name
 * (ShopifyCarrierAlias), else the documented company the name is or names; null when Shopify would have to guess.
 * Callers in a system transaction pass the account explicitly (the alias lookup is keyed by it).
 */
export async function shopifyCompanyFor(
  db: AliasReader,
  accountId: string,
  carrier: string | null | undefined,
): Promise<string | null> {
  const c = carrier?.trim();
  if (!c) return null;
  const alias = await db.shopifyCarrierAlias.findUnique({
    where: { accountId_carrierKey: { accountId, carrierKey: carrierKey(c) } },
    select: { company: true },
  });
  return alias?.company ?? knownShopifyCompany(c);
}
