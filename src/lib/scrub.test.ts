import { describe, expect, it } from "vitest";
import { scrubText } from "./scrub";

describe("scrubText", () => {
  it("masks emails and phone-like numbers and caps length", () => {
    expect(scrubText("recipient jan.novak@example.cz, phone +421 905 123 456 invalid")).toBe(
      "recipient [email], phone [number] invalid",
    );
    expect(scrubText("HTTP 502 after 30s")).toBe("HTTP 502 after 30s");
    expect(scrubText("x".repeat(600))).toHaveLength(500);
  });
});
