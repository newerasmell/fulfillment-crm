import { getTranslations } from "next-intl/server";
import { killSwitchAction, resumeOutboxAction } from "@/app/actions/outbox";
import { Card, PageHeader } from "@/components/ui/PageHeader";
import { can } from "@/server/auth/rbac";
import { requireAccountContext } from "@/server/auth/session";
import { accountDb } from "@/server/db/client";

export default async function WarehousesPage() {
  const ctx = await requireAccountContext();
  const t = await getTranslations();
  const db = accountDb(ctx.accountId);
  const account = await db.account.findUniqueOrThrow({
    where: { id: ctx.accountId },
    select: { outboxPaused: true },
  });
  const connections = await db.fulfillmentConnection.findMany({
    select: { id: true, name: true, type: true, liveMode: true },
    orderBy: { name: "asc" },
  });
  return (
    <>
      <PageHeader title={t("pages.warehouses")} />
      <Card>
        {connections.length === 0 ? (
          <p className="m-0 text-muted">{t("warehouses.empty")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {connections.map((c) => (
              <li key={c.id} className="flex min-h-11 items-center gap-3 border-b border-line-soft">
                <span className="font-medium">{c.name}</span>
                <span className="text-muted">{c.type}</span>
                <span className="ml-auto font-semibold">{t(`mode.${c.liveMode}`)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {can(ctx.role, "outbox.killSwitch") && (
        <Card className={account.outboxPaused ? "border-block" : ""}>
          <h2 className="mt-0 text-base font-semibold">{t("warehouses.emergencyTitle")}</h2>
          {account.outboxPaused ? (
            <>
              <p role="status" className="rounded-lg bg-block-bg px-3 py-2 text-block">
                {t("warehouses.paused")}
              </p>
              <form action={resumeOutboxAction}>
                <button
                  type="submit"
                  className="min-h-11 rounded-[10px] border border-line px-4 font-semibold"
                >
                  {t("warehouses.resume")}
                </button>
              </form>
            </>
          ) : (
            <>
              <p className="text-muted">{t("warehouses.emergencyBody")}</p>
              <form action={killSwitchAction}>
                <button
                  type="submit"
                  className="min-h-11 rounded-[10px] bg-block px-4 font-semibold text-white"
                >
                  {t("warehouses.stop")}
                </button>
              </form>
            </>
          )}
        </Card>
      )}
    </>
  );
}
