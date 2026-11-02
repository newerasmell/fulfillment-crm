import { describe, expect, it } from "vitest";
import { GET, POST } from "./route";

const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });
const url = "http://localhost/api/webhooks/fhb/x";

describe("/api/webhooks/fhb/[...path]", () => {
  it("answers 404 to unsigned paths before doing any work, 413 to oversized bodies", async () => {
    expect(
      (await POST(new Request(url, { method: "POST", body: "{}" }), ctx(["c1", "stock", "bad"]))).status,
    ).toBe(404);
    expect((await GET(new Request(url), ctx(["c1", "order", "f1", "sent", "x".repeat(32)]))).status).toBe(
      404,
    );
    expect((await POST(new Request(url, { method: "POST", body: "{}" }), ctx([]))).status).toBe(404);
    expect(
      (await POST(new Request(url, { method: "POST", body: "x".repeat(64_001) }), ctx(["c1", "stock", "t"])))
        .status,
    ).toBe(413);
  });
});
