import type { Prisma } from "@/generated/prisma/client";

/**
 * Queues a tag change of one Shopify order (inside the caller's transaction); the ShopifyTagWrite sender
 * (tag-write.ts) applies it under the store's writeBackMode. Kept apart from the sender so the missing-stock flow and
 * the sender do not import each other.
 */
export async function queueTagChange(
  tx: Prisma.TransactionClient,
  w: {
    accountId: string;
    storeId: string;
    orderId: string;
    add: string[];
    remove: string[];
    createdById?: string;
  },
) {
  const row = await tx.shopifyTagWrite.create({
    data: {
      accountId: w.accountId,
      storeId: w.storeId,
      orderId: w.orderId,
      add: w.add,
      remove: w.remove,
      createdById: w.createdById ?? null,
    },
    select: { id: true },
  });
  return row.id;
}
