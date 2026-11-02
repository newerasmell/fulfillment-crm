import { describe, expect, it } from "vitest";
import { POST } from "./route";

describe("POST /api/webhooks/shopify", () => {
  it("rejects unsigned, unknown-shop and oversized requests before doing any work", async () => {
    const post = (body: string, headers: Record<string, string> = {}) =>
      POST(new Request("http://localhost/api/webhooks/shopify", { method: "POST", body, headers }));
    expect((await post("{}")).status).toBe(401);
    expect(
      (
        await post("{}", {
          "x-shopify-shop-domain": "nobody.myshopify.com",
          "x-shopify-topic": "orders/create",
          "x-shopify-webhook-id": "w1",
          "x-shopify-hmac-sha256": "AAAA",
        })
      ).status,
    ).toBe(401);
    expect((await post("x".repeat(1_000_001))).status).toBe(413);
  });
});
