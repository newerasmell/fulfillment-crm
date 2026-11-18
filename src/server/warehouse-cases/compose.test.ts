import { describe, expect, it } from "vitest";
import { levelOf, suggestedLevel } from "./cases";
import { customerEmail, formatWhen, warehouseEmail, type CaseLine } from "@/lib/warehouse-case-emails";
import { isFrozen } from "./sku";

// Synthetic data only.
const now = new Date("2026-11-18T15:00:00Z");
const line = (over: Partial<CaseLine> = {}): CaseLine => ({
  ref: "TST-1001",
  orderNumber: "#1001",
  awb: "AWB123",
  status: "Awaiting pickup",
  since: new Date("2026-11-16T09:00:00Z"),
  hours: 54,
  items: [{ sku: "SKU-A", title: "Sample Perfume", quantity: 1 }],
  zeroStock: [],
  ...over,
});
const base = { company: "Example Ltd", warehouse: "WH", to: ["wh@example.com"], cc: ["cc@example.com"] };

describe("warehouse emails", () => {
  it("first email: every order with its reference, AWB, status, hours and the stock note; asks for a reply today", () => {
    const e = warehouseEmail({
      ...base,
      level: 1,
      escalationTo: [],
      lines: [line(), line({ ref: "TST-1002", hours: 30, awb: null, zeroStock: ["SKU-A"] })],
      lastSentAt: null,
      repliedSinceLast: false,
      now,
    });
    expect(e.subject).toBe("2 orders not processed for over 54 h – Example Ltd");
    expect(e.to).toEqual(["wh@example.com"]);
    expect(e.body).toContain(
      'TST-1001 | AWB AWB123 | status "Awaiting pickup" | sent 16.11.2026 10:00 | 54 h',
    );
    expect(e.body).toContain("Your stock report shows 0 for SKU-A.");
    expect(e.body).toContain("Please reply today");
    expect(e.body).not.toContain("Test Buyer");
  });

  it("second notice names the unanswered email; after a reply it thanks for it instead", () => {
    const opts = { ...base, level: 2 as const, escalationTo: [], lines: [line()], now };
    const silent = warehouseEmail({
      ...opts,
      lastSentAt: new Date("2026-11-17T08:00:00Z"),
      repliedSinceLast: false,
    });
    expect(silent.subject).toBe(
      "SECOND NOTICE: 1 order stuck for over 54 h, no reply since 17.11.2026 – Example Ltd",
    );
    const replied = warehouseEmail({
      ...opts,
      lastSentAt: new Date("2026-11-17T08:00:00Z"),
      repliedSinceLast: true,
    });
    expect(replied.subject).not.toContain("no reply");
    expect(replied.body).toContain("thank you for your reply");
  });

  it("final notice: escalation addresses in copy, a deadline in Slovak time", () => {
    const e = warehouseEmail({
      ...base,
      level: 3,
      escalationTo: ["boss@example.com", "wh@example.com"],
      lines: [line()],
      lastSentAt: new Date("2026-11-16T08:00:00Z"),
      repliedSinceLast: false,
      now,
    });
    expect(e.cc).toEqual(["cc@example.com", "boss@example.com"]);
    expect(e.subject).toMatch(/^FINAL NOTICE/);
    expect(e.body).toContain(
      `by ${formatWhen(new Date(now.getTime() + 24 * 3_600_000))} (Europe/Bratislava time)`,
    );
    expect(formatWhen(now)).toBe("18.11.2026 16:00");
  });
});

describe("customer email", () => {
  const input = {
    subject: null,
    body: null,
    to: "buyer@example.com",
    customerName: "Test Buyer",
    orderNumber: "#1001",
    items: [{ title: "Sample Perfume", quantity: 2 }],
    store: "Example Store",
    discountPercent: 15,
  };
  it("fills the default template with the code", () => {
    const e = customerEmail({ ...input, discountCode: "SORRY15" });
    expect(e.to).toEqual(["buyer@example.com"]);
    expect(e.subject).toBe("Your order #1001: a delay");
    expect(e.body).toContain("Hello Test Buyer,");
    expect(e.body).toContain("(2 x Sample Perfume)");
    expect(e.body).toContain("15% discount code for your next order: SORRY15");
    expect(e.body).toMatch(/Example Store$/);
  });
  it("without a code the discount line is left out; a company template is used as written", () => {
    expect(customerEmail({ ...input, discountCode: "" }).body).not.toContain("discount");
    const own = customerEmail({
      ...input,
      subject: "Objednávka {order_number}",
      body: "Dobrý den {customer_name},\nkód {discount_code} ({discount_percent} %)\n{unknown}",
      discountCode: "X1",
    });
    expect(own.subject).toBe("Objednávka #1001");
    expect(own.body).toBe("Dobrý den Test Buyer,\nkód X1 (15 %)\n{unknown}");
  });
});

describe("levels and freezing", () => {
  const s = { firstEmailHours: 24, reminderHours: 48, decisionHours: 72 };
  it("level by hours; the next email never skips a step", () => {
    expect([11, 24, 50, 80].map((h) => levelOf(h, s))).toEqual([0, 1, 2, 3]);
    expect(suggestedLevel(0, 0)).toBeNull();
    expect(suggestedLevel(3, 0)).toBe(1);
    expect(suggestedLevel(3, 1)).toBe(2);
    expect(suggestedLevel(2, 2)).toBe(2);
    expect(suggestedLevel(3, 3)).toBe(3);
  });
  it("two incidents within 14 days freeze a product, further apart they do not", () => {
    const d = (day: number) => new Date(Date.UTC(2026, 10, day));
    expect(isFrozen([d(1)])).toBe(false);
    expect(isFrozen([d(1), d(10)])).toBe(true);
    expect(isFrozen([d(1), d(20)])).toBe(false);
  });
});
