import { z } from "zod";
import type { ShopifyClient, ShopifyClientOptions } from "@/integrations/shopify/client";
import {
  INVENTORY_NAMES,
  LOCATION_LEVELS_PAGE,
  LOCATION_LEVELS_QUERY,
  LocationLevelsPage,
  LOCATIONS_PAGE,
  LOCATIONS_QUERY,
  LocationsPage,
} from "@/integrations/shopify/inventory";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, isUniqueViolation } from "@/server/db/client";
import { STOCK_CONNECTION_TYPES } from "@/server/routing/engine";
import { shopifyClientForStore } from "@/server/shopify/store-client";
import type { ScopedActor } from "@/server/stores";

/**
 * Shopify inventory READ side (P5-03 prerequisites, SPEC §4): the store's locations (read_locations) and the
 * "available" / "on_hand" quantity of every variant we know at every location (read_inventory) into
 * StoreLocation + ShopifyInventoryLevel. Reads only, so it runs whatever the store's modes are. The stock board
 * shows it as the Shopify column; the push compares against it (and reads again right before sending).
 */

export type StoreClients = (
  accountId: string,
  storeId: string,
  opts: ShopifyClientOptions,
) => Promise<{ client: ShopifyClient }>;

const defaultClients: StoreClients = (accountId, storeId, opts) =>
  shopifyClientForStore(accountId, storeId, opts);

const MAX_PAGES = 1000;

export async function syncStoreInventory(
  accountId: string,
  storeId: string,
  clients: StoreClients = defaultClients,
  now: Date = new Date(),
) {
  const db = accountDb(accountId);
  const { client } = await clients(accountId, storeId, {});
  // 1. Locations (inactive ones too, so a deactivated mapped location shows up instead of silently vanishing).
  const seen: { id: string; isActive: boolean }[] = [];
  let after: string | null | undefined = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r: z.infer<typeof LocationsPage> = await client.query(
      LOCATIONS_QUERY,
      { first: LOCATIONS_PAGE, after },
      LocationsPage,
    );
    for (const l of r.locations.nodes) {
      seen.push({ id: l.id, isActive: l.isActive });
      await db.storeLocation.upsert({
        where: { storeId_shopifyLocationGid: { storeId, shopifyLocationGid: l.id } },
        create: {
          accountId,
          storeId,
          shopifyLocationGid: l.id,
          name: l.name,
          isActive: l.isActive,
          fulfillmentService: l.fulfillmentService?.handle ?? null,
          fetchedAt: now,
        },
        update: {
          name: l.name,
          isActive: l.isActive,
          fulfillmentService: l.fulfillmentService?.handle ?? null,
          fetchedAt: now,
        },
      });
    }
    if (!r.locations.pageInfo.hasNextPage) break;
    after = r.locations.pageInfo.endCursor;
  }
  // A location Shopify no longer lists is kept (its mapping is history) but marked inactive.
  await db.storeLocation.updateMany({
    where: { storeId, shopifyLocationGid: { notIn: seen.map((s) => s.id) } },
    data: { isActive: false },
  });

  // 2. Levels per active location, joined to our variants by Shopify variant id.
  const links = await db.storeVariantLink.findMany({
    where: { storeId },
    select: { id: true, shopifyVariantGid: true },
  });
  const linkOf = new Map(links.map((l) => [l.shopifyVariantGid, l.id]));
  let levels = 0;
  for (const loc of seen.filter((s) => s.isActive)) {
    let cursor: string | null | undefined = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r: LocationLevelsPage = await client.query(
        LOCATION_LEVELS_QUERY,
        { id: loc.id, first: LOCATION_LEVELS_PAGE, after: cursor },
        LocationLevelsPage,
      );
      if (!r.location) break;
      for (const n of r.location.inventoryLevels.nodes) {
        const q = new Map(n.quantities.map((x) => [x.name, x.quantity]));
        for (const v of n.item.variants?.nodes ?? []) {
          const variantLinkId = linkOf.get(v.id);
          if (!variantLinkId) continue;
          const data = {
            inventoryItemGid: n.item.id,
            tracked: n.item.tracked,
            available: q.get(INVENTORY_NAMES[0]) ?? 0,
            onHand: q.get(INVENTORY_NAMES[1]) ?? null,
            fetchedAt: now,
          };
          await db.shopifyInventoryLevel.upsert({
            where: { variantLinkId_locationGid: { variantLinkId, locationGid: loc.id } },
            create: { accountId, storeId, variantLinkId, locationGid: loc.id, ...data },
            update: data,
          });
          levels++;
        }
      }
      if (!r.location.inventoryLevels.pageInfo.hasNextPage) break;
      cursor = r.location.inventoryLevels.pageInfo.endCursor;
    }
  }
  // Levels not seen in this run no longer exist at Shopify (item removed from a location, location deactivated).
  const removed = await db.shopifyInventoryLevel.deleteMany({ where: { storeId, fetchedAt: { lt: now } } });
  return { locations: seen.length, levels, removed: removed.count };
}

