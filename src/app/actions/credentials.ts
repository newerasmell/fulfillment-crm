"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { recordAudit } from "@/server/audit";
import { ForbiddenError, assertCan } from "@/server/auth/rbac";
import { requireAccountContext } from "@/server/auth/session";
import { accountDb } from "@/server/db/client";
import { saveCredential } from "@/server/security/credentials";

const Input = z.object({
  label: z.string().trim().min(1).max(120),
  secret: z.string().min(1).max(20_000),
  credentialId: z.string().optional(),
});

/** Write-only: the response carries only the hint, never the secret. */
export async function saveCredentialAction(
  _prev: { ok?: boolean; hint?: string; error?: string } | undefined,
  form: FormData,
) {
  const ctx = await requireAccountContext();
  try {
    assertCan(ctx.role, "credentials.write");
    const input = Input.parse({
      label: form.get("label"),
      secret: form.get("secret"),
      credentialId: form.get("credentialId") || undefined,
    });
    const view = await saveCredential(accountDb(ctx.accountId), ctx.accountId, {
      ...input,
      userId: ctx.user.id,
    });
    await recordAudit({
      accountId: ctx.accountId,
      userId: ctx.user.id,
      action: input.credentialId ? "credential.rotate" : "credential.create",
      entityType: "Credential",
      entityId: view.id,
      after: { label: view.label, hint: view.hint },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    revalidatePath("/settings/credentials");
    return { ok: true, hint: view.hint };
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: "forbidden" };
    if (err instanceof z.ZodError) return { error: "invalid" };
    throw err;
  }
}
