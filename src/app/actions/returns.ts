"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { webBoss } from "@/server/jobs/boss";
import {
  markReturnProcessed,
  reopenReturn,
  requestReturnPhotos,
  requestSupportNotify,
  updateReturnsCodSettings,
} from "@/server/returns";
import { enqueueReturnPhotos } from "@/server/returns/jobs";

export type ReturnActionResult = { ok?: boolean; error?: string; queued?: number };

function toError(err: unknown, zodCode = "invalid"): ReturnActionResult {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: zodCode };
  throw err;
}

const Id = z.string().min(1).max(64);

async function act(fn: (actor: ReturnType<typeof actorFrom>) => Promise<unknown>, zodCode?: string) {
  const ctx = await requireAccountContext();
  try {
    await fn(actorFrom(ctx));
  } catch (err) {
    return toError(err, zodCode);
  }
  revalidatePath("/returns");
  return { ok: true };
}

export async function processReturnAction(caseId: string, note: string): Promise<ReturnActionResult> {
  return act((a) => markReturnProcessed(a, Id.parse(caseId), String(note ?? "")), "note_required");
}

export async function reopenReturnAction(caseId: string): Promise<ReturnActionResult> {
  return act((a) => reopenReturn(a, Id.parse(caseId)));
}

export async function notifySupportAction(caseId: string): Promise<ReturnActionResult> {
  return act((a) => requestSupportNotify(a, Id.parse(caseId)));
}

export async function loadReturnPhotosAction(caseId: string): Promise<ReturnActionResult> {
  const ctx = await requireAccountContext();
  let queued = 0;
  try {
    const boss = await webBoss();
    queued = await requestReturnPhotos(actorFrom(ctx), Id.parse(caseId), (d) => enqueueReturnPhotos(boss, d));
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/returns");
  return { ok: true, queued };
}

export async function saveReturnsCodSettingsAction(
  _prev: ReturnActionResult,
  form: FormData,
): Promise<ReturnActionResult> {
  return act((a) =>
    updateReturnsCodSettings(a, {
      returnOverdueDays: Number(form.get("returnOverdueDays")),
      codMissingDays: Number(form.get("codMissingDays")),
      notifySupport: form.get("notifySupport") === "on",
    }),
  );
}
