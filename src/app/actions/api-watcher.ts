"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { resolveApiAlert } from "@/server/api-watcher/view";
import { actorFrom, requireAccountContext } from "@/server/auth/session";

const AlertId = z.string().min(1).max(64);

export async function resolveApiAlertAction(alertId: string) {
  const ctx = await requireAccountContext("apiWatch.manage");
  try {
    // resolveApiAlert re-checks apiWatch.manage (assertCan) and throws ForbiddenError without it.
    await resolveApiAlert(actorFrom(ctx), AlertId.parse(alertId));
  } catch (err) {
    // Already resolved / not visible to this member: nothing to do, just show the current list again.
    if (!(err instanceof DomainError)) throw err;
  }
  revalidatePath("/settings/api-changes");
}
