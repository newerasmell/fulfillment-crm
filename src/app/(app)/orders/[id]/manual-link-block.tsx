import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { shopifyRefOf } from "@/lib/shopify-ref";
import { attachedTo } from "@/server/labels/link";
import { LinkManual } from "./link-manual";

/** A manual order: attached to a Shopify order already (link), or the optional „Прикачи“ box while it is shipping. */
export async function ManualLinkBlock({
  accountId,
  order,
  canLink,
}: {
  accountId: string;
  order: { id: string; source: string; status: string; tags: string[] };
  canLink: boolean;
}) {
  if (order.source !== "MANUAL") return null;
  const t = await getTranslations("orders.linkManual");
  const linked = await attachedTo(accountId, order.id);
  if (linked)
    return (
      <p className="m-0 rounded-lg bg-accent-soft px-3 py-2 text-sm" data-testid="manual-attached">
        {t("attached")}{" "}
        <Link href={`/orders/${linked.id}`} className="font-semibold underline">
          {linked.number}
        </Link>
      </p>
    );
  // Only while the manual order follows a shipment that may be attached.
  if (!canLink || !["ACCEPTED", "PROCESSING", "SHIPPED", "DELIVERED"].includes(order.status)) return null;
  return <LinkManual manualOrderId={order.id} suggested={shopifyRefOf(order.tags)} />;
}
