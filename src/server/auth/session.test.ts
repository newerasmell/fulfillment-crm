import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
const { pickActiveMembership } = await import("./session");

describe("pickActiveMembership", () => {
  const ms = [{ accountId: "a" }, { accountId: "b" }];
  it("uses the cookie when it names one of the user's accounts", () => {
    expect(pickActiveMembership(ms, "b")?.accountId).toBe("b");
  });
  it("falls back to the first account for an unknown or foreign cookie", () => {
    expect(pickActiveMembership(ms, "someone-elses")?.accountId).toBe("a");
    expect(pickActiveMembership(ms, undefined)?.accountId).toBe("a");
  });
  it("returns null without memberships", () => {
    expect(pickActiveMembership([], "a")).toBeNull();
  });
});
