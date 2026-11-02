import { z } from "zod";
import type { ShopifyClient, ShopifyClientOptions } from "@/integrations/shopify/client";
import { SHOPIFY_API_VERSION } from "@/integrations/shopify/config";
import { ShopifyError } from "@/integrations/shopify/errors";
import { ORDERS_PAGE_QUERY, OrdersPage } from "@/integrations/shopify/orders";
import { VARIANTS_PAGE_QUERY, VariantsPage } from "@/integrations/shopify/products";
import { SHOP_QUERY, ShopResponse } from "@/integrations/shopify/queries";
import { TokenProvider } from "@/integrations/shopify/token";
import { shopifyClientForStore } from "@/server/shopify/store-client";
import {
  registerLiveCheck,
  validateProbe,
  type LiveCheck,
  type LiveCheckContext,
  type LiveCheckIssue,
} from "./live-check";
import { evaluatePinnedVersion, recordShopifyVersions } from "./shopify-version";

/**
 * Shopify LiveCheck: the same read queries the import uses (shop, one order page, one variant page — each with
 * first: 1, so the probe is cheap) plus `publicApiVersions` (Admin API QueryRoot: handle, displayName,
 * supported). Queries only — never a mutation.
 */

export const API_VERSIONS_QUERY = /* GraphQL */ `
  query ApiVersions {
    publicApiVersions {
      handle
      displayName
      supported
    }
  }
`;

export const ApiVersionsResponse = z.object({
  publicApiVersions: z.array(
    z.object({ handle: z.string(), displayName: z.string(), supported: z.boolean() }),
  ),
});

const Raw = z.unknown();

async function probe<S extends z.ZodType>(
  client: ShopifyClient,
  name: string,
  document: string,
  variables: Record<string, unknown>,
  schema: S,
  issues: LiveCheckIssue[],
): Promise<z.infer<S> | undefined> {
  let raw: unknown;
  try {
    raw = await client.query(document, variables, Raw);
  } catch (err) {
    // Shopify rejects a query whose fields no longer exist: that is a schema change, not an outage.
    if (err instanceof ShopifyError && err.code === "graphql_error") {
      issues.push({
        breaking: true,
        probe: name,
        code: "query_rejected",
        message: err.message.slice(0, 300),
      });
      return undefined;
    }
    throw err;
  }
  const r = validateProbe(name, schema, raw);
  issues.push(...r.issues);
  return r.data;
}

function clientOptions(ctx: LiveCheckContext): ShopifyClientOptions {
  if (!ctx.fetchImpl) return ctx.sleep ? { sleep: ctx.sleep } : {};
  return { fetchImpl: ctx.fetchImpl, tokens: new TokenProvider(ctx.fetchImpl), sleep: ctx.sleep };
}

export const shopifyLiveCheck: LiveCheck = {
  type: "SHOPIFY",
  async run(target, ctx) {
    const { client } = await shopifyClientForStore(target.accountId, target.id, clientOptions(ctx));
    const issues: LiveCheckIssue[] = [];
    await probe(client, "shop", SHOP_QUERY, {}, ShopResponse, issues);
    await probe(
      client,
      "orders",
      ORDERS_PAGE_QUERY,
      { first: 1, after: null, query: "" },
      OrdersPage,
      issues,
    );
    await probe(
      client,
      "variants",
      VARIANTS_PAGE_QUERY,
      { first: 1, after: null, query: null },
      VariantsPage,
      issues,
    );
    const versions = await probe(client, "apiVersions", API_VERSIONS_QUERY, {}, ApiVersionsResponse, issues);
    if (versions) {
      const list = versions.publicApiVersions.map((v) => ({ handle: v.handle, supported: v.supported }));
      await recordShopifyVersions(list, ctx.now);
      const status = evaluatePinnedVersion(SHOPIFY_API_VERSION, ctx.now ?? new Date(), list);
      if (status.level !== "ok") {
        // Retired = Shopify serves a newer version than our queries were written for: treat as breaking.
        const retired = !list.some((v) => v.handle === SHOPIFY_API_VERSION && v.supported);
        issues.push({ breaking: retired, probe: "apiVersions", code: "version", message: status.reason });
      }
    }
    return { probes: ["shop", "orders", "variants", "apiVersions"], issues };
  },
};

let registered = false;
/** Called by the worker at start (and by tests); safe to call more than once. */
export function registerShopifyLiveCheck() {
  if (registered) return;
  registerLiveCheck(shopifyLiveCheck);
  registered = true;
}
