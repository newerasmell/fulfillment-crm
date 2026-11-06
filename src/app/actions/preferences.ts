"use server";

import { revalidatePath } from "next/cache";
import { requireAccountContext } from "@/server/auth/session";
import { setOrderDesign } from "@/server/preferences";

/** "Изглед: Класически / Нов" on the order page: saved for the signed-in person (every order, every device). */
export async function setOrderDesignAction(design: string): Promise<{ ok?: boolean; error?: string }> {
  const ctx = await requireAccountContext();
  try {
    await setOrderDesign(ctx.user.id, design);
  } catch {
    return { error: "invalid" };
  }
  revalidatePath("/orders", "layout");
  return { ok: true };
}
