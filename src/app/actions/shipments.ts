"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { updateShipmentSettings } from "@/server/shipments";
import { markTicketReviewed } from "@/server/tickets";

export type ShipmentActionResult = { ok?: boolean; error?: string };

function toError(err: unknown, zodCode = "invalid"): ShipmentActionResult {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: zodCode };
  throw err;
}

const Id = z.string().min(1).max(64);

export async function saveShipmentSettingsAction(
  _prev: ShipmentActionResult,
  form: FormData,
): Promise<ShipmentActionResult> {
  const ctx = await requireAccountContext();
  try {
    await updateShipmentSettings(actorFrom(ctx), { delayedDays: form.get("delayedDays") });
  } catch (err) {
    return toError(err, "invalid_days");
  }
  revalidatePath("/shipments");
  return { ok: true };
}

export async function reviewTicketAction(ticketId: string, note: string): Promise<ShipmentActionResult> {
  const ctx = await requireAccountContext();
  try {
    await markTicketReviewed(actorFrom(ctx), Id.parse(ticketId), String(note ?? ""));
  } catch (err) {
    return toError(err, "note_required");
  }
  revalidatePath("/tickets");
  return { ok: true };
}
