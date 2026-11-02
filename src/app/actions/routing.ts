"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import {
  createRoutingRule,
  deleteRoutingRule,
  moveRoutingRule,
  productIdsForSkus,
  updateRoutingRule,
  type RoutingRuleInput,
} from "@/server/routing";

export type RoutingResult = { ok?: boolean; error?: string } | undefined;

function toError(err: unknown): RoutingResult {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

const list = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split(/[,\n;]/)
    .map((s) => s.trim().replace(/^#/, ""))
    .filter(Boolean);

async function inputFrom(form: FormData, actor: ReturnType<typeof actorFrom>): Promise<RoutingRuleInput> {
  const payment = String(form.get("payment") ?? "");
  return {
    name: String(form.get("name") ?? ""),
    connectionId: String(form.get("connectionId") ?? ""),
    enabled: form.get("enabled") === "on",
    match: {
      storeIds: form.getAll("storeIds").map(String).filter(Boolean),
      countries: list(form.get("countries")),
      ...(payment === "COD" || payment === "PREPAID" ? { payment } : {}),
      tags: list(form.get("tags")),
      excludeTags: list(form.get("excludeTags")),
      productIds: await productIdsForSkus(actor, list(form.get("skus"))),
      requireStock: form.get("requireStock") === "on",
    },
    parcelService: String(form.get("parcelService") ?? ""),
    courierId: String(form.get("courierId") ?? ""),
    serviceName: String(form.get("serviceName") ?? ""),
    deliveryPointPolicy: String(form.get("deliveryPointPolicy") ?? ""),
  };
}

export async function saveRoutingRuleAction(_prev: RoutingResult, form: FormData): Promise<RoutingResult> {
  const ctx = await requireAccountContext();
  const actor = actorFrom(ctx);
  try {
    const input = await inputFrom(form, actor);
    const id = String(form.get("ruleId") ?? "");
    if (id) await updateRoutingRule(actor, id, input);
    else await createRoutingRule(actor, input);
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/routing");
  return { ok: true };
}

export async function moveRoutingRuleAction(form: FormData) {
  const ctx = await requireAccountContext();
  try {
    await moveRoutingRule(
      actorFrom(ctx),
      String(form.get("ruleId") ?? ""),
      form.get("direction") === "down" ? "down" : "up",
    );
  } catch (err) {
    toError(err);
  }
  revalidatePath("/routing");
}

export async function deleteRoutingRuleAction(ruleId: string) {
  const ctx = await requireAccountContext();
  try {
    await deleteRoutingRule(actorFrom(ctx), ruleId);
  } catch (err) {
    toError(err);
  }
  revalidatePath("/routing");
}
