import { getTranslations } from "next-intl/server";
import { DomainError } from "@/server/accounts";
import { PageHeader } from "@/components/ui/PageHeader";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { listCompanies } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import { replacementDraft } from "@/server/labels/replacement";
import { euCouriers, manualConnections } from "@/server/labels/views";
import { ManualForm } from "./form";

/** "Нова пратка" (SPEC §6.6): from warehouse stock or label-only (FHB Joy / euShipments AWB). */
export default async function NewManualShipmentPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const ctx = await requireAccountContext("orders.fulfill");
  const actor = actorFrom(ctx);
  const t = await getTranslations("manual");
  // „Изпрати замяна“ from an order: the form starts from it (an order outside the member's companies → not found).
  const from = (await searchParams).from;
  let replacement: Awaited<ReturnType<typeof replacementDraft>> | null = null;
  let notFound = false;
  if (from)
    try {
      replacement = await replacementDraft(actor, from);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      notFound = true;
    }
  const [companies, connections, products] = await Promise.all([
    listCompanies(actorFrom(ctx)),
    manualConnections(actor),
    accountDb(ctx.accountId).product.findMany({
      // The original order's products are always in the list (the list is capped).
      where: replacement?.lines.length
        ? { OR: [{ archived: false }, { id: { in: replacement.lines.map((l) => l.productId) } }] }
        : undefined,
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
      {notFound && (
        <p className="m-0 rounded-md bg-warn-bg px-3 py-2 text-sm text-warn" role="status">
          {t("replacement.notFound")}
        </p>
      )}
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
        products={
          replacement
            ? [
                ...products,
                ...replacement.lines
                  .filter((l) => !products.some((p) => p.id === l.productId))
                  .map((l) => ({ id: l.productId, sku: l.productId, name: "" })),
              ]
            : products
        }
        replacement={replacement}
      />
    </>
  );
}
