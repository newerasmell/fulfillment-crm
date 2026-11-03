import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { listCompanies } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import { euCouriers, manualConnections } from "@/server/labels/views";
import { ManualForm } from "./form";

/** "Нова пратка" (SPEC §6.6): from warehouse stock or label-only (FHB Joy / euShipments AWB). */
export default async function NewManualShipmentPage() {
  const ctx = await requireAccountContext("orders.fulfill");
  const actor = actorFrom(ctx);
  const t = await getTranslations("manual");
  const [companies, connections, products] = await Promise.all([
    listCompanies(actorFrom(ctx)),
    manualConnections(actor),
    accountDb(ctx.accountId).product.findMany({
      select: { id: true, sku: true, name: true },
      orderBy: { sku: "asc" },
      take: 2000,
    }),
  ]);
  const couriers: Record<
    string,
    { courierId: number; name: string; toOffice: boolean; country: string | null }[]
  > = {};
  for (const c of connections.filter((c) => c.type === "EUSHIPMENTS"))
    couriers[c.id] = (await euCouriers(actor, c.id)).map((x) => ({
      courierId: x.courierId,
      name: x.name,
      toOffice: x.toOffice,
      country: x.country,
    }));
  return (
    <>
      <PageHeader title={t("form.title")} subtitle={t("form.subtitle")} />
      <ManualForm
        companies={companies.map((c) => ({ id: c.id, name: c.name }))}
        defaultCompanyId={ctx.activeCompanyId ?? companies[0]?.id ?? ""}
        connections={connections.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          liveMode: c.liveMode,
          companyId: c.companyId,
          parcelServices: c.joy?.parcelServices ?? [],
          pickupServices: c.joy?.pickupServices ?? [],
        }))}
        couriers={couriers}
        products={products}
      />
    </>
  );
}
