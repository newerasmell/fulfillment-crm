import { describe, expect, it } from "vitest";
import { isFhbOrderEditable, mapFhbOrderStatus } from "./status-map";

describe("FHB status map (INTEGRATION_NOTES §2.4)", () => {
  const table: [string, string, boolean][] = [
    ["pending", "ACCEPTED", true],
    ["new", "ACCEPTED", false],
    ["imported", "ACCEPTED", false],
    ["b2b_new", "ACCEPTED", false],
    ["confirmed", "PROCESSING", false],
    ["packed", "PROCESSING", false],
    ["sent", "SHIPPED", false],
    ["delivered", "DELIVERED", false],
    ["returned", "RETURN_RECEIVED", false],
    ["rejected", "BLOCKED", false],
  ];
  for (const [raw, status, editable] of table) {
    it(`${raw} → ${status}`, () => {
      const m = mapFhbOrderStatus(raw);
      expect(m).toMatchObject({ status, raw, known: true, editable });
    });
  }

  it("only pending is editable/cancellable", () => {
    expect(isFhbOrderEditable("pending")).toBe(true);
    expect(isFhbOrderEditable(" Pending ")).toBe(true);
    for (const raw of ["new", "imported", "b2b_new", "confirmed", null, undefined, ""]) {
      expect(isFhbOrderEditable(raw)).toBe(false);
    }
  });

  it("rejected raises an operator alert", () => {
    expect(mapFhbOrderStatus("rejected").alert).toBe("rejected");
    expect(mapFhbOrderStatus("sent").alert).toBeNull();
  });

  it("unknown values map to UNKNOWN with an alert and are never thrown", () => {
    expect(mapFhbOrderStatus("teleported")).toEqual({
      status: "UNKNOWN",
      raw: "teleported",
      known: false,
      editable: false,
      alert: "unknown_status",
    });
    expect(mapFhbOrderStatus(null)).toMatchObject({ status: "UNKNOWN", raw: null, alert: "unknown_status" });
  });

  it("is case and whitespace tolerant but keeps the raw value", () => {
    expect(mapFhbOrderStatus(" SENT ")).toMatchObject({ status: "SHIPPED", raw: "SENT" });
  });

  it("returned_at wins over the order status", () => {
    expect(mapFhbOrderStatus("sent", { returnedAt: "2026-07-30T10:00:00+0200" }).status).toBe(
      "RETURN_RECEIVED",
    );
    expect(mapFhbOrderStatus("delivered", { returnedAt: null }).status).toBe("DELIVERED");
    // an unknown raw status keeps its alert even when the return is known
    expect(mapFhbOrderStatus("odd", { returnedAt: "2026-07-30" })).toMatchObject({
      status: "RETURN_RECEIVED",
      alert: "unknown_status",
    });
  });
});
