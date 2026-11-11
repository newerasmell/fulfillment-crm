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

/** Key prefix of the no-courier rules (upper-case: carrierKey() lower-cases, so no typed name can match). */
export const NOCARRIER_PREFIX = "NOCARRIER:";
/**
 * Shipments the warehouse reported WITHOUT a courier (owner report 2026-11-11: every Express One parcel of one
 * warehouse came without a name, so the choice made for one could not reach the others): a person's choice is
 * remembered per warehouse and destination country under this key (ShopifyCarrierAlias), never a courier name.
 */
export const noCarrierKey = (
  connectionId: string,
  country: string | null | undefined,
  companyId: string | null | undefined,
) => `${NOCARRIER_PREFIX}${connectionId}:${(country ?? "").toUpperCase() || "-"}:${companyId ?? "-"}`;

type NoCarrierDb = AliasReader & {
  fulfillment: {
    updateMany(args: {
      where: { id: string; accountId: string; OR: ({ carrier: null } | { carrier: string })[] };
      data: { carrier: string };
    }): Promise<{ count: number }>;
    findFirst(args: {
      where: { id: string; accountId: string };
      select: { carrier: true };
    }): Promise<{ carrier: string | null } | null>;
  };
};

/**
 * A shipment without a courier gets the one remembered for its warehouse + country (written on the shipment, so
 * the tracking link of that courier applies too). Returns the carrier the shipment has afterwards.
 */
export async function applyNoCarrierRule(
  db: NoCarrierDb,
  accountId: string,
  f: {
    id: string;
    carrier: string | null;
    connectionId: string;
    countryCode: string | null;
    companyId: string | null;
  },
): Promise<string | null> {
  if (f.carrier?.trim()) return f.carrier;
  const rule = await db.shopifyCarrierAlias.findUnique({
    where: {
      accountId_carrierKey: {
        accountId,
        carrierKey: noCarrierKey(f.connectionId, f.countryCode, f.companyId),
      },
    },
    select: { company: true },
  });
  if (!rule) return f.carrier;
  // "No courier" is null or an empty name (a warehouse may send ""); a name set meanwhile is kept.
  const res = await db.fulfillment.updateMany({
    where: { id: f.id, accountId, OR: [{ carrier: null }, { carrier: f.carrier ?? "" }] },
    data: { carrier: rule.company },
  });
  if (res.count === 1) return rule.company;
  return (
    (await db.fulfillment.findFirst({ where: { id: f.id, accountId }, select: { carrier: true } }))
      ?.carrier ?? null
  );
}
