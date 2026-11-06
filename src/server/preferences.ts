import { z } from "zod";
import { systemDb } from "@/server/db/client";

/**
 * Personal settings of the signed-in person (UserPreference, global like User): the same in every account and on
 * every device. Only ever read or written for the session's own user id.
 */

export const ORDER_DESIGNS = ["new", "classic"] as const;
export type OrderDesign = (typeof ORDER_DESIGNS)[number];
const Design = z.enum(ORDER_DESIGNS);

/** The order page design of this user; "new" until they choose. */
export async function orderDesignOf(userId: string): Promise<OrderDesign> {
  const p = await systemDb().userPreference.findUnique({ where: { userId }, select: { orderDesign: true } });
  const parsed = Design.safeParse(p?.orderDesign);
  return parsed.success ? parsed.data : "new";
}

export async function setOrderDesign(userId: string, raw: unknown): Promise<OrderDesign> {
  const design = Design.parse(raw);
  await systemDb().userPreference.upsert({
    where: { userId },
    create: { userId, orderDesign: design },
    update: { orderDesign: design },
  });
  return design;
}
