"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { can } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { resolveApiAlert } from "@/server/api-watcher/view";

const AlertId = z.string().min(1).max(64);

export async function resolveApiAlertAction(alertId: string) {
  const ctx = await requireAccountContext();
  if (!can(ctx.role, "apiWatch.read")) return;
  await resolveApiAlert(actorFrom(ctx), AlertId.parse(alertId));
  revalidatePath("/settings/api-changes");
}
