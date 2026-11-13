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
  setShipmentCarrier,
  type BatchView,
  type CanaryView,
} from "@/server/fulfill";
import { webBoss } from "@/server/jobs/boss";
import { recheckOrderTasks } from "@/server/order-tasks";
import { confirmAbsentAndResend, requestWarehouseRecheck } from "@/server/outbox/recheck";
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

const Codes = z.array(z.string().min(1).max(200)).max(100);
const Hash = z.string().regex(/^[0-9a-f]{64}$/);

export async function retryFulfillItemAction(
  batchId: string,
  itemId: string,
  /** Codes of the warnings shown on the row when "send anyway" was clicked; [] = retry without acknowledging. */
  acknowledgedCodes: string[],
): Promise<BatchView | Fail> {
  const ctx = await requireAccountContext();
  const actor = actorFrom(ctx);
  try {
    await retryFulfillItem(actor, Id.parse(batchId), Id.parse(itemId), {
      acknowledgedCodes: Codes.parse(acknowledgedCodes),
    });
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

export async function confirmCanaryAction(
  requestId: string,
  payloadHash: string,
): Promise<{ ok: true } | Fail> {
  const ctx = await requireAccountContext();
  try {
    await confirmFulfillCanary(actorFrom(ctx), Id.parse(requestId), Hash.parse(payloadHash));
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

/** "Проверих в кабинета — няма я, изпрати": a person confirms the order is not at the warehouse; sent again. */
export async function confirmAbsentResendAction(requestId: string): Promise<{ ok: true } | Fail> {
  const ctx = await requireAccountContext();
  let r;
  try {
    r = await confirmAbsentAndResend(actorFrom(ctx), { requestId });
  } catch (err) {
    return toError(err);
  }
  try {
    const boss = await webBoss();
    await boss.send(
      QUEUES.outboxSend.name,
      { requestId: r.requestId, accountId: r.accountId },
      { singletonKey: r.requestId },
    );
  } catch (err) {
    logger.warn(
      { requestId, err: (err as Error).message },
      "outbox send not scheduled; the sweep picks it up",
    );
  }
  if (r.orderId) revalidatePath(`/orders/${r.orderId}`);
  return { ok: true };
}

/** "Провери в склада": an interrupted create-order is looked up at the warehouse by the worker. */
export async function warehouseRecheckAction(requestId: string): Promise<{ ok: true } | Fail> {
  const ctx = await requireAccountContext();
  let job;
  try {
    job = await requestWarehouseRecheck(actorFrom(ctx), { requestId });
  } catch (err) {
    return toError(err);
  }
  try {
    const boss = await webBoss();
    await boss.send(QUEUES.outboxRecheck.name, {
      requestId: job.requestId,
      accountId: job.accountId,
      userId: job.userId,
    });
  } catch (err) {
    // The mark stays; after 10 minutes the button can be pressed again.
    logger.warn({ requestId, err: (err as Error).message }, "warehouse recheck not scheduled");
    return { error: "recheck_not_scheduled" };
  }
  if (job.orderId) revalidatePath(`/orders/${job.orderId}`);
  return { ok: true };
}

/** "Изберете куриер за Shopify": the Shopify tracking company of a shipment held for an unknown carrier. */
export async function setShipmentCarrierAction(input: {
  orderId: string;
  fulfillmentId: string;
  company: string;
  custom?: boolean;
  urlTemplate?: string | null;
}): Promise<{ ok: true; released: number } | Fail> {
  const ctx = await requireAccountContext();
  try {
    const orderId = Id.parse(input.orderId);
    const r = await setShipmentCarrier(actorFrom(ctx), {
      orderId,
      fulfillmentId: input.fulfillmentId,
      company: input.company,
      custom: input.custom === true,
      urlTemplate: input.urlTemplate ?? null,
    });
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, released: r.released };
  } catch (err) {
    return toError(err);
  }
}

/** "Провери задачите": the order's open tasks are checked again; those whose cause is gone are closed. */
export async function recheckOrderTasksAction(
  orderId: string,
): Promise<{ closed: number; kept: { title: string; why: string | null }[] } | Fail> {
  const ctx = await requireAccountContext();
  try {
    const r = await recheckOrderTasks(actorFrom(ctx), { orderId });
    revalidatePath(`/orders/${orderId}`);
    return { closed: r.closed.length, kept: r.kept.map((k) => ({ title: k.title, why: k.why })) };
  } catch (err) {
    return toError(err);
  }
}
