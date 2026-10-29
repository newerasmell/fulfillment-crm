"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Role } from "@/generated/prisma/client";
import { addMember, changeMemberRole, createAccount, DomainError, removeMember } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";

export interface ActionResult {
  ok?: boolean;
  error?: string;
  onboarding?: { email: string; password?: string; otpauthUri: string };
  existingUser?: boolean;
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

export async function addMemberAction(
  _prev: ActionResult | undefined,
  form: FormData,
): Promise<ActionResult> {
  const ctx = await requireAccountContext();
  const email = String(form.get("email") ?? "");
  try {
    const r = await addMember(actorFrom(ctx), {
      email,
      name: String(form.get("name") ?? ""),
      role: String(form.get("role") ?? "VIEWER") as Role,
    });
    revalidatePath("/settings/members");
    if (r.onboarding) {
      return {
        ok: true,
        onboarding: { email, password: r.onboarding.password, otpauthUri: r.onboarding.otpauthUri },
      };
    }
    return { ok: true, existingUser: true };
  } catch (err) {
    return toError(err);
  }
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
