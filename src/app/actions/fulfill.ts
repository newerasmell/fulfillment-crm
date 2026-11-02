"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import {
  canaryView,
  confirmFulfillCanary,
  createFulfillBatch,
  getFulfillBatch,
  retryFulfillItem,
  runFulfillBatch,
  type BatchView,
  type CanaryView,
} from "@/server/fulfill";
import { webBoss } from "@/server/jobs/boss";
import { QUEUES } from "@/server/jobs/queues";

/**
 * Fulfill actions (P4-06). They only create batch rows and outbox requests; the worker's outbox sender is what
 * talks to a warehouse, under the connection's liveMode.
 */

type Fail = { error: string };

function toError(err: unknown): Fail {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

const Ids = z.array(z.string().min(1).max(64)).min(1).max(200);
const Id = z.string().min(1).max(64);

/** Plain JSON for the client component (Dates as ISO strings). */
const plain = <T>(v: T) => JSON.parse(JSON.stringify(v)) as T;

export async function startFulfillAction(orderIds: string[]): Promise<{ batchId: string } | Fail> {
  const ctx = await requireAccountContext();
  try {
    const batch = await createFulfillBatch(actorFrom(ctx), Ids.parse(orderIds));
    return { batchId: batch.id };
  } catch (err) {
    return toError(err);
  }
}

export async function runFulfillStepAction(batchId: string): Promise<BatchView | Fail> {
  const ctx = await requireAccountContext();
  const actor = actorFrom(ctx);
  try {
    await runFulfillBatch(actor, Id.parse(batchId), 3);
    const view = await getFulfillBatch(actor, batchId);
    revalidatePath("/orders");
    return plain(view);
  } catch (err) {
    return toError(err);
  }
}

export async function retryFulfillItemAction(
  batchId: string,
  itemId: string,
  acknowledge: boolean,
): Promise<BatchView | Fail> {
  const ctx = await requireAccountContext();
  const actor = actorFrom(ctx);
  try {
    await retryFulfillItem(actor, Id.parse(itemId), { acknowledge: acknowledge === true });
    return plain(await getFulfillBatch(actor, Id.parse(batchId)));
  } catch (err) {
    return toError(err);
  }
}

export async function canaryViewAction(requestId: string): Promise<CanaryView | Fail> {
  const ctx = await requireAccountContext();
  try {
    return plain(await canaryView(actorFrom(ctx), Id.parse(requestId)));
  } catch (err) {
    return toError(err);
  }
}

export async function confirmCanaryAction(requestId: string): Promise<{ ok: true } | Fail> {
  const ctx = await requireAccountContext();
  try {
    await confirmFulfillCanary(actorFrom(ctx), Id.parse(requestId));
  } catch (err) {
    return toError(err);
  }
  // Hand it to the sender now instead of waiting for the minute sweep (the sender re-checks mode and cap).
  try {
    const boss = await webBoss();
    await boss.send(
      QUEUES.outboxSend.name,
      { requestId, accountId: ctx.accountId },
      { singletonKey: requestId },
    );
  } catch (err) {
    logger.warn(
      { requestId, err: (err as Error).message },
      "outbox send not scheduled; the sweep picks it up",
    );
  }
  return { ok: true };
}
