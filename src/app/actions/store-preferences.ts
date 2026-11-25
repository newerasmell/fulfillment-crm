"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { saveMyStores, STORE_PICK_MAX } from "@/server/store-preferences";

/** „Моите магазини“: saves the stores this member works with (empty = all). */
export async function saveMyStoresAction(
  storeIds: string[],
): Promise<{ ok: true; count: number } | { error: string }> {
  const ctx = await requireAccountContext();
  const ids = z.array(z.string().min(1).max(64)).max(STORE_PICK_MAX).safeParse(storeIds);
  if (!ids.success) return { error: "invalid" };
  try {
    const saved = await saveMyStores(actorFrom(ctx), ids.data);
    revalidatePath("/orders");
    revalidatePath("/settings/my-stores");
    return { ok: true, count: saved.length };
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: "forbidden" };
    throw err;
  }
}
