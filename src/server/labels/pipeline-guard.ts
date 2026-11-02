import { registerGuard } from "@/server/pipeline/transition";

/**
 * Label-only manual shipments (FHB Joy label, euShipments AWB / pre-AWB) have no stock lines and are never a
 * warehouse order. They pass the pipeline once, inside the manual shipment flow (check → approve → queue in one
 * transaction, meta.labelFlow), and must never enter the generic path afterwards: a re-check would route them to
 * a stock warehouse and Fulfill could then queue a vendor order for them. These guards refuse exactly that.
 */

export const LABEL_KINDS = ["JOY_LABEL", "AWB", "PRE_AWB"] as const;
export type LabelKind = (typeof LABEL_KINDS)[number];

const isLabelOnly = async (tx: Parameters<Parameters<typeof registerGuard>[1]>[0], orderId: string) =>
  (await tx.manualShipment.count({ where: { orderId, kind: { in: [...LABEL_KINDS] } } })) > 0;

let registered = false;
export function registerLabelGuards() {
  if (registered) return;
  registered = true;
  for (const cause of ["check_start", "approve", "queue"] as const)
    registerGuard(cause, async (tx, { order, meta }) => {
      if (meta?.labelFlow === true) return null;
      return (await isLabelOnly(tx, order.id)) ? "label_only_order" : null;
    });
}

registerLabelGuards();
