import { describe, expect, it } from "vitest";
import { clientIp } from "./client-ip";

const h = (xff?: string) => (name: string) => (name === "x-forwarded-for" ? (xff ?? null) : null);

describe("clientIp", () => {
  it("takes the entry added by the trusted proxy, not a client-supplied one", () => {
    expect(clientIp(h("6.6.6.6, 203.0.113.7"))).toBe("203.0.113.7");
    expect(clientIp(h("203.0.113.7"))).toBe("203.0.113.7");
    expect(clientIp(h())).toBeNull();
  });
});
