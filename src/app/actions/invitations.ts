"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { requireUser } from "@/server/auth/session";
import { acceptInvitation, completeEnrolment } from "@/server/invitations";

export async function enrolAction(token: string, _prev: { error?: string } | undefined, form: FormData) {
  try {
    await completeEnrolment(token, {
      name: String(form.get("name") ?? ""),
      password: String(form.get("password") ?? ""),
      passwordRepeat: String(form.get("passwordRepeat") ?? ""),
      code: String(form.get("code") ?? ""),
    });
  } catch (err) {
    if (err instanceof DomainError) return { error: err.code };
    if (err instanceof z.ZodError) {
      return {
        error: err.issues.some((i) => i.message === "password_mismatch") ? "password_mismatch" : "invalid",
      };
    }
    throw err;
  }
  redirect("/login?joined=1");
}

export async function acceptAction(token: string) {
  const user = await requireUser();
  try {
    await acceptInvitation(token, user.id);
  } catch (err) {
    if (err instanceof DomainError) redirect(`/invite/${encodeURIComponent(token)}`);
    throw err;
  }
  redirect("/");
}
