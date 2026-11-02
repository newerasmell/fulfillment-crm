import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/PageHeader";
import type { AccountContext } from "@/server/auth/session";
import { listEuConnections } from "@/server/eushipments/connections";
import { accountDb } from "@/server/db/client";
import { WarehouseChip } from "./ui";

/** Складове и връзки → euShipments section (kept in its own file so the shared page only gains one line). */
export async function EuShipmentsWarehousesLink() {
  const t = await getTranslations("eushipments");
  return (
    <Card>
      <Link
        href="/warehouses/eushipments"
        className="inline-flex min-h-11 items-center gap-2 font-semibold text-accent hover:underline"
      >
        <WarehouseChip />
        {t("connectionsLink")}
      </Link>
    </Card>
  );
}

/** Продукти → the euShipments products still waiting for a link to a master product, per connection. */
export async function EuShipmentsProductsLink({ ctx }: { ctx: AccountContext }) {
  const t = await getTranslations("eushipments");
  const connections = await listEuConnections(ctx);
  if (connections.length === 0) return null;
  const counts = await Promise.all(
    connections.map((c) =>
      accountDb(ctx.accountId).vendorProduct.count({
        where: { connectionId: c.id, archived: false, productId: null },
      }),
    ),
  );
  return (
    <Card>
      <h2 className="mt-0 flex items-center gap-2 text-base font-semibold">
        <WarehouseChip /> {t("productsLink")}
      </h2>
      <p className="mt-0 text-sm text-muted">{t("productsLinkHelp")}</p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {connections.map((c, i) => (
          <li key={c.id}>
            <Link
              href={`/warehouses/eushipments/${c.id}?tab=products&filter=unmatched`}
              className="text-accent hover:underline"
            >
              {c.name}: {counts[i]}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
