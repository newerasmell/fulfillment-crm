"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { assertCan, ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import {
  addWarehouseReply,
  markCustomerEmailed,
  markWarehouseEmailSent,
  syncWarehouseCases,
  type CustomerSentInput,
  type ReplyInput,
  type SentInput,
} from "@/server/warehouse-cases/cases";
import { saveEscalationSettings, type EscalationInput } from "@/server/warehouse-cases/settings";
import { unlockSku, type UnlockSkuInput } from "@/server/warehouse-cases/sku";

export type CaseActionResult = { ok: true; unlocked?: number } | { error: string };

function toError(err: unknown): { error: string } {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

const PATH = "/orders/stuck";

async function run(fn: (actor: ReturnType<typeof actorFrom>) => Promise<unknown>): Promise<CaseActionResult> {
  const ctx = await requireAccountContext();
  try {
    const r = await fn(actorFrom(ctx));
    revalidatePath(PATH);
    return {
      ok: true,
      ...(r && typeof r === "object" && "unlocked" in r ? { unlocked: Number(r.unlocked) } : {}),
    };
  } catch (err) {
    return toError(err);
  }
}

export async function refreshCasesAction(): Promise<CaseActionResult> {
  return run(async (actor) => {
    assertCan(actor.role, "orders.review");
    return syncWarehouseCases(actor.accountId);
  });
}

export async function markWarehouseEmailSentAction(input: z.input<typeof SentInput>) {
  return run((actor) => markWarehouseEmailSent(actor, input));
}

export async function addWarehouseReplyAction(input: z.input<typeof ReplyInput>) {
  return run((actor) => addWarehouseReply(actor, input));
}

export async function markCustomerEmailedAction(input: z.input<typeof CustomerSentInput>) {
  return run((actor) => markCustomerEmailed(actor, input));
}

export async function unlockSkuAction(input: z.input<typeof UnlockSkuInput>) {
  return run((actor) => unlockSku(actor, input));
}

export async function saveEscalationSettingsAction(input: z.input<typeof EscalationInput>) {
  const r = await run((actor) => saveEscalationSettings(actor, input));
  revalidatePath("/settings/warehouse-emails");
  return r;
}
