"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/icons";
import { isActive } from "./nav";

export function NavLink({ href, icon, label }: { href: string; icon: IconName; label: string }) {
  const active = isActive(usePathname(), href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 no-underline ${
        active ? "bg-accent-soft font-semibold text-accent-strong" : "text-ink-2 hover:bg-hover"
      }`}
    >
      <Icon name={icon} />
      {label}
    </Link>
  );
}
