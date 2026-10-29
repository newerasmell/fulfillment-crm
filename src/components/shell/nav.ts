import type { IconName } from "@/components/icons";
import type { Permission } from "@/server/auth/rbac";

export interface NavItem {
  href: string;
  key: string; // i18n key under "nav"
  icon: IconName;
  permission?: Permission;
}

export interface NavGroup {
  key: "work" | "warehouse" | "money" | "settings";
  items: NavItem[];
}

/** Sidebar per docs/DESIGN.md "Navigation". The last four settings items are additions for phase 0 admin. */
export const NAV_HOME: NavItem = { href: "/", key: "home", icon: "home" };

export const NAV_GROUPS: NavGroup[] = [
  {
    key: "work",
    items: [
      { href: "/orders", key: "orders", icon: "orders" },
      { href: "/shipments", key: "shipments", icon: "truck" },
      { href: "/returns", key: "returns", icon: "returns" },
      { href: "/tickets", key: "tickets", icon: "ticket" },
    ],
  },
  {
    key: "warehouse",
    items: [
      { href: "/products", key: "products", icon: "box" },
      { href: "/inbound", key: "inbound", icon: "inbound" },
      { href: "/manual-shipments", key: "manualShipments", icon: "tag" },
    ],
  },
  {
    key: "money",
    items: [
      { href: "/cod", key: "cod", icon: "cash" },
      { href: "/invoices", key: "invoices", icon: "invoice" },
      { href: "/reports", key: "reports", icon: "chart" },
    ],
  },
  {
    key: "settings",
    items: [
      { href: "/warehouses", key: "warehouses", icon: "warehouse" },
      { href: "/stores", key: "stores", icon: "store" },
      { href: "/routing", key: "routing", icon: "route" },
      { href: "/ai", key: "ai", icon: "sparkle" },
      { href: "/directory", key: "directory", icon: "pin" },
      { href: "/settings/members", key: "members", icon: "users" },
      { href: "/settings/credentials", key: "credentials", icon: "key", permission: "credentials.write" },
      { href: "/settings/audit", key: "audit", icon: "log", permission: "audit.read" },
      { href: "/settings/jobs", key: "jobs", icon: "cog", permission: "jobs.admin" },
    ],
  },
];

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
