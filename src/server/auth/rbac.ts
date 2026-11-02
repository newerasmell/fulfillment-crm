import type { Role } from "@/generated/prisma/client";

/**
 * Role matrix (SPEC §3). One place that decides who may do what; UI hides what the server would refuse,
 * but the server check (`requirePermission`) is the one that counts.
 */
export const PERMISSIONS = {
  "account.read": ["OWNER", "ADMIN", "OPERATOR", "WAREHOUSE", "VIEWER"],
  "companies.manage": ["OWNER", "ADMIN"],
  "companies.archive": ["OWNER"],
  "account.settings": ["OWNER", "ADMIN"],
  "members.manage": ["OWNER", "ADMIN"],
  "members.grantOwner": ["OWNER"],
  "credentials.write": ["OWNER", "ADMIN"],
  "stores.manage": ["OWNER", "ADMIN"],
  "stores.raiseMode": ["OWNER"],
  "stores.sync": ["OWNER", "ADMIN", "OPERATOR"],
  "products.match": ["OWNER", "ADMIN", "OPERATOR", "WAREHOUSE"],
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
  /** Create/update products at a warehouse (an FHB product id is permanent). */
  "vendorProducts.write": ["OWNER", "ADMIN"],
  /** Edit or cancel an order at the warehouse while it is still editable there. */
  "orders.cancelAtWarehouse": ["OWNER", "ADMIN", "OPERATOR"],
  /** Queue a read-only refresh of a warehouse mirror (GET calls only). */
  "connections.sync": ["OWNER", "ADMIN", "OPERATOR"],
  /** See the exact vendor payloads in the outbox (they carry customer addresses). */
  "outbox.payloads": ["OWNER", "ADMIN"],
  /** Start an euShipments read-side sync by hand (read calls only). */
  "eushipments.sync": ["OWNER", "ADMIN", "OPERATOR", "WAREHOUSE"],
  "apiWatch.read": ["OWNER", "ADMIN"],
  "apiWatch.manage": ["OWNER", "ADMIN"],
  /** Routing rules (Настройки → Правила за маршрут): view, create, edit, reorder, delete. */
  "routing.manage": ["OWNER", "ADMIN"],
  /** Raw payloads on the order detail (Shopify order JSON, routing JSON, outbox payloads): admin only. */
  "orders.rawPayloads": ["OWNER", "ADMIN"],
  /** The review records list (decisions, diffs of customer data, time spent). */
  "reviews.read": ["OWNER", "ADMIN", "OPERATOR"],
  /** Configure the review reason codes. */
  "reviews.reasonCodes": ["OWNER", "ADMIN"],
  /** Alerts and tasks: assign and resolve with a note (Сигнали и задачи). */
  "alerts.manage": ["OWNER", "ADMIN", "OPERATOR", "WAREHOUSE"],
  /** Product lines: create/rename/archive lines and put companies into them (Настройки → Линии и фирми). */
  "lines.manage": ["OWNER", "ADMIN"],
  /** Master catalogue tool, mapping import and match decisions of a line (Продукти). */
  "lines.catalogue": ["OWNER", "ADMIN", "OPERATOR", "WAREHOUSE"],
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
