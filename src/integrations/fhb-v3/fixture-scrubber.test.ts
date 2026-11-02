import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import examples from "./__fixtures__/openapi-examples.json";
import readExamples from "./__fixtures__/read-examples.json";
import { FhbClient, type FetchLike } from "./client";
import { createFhbFixtureRecorder } from "./fixture-recorder";
import { createFixtureScrubber, findUnscrubbed } from "./fixture-scrubber";
import { FhbOrderPage, FhbProductPage, FhbReturnPage, FhbStockMovementPage } from "./schemas";

const ex = { ...examples, ...readExamples } as unknown as Record<string, unknown>;
const RECORDED = path.join(import.meta.dirname, "__fixtures__", "recorded");

describe("recorded fixtures hold only scrubber output", () => {
  const files = existsSync(RECORDED) ? readdirSync(RECORDED).filter((f) => f.endsWith(".json")) : [];

  it.each(files.length ? files : ["(none recorded yet)"])("%s", (file) => {
    if (!file.endsWith(".json")) return;
    const fixture = JSON.parse(readFileSync(path.join(RECORDED, file), "utf8")) as Record<string, unknown>;
    expect(Object.keys(fixture).sort()).toEqual(["body", "endpoint", "schemaIssues", "schemaOk"]);
    expect(fixture.endpoint).toMatch(/^GET \/[a-z/{}-]+$/i);
    expect(findUnscrubbed(fixture.body), `unscrubbed values in ${file}`).toEqual([]);
  });
});

describe("fixture scrubber", () => {
  it("replaces every documented example value and the result still parses with our schemas", () => {
    const s = createFixtureScrubber();
    for (const [key, schema] of [
      ["GET /product/all 200 response", FhbProductPage],
      ["GET /order/history 200 response", FhbOrderPage],
      ["GET /stock/movements 200 response", FhbStockMovementPage],
      ["GET /return/list 200 response", FhbReturnPage],
    ] as const) {
      const scrubbed = s.scrub(ex[key]);
      expect(findUnscrubbed(scrubbed), key).toEqual([]);
      expect(schema.safeParse(scrubbed).success, key).toBe(true);
    }
  });

  it("removes personal and business data but keeps shapes, codes and references", () => {
    const s = createFixtureScrubber();
    const out = s.scrub({
      page: 2,
      total: 245,
      orders: [
        {
          id: "PZA-10234",
          variable_symbol: "12345",
          status: "imported",
          parcel_service: "gls",
          cod: 42.5,
          value: -3,
          created_at: "2026-04-18T14:00:00+0200",
          invoice_date: "2026-04-18",
          invoice: "https://shop.example.com/inv.pdf",
          recipient: {
            address: { name: "Jan Novak", street: "Hlavna 1", country: "SK" },
            contact: { email: "jan.novak@example.com", phone: "+421900123456" },
          },
          items: [{ id: "RSK-1", quantity: 3 }],
        },
      ],
      movements: [{ product: "RSK-1", change: 3 }],
    });
    const text = JSON.stringify(out);
    for (const real of ["PZA-10234", "12345", "Jan Novak", "Hlavna", "jan.novak", "421900123456", "RSK-1"]) {
      expect(text).not.toContain(real);
    }
    const o = out.orders[0]!;
    expect(o.status).toBe("imported");
    expect(o.parcel_service).toBe("gls");
    expect(o.recipient.address.country).toBe("SK");
    expect(out.page).toBe(2);
    expect(Number.isInteger(o.cod)).toBe(false);
    expect(o.value).toBeLessThan(0);
    expect(o.created_at).toMatch(/^2001-\d{2}-\d{2}T\d{2}:\d{2}:00\+0200$/);
    expect(o.invoice_date).toMatch(/^2001-\d{2}-\d{2}$/);
    expect(o.recipient.contact.email).toMatch(/@example\.test$/);
    expect(o.recipient.contact.phone).toMatch(/^\+999000\d{6}$/);
    // The same product id is the same synthetic id everywhere; equal quantities stay equal.
    expect(out.movements[0]!.product).toBe(o.items[0]!.id);
    expect(out.movements[0]!.change).toBe(o.items[0]!.quantity);
    expect(findUnscrubbed(out)).toEqual([]);
  });

  it("flags values that did not come from the scrubber", () => {
    expect(
      findUnscrubbed({
        products: [{ id: "RSK-1", ean: "8580000001234", stock_quantity: 17, name: "SYN-3" }],
        created_at: "2026-01-01",
        status: "has spaces not a code",
      }),
    ).toEqual([
      "$.products[0].id",
      "$.products[0].ean",
      "$.products[0].stock_quantity",
      "$.created_at",
      "$.status",
    ]);
  });
});

describe("fixtures:record", () => {
  it("uses GET only, records scrubbed bodies with schema results and cuts lists", async () => {
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    const bodies: Record<string, unknown> = {
      "/product/all": {
        page: 1,
        total: 7,
        products: Array.from({ length: 7 }, (_, i) => ({
          id: `RSK-${i}`,
          name: "Real name",
          ean: "8580000001234",
        })),
      },
      "/product": { id: "RSK-0", name: "Real name" },
      "/stock": { id: "RSK-0", quantity: 3 },
      "/stock/all": ex["GET /stock/all 200 response"],
      "/stock/movements": ex["GET /stock/movements 200 response"],
      "/order/history": ex["GET /order/history 200 response"],
      "/order": ex["GET /order 200 response"],
      "/rma/list": ex["GET /rma/list 200 response"],
      "/return/list": ex["GET /return/list 200 response"],
      "/return/AB00001": ex["GET /return/{uid} 200 response"],
      "/cod/list": ex["GET /cod/list 200 response"],
      "/cod": ex["GET /cod 200 response"],
      "/parcel-service": ex["GET /parcel-service 200 example"],
      "/delivery-point/gls": { unexpected: "shape" },
    };
    const fetchImpl = vi.fn<FetchLike>(async (u, init = {}) => {
      const url = new URL(u);
      if (url.pathname === "/v3/login") return json({ token: "t", expiration: "2099-01-01T00:00:00+0000" });
      expect(init.method).toBe("GET");
      const body = bodies[url.pathname.replace("/v3", "")];
      if (body === undefined) throw new Error(`unexpected ${url.pathname}`);
      return json(body);
    });
    const client = new FhbClient({ appId: "a", secret: "s" }, { fetchImpl, sleep: async () => {} });
    const files = await createFhbFixtureRecorder(client, {
      limit: 2,
      pickup: { service: "gls", country: "CZ" },
    }).record();
    expect(files.map((f) => f.name)).toEqual([
      "product-all",
      "product",
      "stock",
      "stock-all",
      "stock-movements",
      "order-history",
      "order",
      "rma-list",
      "return-list",
      "return",
      "cod-list",
      "cod",
      "parcel-service",
      "delivery-point",
    ]);
    const all = files.find((f) => f.name === "product-all")!;
    expect(all.items).toBe(7);
    expect((all.fixture.body as { products: unknown[] }).products).toHaveLength(2);
    for (const f of files) {
      expect(findUnscrubbed(f.fixture.body), f.name).toEqual([]);
      expect(JSON.stringify(f.fixture)).not.toMatch(/RSK-|Real name|8580000001234|Jan Novak/);
    }
    const dp = files.find((f) => f.name === "delivery-point")!;
    expect(dp.fixture).toMatchObject({ endpoint: "GET /delivery-point/{deliveryService}", schemaOk: false });
    expect(files.find((f) => f.name === "order")!.fixture.schemaOk).toBe(true);
  });
});
