import { describe, expect, it } from "vitest";
import { readCapped } from "./read-capped";

const streamed = (parts: string[]) =>
  new Request("http://x/", {
    method: "POST",
    body: new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    }),
    // @ts-expect-error Node's fetch needs this for stream bodies
    duplex: "half",
  });

describe("readCapped", () => {
  it("reads chunked bodies and stops past the cap", async () => {
    expect(await readCapped(streamed(['{"a":', "1}"]), 100)).toBe('{"a":1}');
    expect(await readCapped(streamed(["x".repeat(60), "y".repeat(60)]), 100)).toBeNull();
    expect(await readCapped(new Request("http://x/", { method: "POST", body: "ок" }), 10)).toBe("ок");
  });
});
