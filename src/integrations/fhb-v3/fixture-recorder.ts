import { z } from "zod";
import type { FhbClient } from "./client";
import { createFixtureScrubber } from "./fixture-scrubber";
import {
  FhbCod,
  FhbCodPage,
  FhbDeliveryPoints,
  FhbOrderPage,
  FhbOrderView,
  FhbParcelServices,
  FhbProductPage,
  FhbProductView,
  FhbReturn,
  FhbReturnPage,
  FhbRmaPage,
  FhbStockLevel,
  FhbStockLevels,
  FhbStockMovementPage,
} from "./schemas";

/**
 * Runs the FHB read side once against a connection and returns SCRUBBED fixtures (P2-03). GET only. The raw
 * body is read with `z.unknown()` (nothing dropped or transformed), validated against our schema for the
 * report, cut to `limit` items per list, then scrubbed — the raw body never leaves this function.
 */

export interface RecordedFixture {
  /** Method + documented path template, never the query (it may hold ids). */
  endpoint: string;
  /** Did the real response match our Zod schema? A mismatch is what P2-09 fixes. */
  schemaOk: boolean;
  /** Paths/codes of the schema issues (no values). */
  schemaIssues: string[];
  body: unknown;
}

const LIST_KEYS = ["products", "orders", "items", "movements"];

function cut(body: unknown, limit: number): { body: unknown; items: number | null } {
  if (Array.isArray(body)) return { body: body.slice(0, limit), items: body.length };
  if (body && typeof body === "object") {
    const o = { ...(body as Record<string, unknown>) };
    for (const k of LIST_KEYS) {
      if (Array.isArray(o[k])) {
        const items = (o[k] as unknown[]).length;
        o[k] = (o[k] as unknown[]).slice(0, limit);
        return { body: o, items };
      }
    }
    return { body: o, items: null };
  }
  return { body, items: null };
}

const firstOf = (body: unknown, key: string, field: string): string | null => {
  const list = (body as Record<string, unknown> | null)?.[key];
  const v = Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined)?.[field] : undefined;
  return typeof v === "string" || typeof v === "number" ? String(v) : null;
};

export function createFhbFixtureRecorder(
  client: FhbClient,
  opts: { limit?: number; now?: Date; pickup?: { service: string; country?: string } } = {},
) {
  const limit = opts.limit ?? 5;
  const now = opts.now ?? new Date();
  const scrubber = createFixtureScrubber();
  const out: { name: string; items: number | null; fixture: RecordedFixture }[] = [];
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  async function get(
    name: string,
    endpoint: string,
    pathname: string,
    schema: z.ZodTypeAny,
    query?: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    const raw = await client.request("GET", pathname, { query, schema: z.unknown() });
    const check = schema.safeParse(raw);
    const { body, items } = cut(raw, limit);
    out.push({
      name,
      items,
      fixture: {
        endpoint: `GET ${endpoint}`,
        schemaOk: check.success,
        schemaIssues: check.success
          ? []
          : check.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.code}`),
        body: scrubber.scrub(body),
      },
    });
    return raw;
  }

  return {
    async record() {
      const products = await get("product-all", "/product/all", "/product/all", FhbProductPage, { page: 1 });
      const productId = firstOf(products, "products", "id");
      if (productId) {
        await get("product", "/product", "/product", FhbProductView, { id: productId });
        await get("stock", "/stock", "/stock", FhbStockLevel, { id: productId });
      }
      await get("stock-all", "/stock/all", "/stock/all", FhbStockLevels);
      await get("stock-movements", "/stock/movements", "/stock/movements", FhbStockMovementPage, {
        from: daysAgo(30).toISOString(),
        page: 1,
      });
      const history = await get("order-history", "/order/history", "/order/history", FhbOrderPage, {
        from: daysAgo(30).toISOString(),
        page: 1,
      });
      const orderId = firstOf(history, "orders", "id");
      if (orderId) await get("order", "/order", "/order", FhbOrderView, { id: orderId });
      const isoDate = (d: Date) => d.toISOString().slice(0, 10);
      await get("rma-list", "/rma/list", "/rma/list", FhbRmaPage, { from: isoDate(daysAgo(90)), page: 1 });
      const returns = await get("return-list", "/return/list", "/return/list", FhbReturnPage, {
        from: isoDate(daysAgo(90)),
        page: 1,
      });
      const uid = firstOf(returns, "items", "uid");
      if (uid) await get("return", "/return/{uid}", `/return/${encodeURIComponent(uid)}`, FhbReturn);
      const cods = await get("cod-list", "/cod/list", "/cod/list", FhbCodPage, {
        from: isoDate(daysAgo(120)),
        page: 1,
      });
      const codId = firstOf(cods, "items", "id");
      if (codId) await get("cod", "/cod", "/cod", FhbCod, { id: codId });
      await get("parcel-service", "/parcel-service", "/parcel-service", FhbParcelServices);
      if (opts.pickup) {
        await get(
          "delivery-point",
          "/delivery-point/{deliveryService}",
          `/delivery-point/${encodeURIComponent(opts.pickup.service)}`,
          FhbDeliveryPoints,
          { country: opts.pickup.country },
        );
      }
      return out;
    },
  };
}
