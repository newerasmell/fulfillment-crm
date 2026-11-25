import { logger } from "@/lib/logger";
import { queueShopifyCancels } from "@/server/fulfill/writeback";
import { settleOrderTasksNow } from "@/server/order-tasks";
import { syncWarehouseCases } from "@/server/warehouse-cases/cases";

/**
 * After a warehouse cancel was confirmed and committed (by euShipments' answer, the AWB check or a person): the
 * order's „Блокирани в склад“ case and its tasks whose cause is gone are settled at once (owner report 2026-11-25),
 * not at the next 10-minute sweep. History stays: case rows keep their outcome, closed tasks their note.
 * Never throws.
 */
export async function settleAfterWarehouseCancel(accountId: string, orderId: string, source: string) {
  try {
    await syncWarehouseCases(accountId);
  } catch (err) {
    logger.warn({ orderId, err: String((err as Error)?.message ?? err).slice(0, 300) }, "case settle failed");
  }
  // The Shopify fulfillment of the cancelled shipment is cancelled too (sent by the next write-back sweep, ≤ 2 min).
  try {
    await queueShopifyCancels({ accountId, orderId });
  } catch (err) {
    logger.warn(
      { orderId, err: String((err as Error)?.message ?? err).slice(0, 300) },
      "shopify cancel queue failed",
    );
  }
  return settleOrderTasksNow(accountId, orderId, source);
}
