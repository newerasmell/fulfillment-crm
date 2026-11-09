import { z } from "zod";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { transition } from "@/server/pipeline";
import { TAG_GATED_FROM } from "@/server/pipeline/rules";
import { getStore, type ScopedActor } from "@/server/stores";
import { hasStoreTag, shopifyTagsOf } from "./order-tag-match";

export { hasStoreTag };

/**
 * "Само поръчки с таг" (owner request 2026-11-09): a store may take only Shopify orders with a tag (e.g. "Confirmed",
 * set when the order is confirmed by phone). Others wait as AWAITING_TAG — not checked, not reviewed, never sent,
 * out of every list but "Чака таг" — and enter review (IMPORTED) when the tag appears. Matching is case-insensitive.
 * Saving the setting re-sorts the store's orders that were not sent to a warehouse yet; orders already with a
 * warehouse are never touched (a tag removed from one of them later opens a task, see orders.ts).
 */

export const StoreOrderTagInput = z.object({
  tag: z
    .string()
    .trim()
    .max(100)
    .nullish()
    .transform((v) => v || null),
});

export async function storeOrderTag(accountId: string, storeId: string) {
  const row = await accountDb(accountId).storeOrderTag.findUnique({
    where: { accountId_storeId: { accountId, storeId } },
    select: { tag: true },
  });
  return row?.tag ?? null;
}

/** Saves (or clears) the store's required tag and re-sorts its not-yet-sent orders. */
export async function setStoreOrderTag(
  actor: ScopedActor,
  storeId: string,
  raw: z.input<typeof StoreOrderTagInput>,
) {
  assertCan(actor.role, "stores.manage");
  const { tag } = StoreOrderTagInput.parse(raw);
  await getStore(actor, storeId); // scope
  const accountId = actor.accountId;
  const before = await storeOrderTag(accountId, storeId);
  const changed = (before ?? "") !== (tag ?? "");
  // Saving the same tag again still re-sorts (repairs a re-sort a crash or deploy cut short).
  if (changed)
    await withAccountTransaction(accountId, async (tx, { lockKey }) => {
      // Imports of this store read the tag inside their own transaction: no import runs half under the old one.
      await lockKey(`store:${storeId}`);
      if (tag)
        await tx.storeOrderTag.upsert({
          where: { accountId_storeId: { accountId, storeId } },
          create: { accountId, storeId, tag, updatedById: actor.userId },
          update: { tag, updatedById: actor.userId },
        });
      else await tx.storeOrderTag.deleteMany({ where: { accountId, storeId } });
    });
  if (changed)
    await recordAudit({
      accountId,
      userId: actor.userId,
      action: "store.order_tag",
      entityType: "Store",
      entityId: storeId,
      before: { tag: before },
      after: { tag },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  return { changed, ...(await resortStoreOrders(accountId, storeId, actor.userId)) };
}

/**
 * Moves the store's not-yet-sent Shopify orders between AWAITING_TAG and review to match the store's tag. Each order
 * is decided inside its own transaction under the same locks as its Shopify import, from the tag setting and the
 * order as they are then (never from the list read first).
 */
export async function resortStoreOrders(accountId: string, storeId: string, userId: string | null) {
  const orders = await accountDb(accountId).order.findMany({
    where: { storeId, source: "SHOPIFY", status: { in: [...TAG_GATED_FROM, "AWAITING_TAG"] } },
    select: { id: true, shopifyOrderGid: true },
  });
  let setAside = 0;
  let released = 0;
  for (const o of orders) {
    try {
      const r = await withAccountTransaction(
        accountId,
        async (tx, { lockKey, lockKeyShared, lockForUpdate }) => {
          await lockKeyShared(`store:${storeId}`);
          if (o.shopifyOrderGid) await lockKey(`shopify-order:${storeId}:${o.shopifyOrderGid}`);
          await lockForUpdate("Order", o.id);
          const [gate, fresh] = await Promise.all([
            tx.storeOrderTag.findFirst({ where: { accountId, storeId }, select: { tag: true } }),
            tx.order.findUnique({ where: { id: o.id }, select: { status: true, raw: true, tags: true } }),
          ]);
          if (!fresh) return null;
          const tagged = !gate || hasStoreTag(shopifyTagsOf(fresh.raw, fresh.tags), gate.tag);
          if (tagged === (fresh.status !== "AWAITING_TAG")) return null;
          const moved = await transition(tx, {
            orderId: o.id,
            ...(tagged
              ? { to: "IMPORTED" as const, cause: "tag_added" as const }
              : { to: "AWAITING_TAG" as const, cause: "tag_missing" as const }),
            actor: userId ? { kind: "user", userId } : { kind: "system" },
            source: "store.order_tag",
            reason: gate?.tag ?? "no tag required",
            mode: "follow",
          });
          return moved.changed ? tagged : null;
        },
      );
      if (r === true) released++;
      else if (r === false) setAside++;
    } catch (err) {
      logger.warn({ orderId: o.id, err: String(err) }, "store tag re-sort skipped an order");
    }
  }
  return { setAside, released };
}
