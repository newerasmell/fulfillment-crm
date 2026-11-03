import { describe, expect, it } from "vitest";
import { assertCan, can, canAssignRole, ForbiddenError, PERMISSIONS, ROLES, type Permission } from "./rbac";

// Expected matrix, written out independently of the implementation.
const EXPECTED: Record<Permission, string> = {
  //                      OWNER ADMIN OPER WARE VIEW
  "account.read": "11111",
  "companies.manage": "11000",
  "companies.archive": "10000",
  "account.settings": "11000",
  "members.manage": "11000",
  "members.grantOwner": "10000",
  "credentials.write": "11000",
  "stores.manage": "11000",
  "stores.raiseMode": "10000",
  "stores.archive": "10000",
  "stores.sync": "11100",
  "products.match": "11110",
  "connections.manage": "11000",
  "connections.raiseMode": "10000",
  "outbox.killSwitch": "10000",
  "outbox.confirmCanary": "11100",
  "orders.review": "11100",
  "orders.fulfill": "11100",
  "stock.manage": "11010",
  "inbound.manage": "11010",
  "audit.read": "11000",
  "jobs.admin": "11000",
  "vendorProducts.write": "11000",
  "orders.cancelAtWarehouse": "11100",
  "connections.sync": "11100",
  "outbox.payloads": "11000",
  "eushipments.sync": "11110",
  "apiWatch.read": "11000",
  "apiWatch.manage": "11000",
  "routing.manage": "11000",
  "orders.rawPayloads": "11000",
  "reviews.read": "11100",
  "reviews.reasonCodes": "11000",
  "alerts.manage": "11110",
  "lines.manage": "11000",
  "lines.catalogue": "11110",
  "orders.reroute": "11000",
  "stock.settings": "11000",
  "inventory.push": "11000",
  "returns.manage": "11110",
  "cod.read": "11100",
  "ai.read": "11100",
  "ai.manage": "10000",
  "ai.audit": "11100",
  "ai.rules": "11000",
  "ai.log": "11000",
  "tickets.review": "11110",
  "shipments.settings": "11000",
  "invoices.read": "11100",
  "reports.read": "11100",
};

describe("role matrix", () => {
  it("covers every permission", () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [permission, row] of Object.entries(EXPECTED) as [Permission, string][]) {
    it(permission, () => {
      ROLES.forEach((role, i) => expect(can(role, permission), `${role} ${permission}`).toBe(row[i] === "1"));
    });
  }

  it("denies when there is no membership", () => {
    expect(can(null, "account.read")).toBe(false);
    expect(() => assertCan(undefined, "account.read")).toThrow(ForbiddenError);
  });

  it("only owners can assign the owner role", () => {
    expect(canAssignRole("OWNER", "OWNER")).toBe(true);
    expect(canAssignRole("ADMIN", "OWNER")).toBe(false);
    expect(canAssignRole("ADMIN", "OPERATOR")).toBe(true);
    expect(canAssignRole("OPERATOR", "VIEWER")).toBe(false);
  });
});
