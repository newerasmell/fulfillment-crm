"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { assignAlert, resolveAlert } from "@/server/alerts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";

export type AlertActionResult = { ok?: boolean; error?: string };

function toError(err: unknown): AlertActionResult {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: "note_required" };
  throw err;
}

const Id = z.string().min(1).max(64);

export async function assignAlertAction(alertId: string, toMe: boolean): Promise<AlertActionResult> {
  const ctx = await requireAccountContext();
  try {
    await assignAlert(actorFrom(ctx), Id.parse(alertId), toMe ? ctx.user.id : null);
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/alerts");
  return { ok: true };
}

export async function resolveAlertAction(alertId: string, note: string): Promise<AlertActionResult> {
  const ctx = await requireAccountContext();
  try {
    await resolveAlert(actorFrom(ctx), Id.parse(alertId), String(note ?? ""));
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/alerts");
  revalidatePath("/");
  return { ok: true };
}
