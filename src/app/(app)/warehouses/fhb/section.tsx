import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/PageHeader";
import type { AccountContext } from "@/server/auth/session";
import { can } from "@/server/auth/rbac";
import { listFhbConnections } from "@/server/fhb/mirror";
import { NewFhbConnectionForm } from "./forms";
import { FhbChip, Freshness } from "./ui";

/** FHB part of Складове и връзки: connection cards (mode, freshness, mirror link) and the add form. */
export async function FhbConnectionsSection({ ctx }: { ctx: AccountContext }) {
  const t = await getTranslations("fhb");
  const tm = await getTranslations("mode");
  const connections = await listFhbConnections(ctx);
  const manage = can(ctx.role, "connections.manage") && can(ctx.role, "credentials.write");
  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <FhbChip />
          <h2 className="m-0 text-base font-semibold">{t("conn.title")}</h2>
        </div>
        {connections.length === 0 ? (
          <p className="mb-0 text-muted">{t("conn.empty")}</p>
        ) : (
          <ul className="m-0 mt-3 grid list-none gap-3 p-0 md:grid-cols-2">
            {connections.map((c) => {
              const products = c.fhbSyncStates.find((s) => s.resource === "products");
              const failing = c.fhbSyncStates.filter((s) => s.lastError).length;
              return (
                <li key={c.id} className="rounded-[var(--radius-card)] border border-line p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/warehouses/fhb/${c.id}`}
                      className="font-semibold text-accent hover:underline"
                    >
                      {c.name}
                    </Link>
                    <span className="text-sm text-muted">{c.company?.name ?? "—"}</span>
                    <span className="ml-auto rounded-full border border-line px-2 py-0.5 text-[12px] font-semibold">
                      {tm(c.liveMode)}
                    </span>
                  </div>
                  <dl className="m-0 mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted">{t("conn.products")}</dt>
                    <dd className="m-0 font-mono">{c._count.vendorProducts}</dd>
                    <dt className="text-muted">{t("conn.orders")}</dt>
                    <dd className="m-0 font-mono">{c._count.fhbOrders}</dd>
                    <dt className="text-muted">{t("conn.freshness")}</dt>
                    <dd className="m-0">
                      <Freshness state={products} />
                    </dd>
                  </dl>
                  {!c.enabled && <p className="mb-0 text-sm text-warn">{t("conn.disabled")}</p>}
                  {!c.credentialId && <p className="mb-0 text-sm text-block">{t("errors.no_credentials")}</p>}
                  {failing > 0 && (
                    <p className="mb-0 text-sm text-block">{t("conn.failing", { count: failing })}</p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-3 text-sm">
                    <Link href={`/warehouses/fhb/${c.id}`} className="text-accent hover:underline">
                      {t("conn.openMirror")}
                    </Link>
                    <a
                      href="https://zoe2.fhb.sk"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline"
                    >
                      {t("conn.openZoe")}
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {manage && ctx.companies.length > 0 && (
        <Card>
          <h2 className="mt-0 text-base font-semibold">{t("conn.add")}</h2>
          <p className="mt-0 text-sm text-muted">{t("conn.addHelp")}</p>
          <NewFhbConnectionForm companies={ctx.companies} />
        </Card>
      )}
    </>
  );
}
