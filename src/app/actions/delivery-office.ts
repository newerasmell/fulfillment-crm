"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { searchDeliveryOffices, setDeliveryOffice } from "@/server/eushipments/delivery-office";

/** "Доставка" on the order page: До адрес / До офис (Speedy offices, BG). */

export async function searchOfficesAction(orderId: string, q: string) {
  const ctx = await requireAccountContext();
  try {
    return await searchDeliveryOffices(actorFrom(ctx), z.string().min(1).max(64).parse(orderId), String(q));
  } catch (err) {
    if (!(err instanceof DomainError))
      logger.warn({ orderId, err: (err as Error).message }, "office search failed");
    return [];
  }
}

export async function setDeliveryOfficeAction(input: {
  orderId: string;
  version: string;
  choice: { mode: "address" } | { mode: "office"; officeId: number; name: string; courierId?: number } | null;
}): Promise<{ ok: true } | { error: string }> {
  const ctx = await requireAccountContext();
  try {
    await setDeliveryOffice(actorFrom(ctx), input);
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: "forbidden" };
    if (err instanceof DomainError) return { error: err.code };
    if (err instanceof z.ZodError) return { error: "invalid" };
    throw err;
  }
  revalidatePath(`/orders/${input.orderId}`);
  return { ok: true };
}
