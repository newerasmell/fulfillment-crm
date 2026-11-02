"use server";

import { revalidatePath } from "next/cache";
import { recordAudit } from "@/server/audit";
import { can } from "@/server/auth/rbac";
import { requireAccountContext } from "@/server/auth/session";
import { webBoss } from "@/server/jobs/boss";
import { redriveDeadLetter } from "@/server/jobs/dead-letters";

export async function redriveAction(jobId: string) {
  const ctx = await requireAccountContext();
  if (!can(ctx.role, "jobs.admin")) return;
  if (await redriveDeadLetter(await webBoss(), ctx.accountId, jobId)) {
    await recordAudit({
      accountId: ctx.accountId,
      userId: ctx.user.id,
      action: "jobs.redrive",
      entityType: "Job",
      entityId: jobId,
    });
  }
  revalidatePath("/settings/jobs");
}
