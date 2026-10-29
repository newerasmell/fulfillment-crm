"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Role } from "@/generated/prisma/client";
import { changeMemberRole, createAccount, DomainError, removeMember } from "@/server/accounts";
import { inviteMember, revokeInvitation } from "@/server/invitations";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";

export interface ActionResult {
  ok?: boolean;
  error?: string;
  /** Invitation link path, shown once to the inviter. */
  invitePath?: string;
  inviteEmail?: string;
}

function toError(err: unknown): ActionResult {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

export async function createAccountAction(
  _prev: ActionResult | undefined,
  form: FormData,
): Promise<ActionResult> {
  const ctx = await requireAccountContext();
  try {
    await createAccount(actorFrom(ctx), { name: String(form.get("name") ?? "") });
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function inviteMemberAction(
  _prev: ActionResult | undefined,
  form: FormData,
): Promise<ActionResult> {
  const ctx = await requireAccountContext();
  const email = String(form.get("email") ?? "");
  try {
    const r = await inviteMember(actorFrom(ctx), {
      email,
      name: String(form.get("name") ?? ""),
      role: String(form.get("role") ?? "VIEWER") as Role,
    });
    revalidatePath("/settings/members");
    return { ok: true, invitePath: `/invite/${r.token}`, inviteEmail: email };
  } catch (err) {
    return toError(err);
  }
}

export async function revokeInvitationAction(invitationId: string) {
  const ctx = await requireAccountContext();
  try {
    await revokeInvitation(actorFrom(ctx), invitationId);
  } catch (err) {
    toError(err);
  }
  revalidatePath("/settings/members");
}

export async function changeRoleAction(
  _prev: ActionResult | undefined,
  form: FormData,
): Promise<ActionResult> {
  const ctx = await requireAccountContext();
  try {
    await changeMemberRole(
      actorFrom(ctx),
      String(form.get("membershipId")),
      String(form.get("role")) as Role,
    );
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/settings/members");
  return { ok: true };
}

export async function removeMemberAction(
  _prev: ActionResult | undefined,
  form: FormData,
): Promise<ActionResult> {
  const ctx = await requireAccountContext();
  try {
    await removeMember(actorFrom(ctx), String(form.get("membershipId")));
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/settings/members");
  return { ok: true };
}
