import type { Role } from "@/generated/prisma/client";

/**
 * Role matrix (SPEC §3). One place that decides who may do what; UI hides what the server would refuse,
 * but the server check (`requirePermission`) is the one that counts.
 */
export const PERMISSIONS = {
  "account.read": ["OWNER", "ADMIN", "OPERATOR", "WAREHOUSE", "VIEWER"],
  "account.create": ["OWNER"],
  "account.settings": ["OWNER", "ADMIN"],
  "members.manage": ["OWNER", "ADMIN"],
  "members.grantOwner": ["OWNER"],
  "credentials.write": ["OWNER", "ADMIN"],
  "connections.manage": ["OWNER", "ADMIN"],
  "connections.raiseMode": ["OWNER"],
  "outbox.killSwitch": ["OWNER"],
  "outbox.confirmCanary": ["OWNER", "ADMIN", "OPERATOR"],
  "orders.review": ["OWNER", "ADMIN", "OPERATOR"],
  "orders.fulfill": ["OWNER", "ADMIN", "OPERATOR"],
  "stock.manage": ["OWNER", "ADMIN", "WAREHOUSE"],
  "inbound.manage": ["OWNER", "ADMIN", "WAREHOUSE"],
  "audit.read": ["OWNER", "ADMIN"],
  "jobs.admin": ["OWNER", "ADMIN"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const ROLES: readonly Role[] = ["OWNER", "ADMIN", "OPERATOR", "WAREHOUSE", "VIEWER"];

export function can(role: Role | null | undefined, permission: Permission): boolean {
  return !!role && (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export class ForbiddenError extends Error {
  constructor(public readonly permission: Permission) {
    super(`Forbidden: missing permission ${permission}`);
    this.name = "ForbiddenError";
  }
}

export function assertCan(role: Role | null | undefined, permission: Permission) {
  if (!can(role, permission)) throw new ForbiddenError(permission);
}

/** Only an OWNER may create or remove another OWNER; nobody can grant above their own role. */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (target === "OWNER") return actor === "OWNER";
  return can(actor, "members.manage");
}