export const LocationMappingInput = z.object({
  storeId: z.string().min(1).max(64),
  locationId: z.string().min(1).max(64),
  /** Warehouse connection this Shopify location stands for; null removes the mapping. */
  connectionId: z.string().min(1).max(64).nullable(),
});

/**
 * Companies whose warehouses may stand for a location of this store: the store's own company and the companies of
 * the same product line (the routing fallback's rule). A store without a company may map none.
 */
export async function storeConnectionCompanies(accountId: string, storeId: string): Promise<string[]> {
  const db = accountDb(accountId);
  const store = await db.store.findUnique({
    where: { id: storeId },
    select: { companyId: true, company: { select: { lineId: true } } },
  });
  if (!store?.companyId) return [];
  const lineId = store.company?.lineId;
  if (!lineId) return [store.companyId];
  const peers = await db.company.findMany({ where: { lineId }, select: { id: true } });
  return [...new Set([store.companyId, ...peers.map((c) => c.id)])];
}

/** Maps one Shopify location to one warehouse (one location per warehouse per store). Audited. */
export async function setLocationConnection(actor: ScopedActor, raw: z.input<typeof LocationMappingInput>) {
  assertCan(actor.role, "inventory.push");
  const input = LocationMappingInput.parse(raw);
  const db = accountDb(actor.accountId);
  const store = await db.store.findUnique({ where: { id: input.storeId }, select: { companyId: true } });
  if (!store || (actor.companyScope && (!store.companyId || !actor.companyScope.includes(store.companyId))))
    throw new DomainError("not_found");
  const loc = await db.storeLocation.findFirst({ where: { id: input.locationId, storeId: input.storeId } });
  if (!loc) throw new DomainError("not_found");
  if (input.connectionId) {
    const c = await db.fulfillmentConnection.findUnique({
      where: { id: input.connectionId },
      select: { type: true, companyId: true },
    });
    if (!c || !STOCK_CONNECTION_TYPES.includes(c.type)) throw new DomainError("not_found");
    if (actor.companyScope && (!c.companyId || !actor.companyScope.includes(c.companyId)))
      throw new DomainError("not_found");
    // Never publish another company's warehouse stock in this shop.
    const allowed = await storeConnectionCompanies(actor.accountId, input.storeId);
    if (!c.companyId || !allowed.includes(c.companyId)) throw new DomainError("connection_other_company");
    const taken = await db.storeLocation.findFirst({
      where: { storeId: input.storeId, connectionId: input.connectionId, id: { not: loc.id } },
      select: { id: true },
    });
    if (taken) throw new DomainError("location_connection_taken");
  }
  try {
    await db.storeLocation.update({ where: { id: loc.id }, data: { connectionId: input.connectionId } });
  } catch (err) {
    // Two concurrent mappings to the same warehouse: the unique index decides.
    if (isUniqueViolation(err)) throw new DomainError("location_connection_taken");
    throw err;
  }
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "inventory.location_mapped",
    entityType: "StoreLocation",
    entityId: loc.id,
    before: { connectionId: loc.connectionId },
    after: { connectionId: input.connectionId },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

export function storeLocations(accountId: string, storeId: string) {
  return accountDb(accountId).storeLocation.findMany({
    where: { storeId },
    select: {
      id: true,
      name: true,
      shopifyLocationGid: true,
      isActive: true,
      fulfillmentService: true,
      connectionId: true,
      fetchedAt: true,
    },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
}
