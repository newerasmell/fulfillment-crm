import { describe, expect, it } from "vitest";
import {
  alertFor,
  CRM_STATUS,
  elapsedMs,
  isStuckAccepted,
  normaliseStatusText,
  parseVendorDate,
  resolveStatus,
  SEED_STATUSES,
  seedTable,
  stopsPolling,
} from "./status-map";

const table = seedTable();
const cat = (t: string) => resolveStatus(t, table).category;

describe("status text normalisation", () => {
  it("maps Cyrillic look-alikes, dashes, spaces and case to one key", () => {
    expect(normaliseStatusText("Оn hold")).toBe("on hold"); // Cyrillic О from the spec
    expect(normaliseStatusText("On hold")).toBe("on hold");
    expect(normaliseStatusText(" ON\u00A0 HOLD ")).toBe("on hold");
    for (const dash of ["-", "–", "—", "‑", "−", "－"])
      expect(normaliseStatusText(`Insufficient data ${dash} AWB not created`)).toBe(
        "insufficient data - awb not created",
      );
    expect(normaliseStatusText("Insufficient data-AWB not created")).toBe(
      "insufficient data - awb not created",
    );
    expect(normaliseStatusText("Рacked")).toBe("packed"); // Cyrillic Р
  });

  it("every seed text resolves to its own category, keys are unique", () => {
    const keys = new Set(SEED_STATUSES.map((x) => normaliseStatusText(x.text)));
    expect(keys.size).toBe(SEED_STATUSES.length);
    for (const x of SEED_STATUSES)
      expect(resolveStatus(x.text, table)).toMatchObject({ category: x.category });
  });
});

describe("status mapping (INTEGRATION_NOTES §4.5)", () => {
  it.each([
    ["New", "ACCEPTED"],
    ["Information received", "ACCEPTED"],
    ["PreAlert", "ACCEPTED"],
    ["Packed", "PROCESSING"],
    ["Warehouse Pickup", "PROCESSING"],
    ["Warehouse Sofia", "IN_TRANSIT"],
    ["Unloaded hub Montana (BG)", "IN_TRANSIT"],
    ["Linhaul transit", "IN_TRANSIT"],
    ["On delivery", "IN_TRANSIT"],
    ["Unsuccessful delivery attempt", "IN_TRANSIT"],
    ["Insufficient data – AWB not created", "BLOCKED"],
    ["On hold", "BLOCKED"],
    ["Оn hold", "BLOCKED"],
    ["Stockout", "BLOCKED"],
    ["Wrong recipient data", "BLOCKED"],
    ["Delivered", "DELIVERED"],
    ["COD paid", "DELIVERED"],
    ["Returning", "RETURNING"],
    ["Returned", "RETURNING"],
    ["Returned to Warehouse", "RETURN_RECEIVED"],
    ["Product returned to stock", "RETURN_RECEIVED"],
    ["Returned to Client", "RETURN_RECEIVED"],
    ["Cancelled", "CANCELLED"],
    ["Deleted", "CANCELLED"],
    ["canceled/deleted", "CANCELLED"],
    ["Cancel", "CANCEL_PENDING"],
    ["Lost shipment", "EXCEPTION"],
    ["COD Blocked by Authorities", "EXCEPTION"],
    ["Search cancelled", "EXCEPTION"],
  ])("%s → %s", (text, expected) => expect(cat(text)).toBe(expected));

  it("new warehouses/hubs follow the family rule; anything else is UNKNOWN (never thrown)", () => {
    expect(resolveStatus("Warehouse Plovdiv", table)).toMatchObject({
      category: "IN_TRANSIT",
      matched: false,
      family: true,
    });
    expect(resolveStatus("Loaded hub Skopje (MK)", table).category).toBe("IN_TRANSIT");
    expect(resolveStatus("Teleported", table)).toMatchObject({ category: "UNKNOWN", matched: false });
    expect(resolveStatus("", table).category).toBe("UNKNOWN");
  });

  it("CRM statuses and alerts", () => {
    expect(CRM_STATUS.IN_TRANSIT).toBe("SHIPPED");
    expect(CRM_STATUS.CANCEL_PENDING).toBeNull();
    expect(alertFor("BLOCKED", "on hold")).toBe("blocked");
    expect(alertFor("RETURN_RECEIVED", "returned to warehouse")).toBe("return_received");
    expect(alertFor("EXCEPTION", "lost shipment")).toBe("exception");
    expect(alertFor("UNKNOWN", "x")).toBe("unknown_status");
    expect(alertFor("IN_TRANSIT", "unsuccessful delivery attempt")).toBe("delivery_attempt_failed");
    expect(alertFor("IN_TRANSIT", "in transit")).toBeNull();
    expect(alertFor("DELIVERED", "delivered")).toBeNull();
  });

  it("polling stops at final statuses, but not for returns, Cancel or UNKNOWN", () => {
    const rule = (t: string) => resolveStatus(t, table);
    expect(stopsPolling(rule("Delivered"))).toBe(true);
    expect(stopsPolling(rule("Returned"))).toBe(false); // final in the spec, polled until received
    expect(stopsPolling(rule("Returned to Warehouse"))).toBe(true);
    expect(stopsPolling(rule("Cancel"))).toBe(false);
    expect(stopsPolling(rule("Cancelled"))).toBe(true);
    expect(stopsPolling(rule("In transit"))).toBe(false);
    expect(stopsPolling(rule("Teleported"))).toBe(false);
  });
});

describe("Information received threshold", () => {
  it("parses vendor dates as Europe/Sofia local time (summer and winter)", () => {
    expect(parseVendorDate("2026-07-01 12:00:00")?.toISOString()).toBe("2026-07-01T09:00:00.000Z");
    expect(parseVendorDate("2026-12-01 12:00:00")?.toISOString()).toBe("2026-12-01T10:00:00.000Z");
    expect(parseVendorDate("garbage")).toBeNull();
    expect(parseVendorDate(null)).toBeNull();
  });

  it("counts only working days by default", () => {
    const fri = new Date("2026-10-30T12:00:00Z"); // Friday
    const mon = new Date("2026-11-02T12:00:00Z"); // Monday
    expect(elapsedMs(fri, mon, false)).toBe(72 * 3600_000);
    expect(elapsedMs(fri, mon, true)).toBe(24 * 3600_000);
    expect(isStuckAccepted(fri, new Date("2026-11-02T11:00:00Z"))).toBe(false);
    expect(isStuckAccepted(fri, mon)).toBe(true);
    expect(isStuckAccepted(fri, mon, { hours: 48, workingDaysOnly: false })).toBe(true);
    expect(elapsedMs(mon, fri, true)).toBe(0);
  });
});
