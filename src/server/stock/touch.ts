import type { Prisma } from "@/generated/prisma/client";

const CLOSED = ["CANCELLED", "DELIVERED", "COD_PAID", "FULFILLED_EXTERNALLY", "RETURN_RECEIVED"] as const;

/**
 * A variant re-linked to another master moves the reservations of the open orders that sell it, without touching
 * the orders themselves: their updatedAt is bumped so the fast stock sync (which looks at orders changed in the
 * last minutes) pushes both the old and the new product to every store. Inside the caller's transaction.
 */
export async function touchOrdersOfVariant(tx: Prisma.TransactionClient, variantLinkId: string) {
  await tx.order.updateMany({
    where: { status: { notIn: [...CLOSED] }, lines: { some: { variantLinkId } } },
    data: { updatedAt: new Date() },
  });
}
