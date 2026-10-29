import { describe, expect, it } from "vitest";
import { assertCan, can, canAssignRole, ForbiddenError, PERMISSIONS, ROLES, type Permission } from "./rbac";

// Expected matrix, written out independently of the implementation.
const EXPECTED: Record<Permission, string> = {
  //                      OWNER ADMIN OPER WARE VIEW
  "account.read": "11111",
  "account.create": "10000",
  "account.settings": "11000",
  "members.manage": "11000",
  "members.grantOwner": "10000",
  "credentials.write": "11000",
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
