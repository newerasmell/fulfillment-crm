import type { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { accountDb } from "@/server/db/client";
import type { PipelineActor } from "@/server/pipeline";
import { PRE_APPROVAL } from "@/server/shopify/statuses";
import { checkOrder } from "./validate";

/**
 * Re-runs the pre-flight checks of the OPEN orders (pre-approval statuses) a source fix affects: a new phone
 * rule for a country, a product weight. Through the same checkOrder() as the "Провери отново" button, so the
 * pipeline (CHECKING → READY / NEEDS_REVIEW) and the stored OrderCheck stay the only truth. The first
 * RECHECK_INLINE_LIMIT orders are checked right away (the screen that triggered it shows the result); the rest
 * go to the background queue in one batch.
 */

export const RECHECK_INLINE_LIMIT = 25;
const RECHECK_MAX = 5000;

export type EnqueueCheck = (orderIds: string[]) => Promise<void>;

export interface RecheckResult {
  total: number;
  checked: number;
  queued: number;
  /** Orders checked inline whose blocking findings are gone now. */
  cleared: number;
  failed: number;
}

/** Orders still waiting for their store's tag, or held for their quantity, are not checked (not work yet). */
export const OPEN_FOR_RECHECK = [...PRE_APPROVAL].filter((s) => s !== "AWAITING_TAG" && s !== "QTY_HOLD");

export async function recheckOpenOrders(
  accountId: string,
  where: Prisma.OrderWhereInput,
  opts: { actor: PipelineActor; enqueue?: EnqueueCheck; inlineLimit?: number },
): Promise<RecheckResult> {
  const orders = await accountDb(accountId).order.findMany({
    where: { AND: [where, { status: { in: OPEN_FOR_RECHECK } }] },
    select: { id: true },
    orderBy: { placedAt: "asc" },
    take: RECHECK_MAX,
  });
  const limit = opts.inlineLimit ?? RECHECK_INLINE_LIMIT;
  const inline = opts.enqueue ? orders.slice(0, limit) : orders;
  const rest = opts.enqueue ? orders.slice(limit) : [];
  const out: RecheckResult = { total: orders.length, checked: 0, queued: 0, cleared: 0, failed: 0 };
  for (const o of inline) {
    try {
      const r = await checkOrder(accountId, o.id, { actor: opts.actor });
      out.checked++;
      if (r.hardCount === 0) out.cleared++;
    } catch (err) {
      // One broken order never stops the others; it keeps its previous check and can be re-checked by hand.
      out.failed++;
      logger.warn({ orderId: o.id, err: (err as Error).message }, "recheck failed");
    }
  }
  if (rest.length && opts.enqueue) {
    await opts.enqueue(rest.map((o) => o.id));
    out.queued = rest.length;
  }
  return out;
}

/** Orders shipping to a country (the address country wins, as in the validators). */
export function ordersToCountry(country: string): Prisma.OrderWhereInput {
  const cc = country.toUpperCase();
  return {
    OR: [
      { shippingAddress: { path: ["countryCode"], equals: cc } },
      { shippingAddress: { path: ["countryCode"], equals: cc.toLowerCase() } },
      { countryCode: cc },
      { countryCode: cc.toLowerCase() },
    ],
  };
}

export const ordersWithProducts = (productIds: string[]): Prisma.OrderWhereInput => ({
  lines: { some: { productId: { in: productIds } } },
});
