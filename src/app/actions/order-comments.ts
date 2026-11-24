"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { addOrderComment } from "@/server/order-comments";

/** „Коментари“ on the order page: adds one comment (author = the signed-in member). */
export async function addOrderCommentAction(
  orderId: string,
  body: string,
): Promise<{ ok: true } | { error: string }> {
  const ctx = await requireAccountContext();
  const id = z.string().min(1).max(64).safeParse(orderId);
  if (!id.success) return { error: "not_found" };
  try {
    await addOrderComment(
      { ...actorFrom(ctx), author: ctx.user.name || ctx.user.email },
      id.data,
      String(body ?? ""),
    );
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: "forbidden" };
    if (err instanceof DomainError) return { error: err.code };
    if (err instanceof z.ZodError) return { error: "too_short" };
    throw err;
  }
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/orders");
  return { ok: true };
}
