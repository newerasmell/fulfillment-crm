"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { enqueueOrderCheck } from "@/server/checks/jobs";
import type { EnqueueCheck } from "@/server/checks/recheck";
import { webBoss } from "@/server/jobs/boss";
import { confirmSuspiciousLink, unlinkSuspiciousLink } from "@/server/products/suspicious-decisions";

/** "Съмнителни връзки": Потвърди (same product) / Развържи. No Shopify or vendor call here. */

export type SuspiciousState = { ok?: "confirmed" | "unlinked"; error?: string } | undefined;

function toError(err: unknown): SuspiciousState {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

function enqueuerFor(accountId: string): EnqueueCheck {
  return async (orderIds) => {
    try {
      const boss = await webBoss();
      for (const orderId of orderIds) await enqueueOrderCheck(boss, { accountId, orderId });
    } catch (err) {
      logger.warn({ count: orderIds.length, err: (err as Error).message }, "recheck enqueue failed");
    }
  };
}

function revalidate() {
  revalidatePath("/products");
  revalidatePath("/products/lines");
}

export async function confirmSuspiciousAction(id: string, _prev: SuspiciousState): Promise<SuspiciousState> {
  const ctx = await requireAccountContext();
  try {
    await confirmSuspiciousLink(actorFrom(ctx), id, { enqueue: enqueuerFor(ctx.accountId) });
  } catch (err) {
    return toError(err);
  }
  revalidate();
  return { ok: "confirmed" };
}

export async function unlinkSuspiciousAction(id: string, _prev: SuspiciousState): Promise<SuspiciousState> {
  const ctx = await requireAccountContext();
  try {
    await unlinkSuspiciousLink(actorFrom(ctx), id, { enqueue: enqueuerFor(ctx.accountId) });
  } catch (err) {
    return toError(err);
  }
  revalidate();
  return { ok: "unlinked" };
}
