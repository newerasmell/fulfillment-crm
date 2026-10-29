"use server";

import { revalidatePath } from "next/cache";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { killSwitch, resumeOutbox } from "@/server/outbox/outbox";

export async function killSwitchAction() {
  const ctx = await requireAccountContext();
  try {
    await killSwitch(actorFrom(ctx));
  } catch (err) {
    if (!(err instanceof ForbiddenError)) throw err;
  }
  revalidatePath("/", "layout");
}

export async function resumeOutboxAction() {
  const ctx = await requireAccountContext();
  try {
    await resumeOutbox(actorFrom(ctx));
  } catch (err) {
    if (!(err instanceof ForbiddenError)) throw err;
  }
  revalidatePath("/", "layout");
}
