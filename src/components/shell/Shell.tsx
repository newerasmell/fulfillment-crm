import { cookies } from "next/headers";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { ConnectionType, LiveMode } from "@/generated/prisma/client";
import { can } from "@/server/auth/rbac";
import type { AccountContext } from "@/server/auth/session";
import { accountDb } from "@/server/db/client";
import { AccountSwitcher } from "./AccountSwitcher";
import { CreateMenu, ProfileMenu, ScopeControl, SearchBox } from "./HeaderControls";
import { Icon } from "@/components/icons";
import { NAV_GROUPS, NAV_HOME } from "./nav";
import { NavLink } from "./NavLink";
import { isScope, SCOPE_COOKIE } from "./scope";

const MODE_COLOR: Record<LiveMode, string> = {
  READ_ONLY: "text-muted",
  DRY_RUN: "text-accent-strong",
  CANARY: "text-warn",
  LIVE: "text-ok",
};

const isFhb = (t: ConnectionType) => t === "FHB_V3" || t === "FHB_JOY";

async function ModeCard({ accountId }: { accountId: string }) {
  const t = await getTranslations();
  const connections = await accountDb(accountId).fulfillmentConnection.findMany({
    where: { enabled: true },
    select: { id: true, name: true, type: true, liveMode: true },
    orderBy: { name: "asc" },
  });
  return (
    <Link
      href="/warehouses"
      className="block rounded-[10px] border border-line px-3 py-2.5 text-ink no-underline hover:bg-hover"
    >
      <span className="mb-1.5 block text-[11px] font-semibold tracking-wider text-muted uppercase">
        {t("nav.modeCard")}
      </span>
      {connections.length === 0 && (
        <span className="block text-[13px] text-muted">{t("nav.noConnections")}</span>
      )}
      {connections.map((c) => (
        <span key={c.id} className="flex min-h-[22px] items-center gap-2 text-[13px]">
          <span aria-hidden className={`size-2 rounded-full ${isFhb(c.type) ? "bg-fhb" : "bg-eu"}`} />
          {c.name}
          <span className={`ml-auto font-semibold ${MODE_COLOR[c.liveMode]}`}>{t(`mode.${c.liveMode}`)}</span>
        </span>
      ))}
    </Link>
  );
}

export async function Shell({ ctx, children }: { ctx: AccountContext; children: React.ReactNode }) {
  const t = await getTranslations("nav");
  const th = await getTranslations("header");
  const locale = await getLocale();
  const rawScope = (await cookies()).get(SCOPE_COOKIE)?.value;
  const scope = isScope(rawScope) ? rawScope : "all";
  return (
    <div className="flex min-h-screen flex-wrap">
      <nav
        aria-label={t("label")}
        className="flex max-w-[248px] min-w-[220px] flex-[1_1_232px] flex-col gap-0.5 border-r border-line bg-surface px-3 pt-3.5 pb-5"
      >
        <div className="flex items-center gap-2.5 px-1.5 pt-1 pb-3">
          <span
            aria-hidden
            className="flex size-7 items-center justify-center rounded-lg bg-dark text-[13px] font-bold text-white"
          >
            F
          </span>
          <span className="font-bold tracking-tight">Fulfillment CRM</span>
        </div>
        <AccountSwitcher label={t("account")} current={ctx.accountId} accounts={ctx.memberships} />
        <NavLink href={NAV_HOME.href} icon={NAV_HOME.icon} label={t(NAV_HOME.key)} />
        {NAV_GROUPS.map((g) => (
          <div key={g.key} className="flex flex-col gap-0.5">
            <div className="px-2.5 pt-3.5 pb-1 text-[11px] font-semibold tracking-wider text-label uppercase">
              {t(`groups.${g.key}`)}
            </div>
            {g.items
              .filter((i) => !i.permission || can(ctx.role, i.permission))
              .map((i) => (
                <NavLink key={i.href} href={i.href} icon={i.icon} label={t(i.key)} />
              ))}
          </div>
        ))}
        <div className="min-h-4 flex-1" />
        <ModeCard accountId={ctx.accountId} />
      </nav>
      <div className="flex min-w-0 flex-[999_1_640px] flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-7 py-3">
          <SearchBox />
          <ScopeControl scope={scope} />
          <CreateMenu />
          <button
            type="button"
            aria-label={th("notifications")}
            className="flex size-11 items-center justify-center rounded-[10px] border border-line bg-surface"
          >
            <Icon name="bell" />
          </button>
          <ProfileMenu name={ctx.user.name} locale={locale} />
        </header>
        <main className="flex flex-col gap-6 px-7 pt-6 pb-12">{children}</main>
      </div>
    </div>
  );
}
