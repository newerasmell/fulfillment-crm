"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import type { Finding } from "@/server/checks/findings";
import { webBoss } from "@/server/jobs/boss";
import { QUEUES } from "@/server/jobs/queues";
import {
  createJoyConnection,
  createManualShipment,
  euOffices,
  labelPrintJobs,
  ManualPreflightError,
  previewManualShipment,
  quoteResult,
  requestBulkLabels,
  requestJoyTest,
  requestLabelRefetch,
  requestQuote,
  resendLabel,
  rotateJoyCredentials,
  updateJoySettings,
  voidLabel,
  type CreateManualResult,
  type ManualPreview,
  type ManualShipmentInput,
} from "@/server/labels";
import { enqueueLabelRead, type LabelReadJob } from "@/server/labels/jobs";
import { setConnectionMode } from "@/server/outbox/outbox";

/**
 * Ръчни пратки и етикети (P7). These actions only write CRM rows (orders, shipments, outbox requests, read jobs);
 * the worker is what talks to FHB Joy / euShipments — writes through the outbox under the connection's liveMode.
 */

type Fail = { error: string; findings?: Finding[] };
const plain = <T>(v: T) => JSON.parse(JSON.stringify(v)) as T;
const Id = z.string().min(1).max(64);

function toError(err: unknown): Fail {
  if (err instanceof ManualPreflightError) return { error: err.code, findings: plain(err.findings) };
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

/** Hands a new outbox request to the sender now (the minute sweep would pick it up anyway). */
async function kick(requestId: string | null, accountId: string) {
  if (!requestId) return;
  try {
    const boss = await webBoss();
    await boss.send(QUEUES.outboxSend.name, { requestId, accountId }, { singletonKey: requestId });
  } catch (err) {
    logger.warn(
      { requestId, err: (err as Error).message },
      "outbox send not scheduled; the sweep picks it up",
    );
  }
}

async function read(d: LabelReadJob) {
  try {
    await enqueueLabelRead(await webBoss(), d);
  } catch (err) {
    logger.warn({ kind: d.kind, err: (err as Error).message }, "label read job not queued");
    throw new DomainError("queue_unavailable");
  }
}

export async function previewManualAction(input: ManualShipmentInput): Promise<ManualPreview | Fail> {
  const ctx = await requireAccountContext();
  try {
    return plain(await previewManualShipment(actorFrom(ctx), input));
  } catch (err) {
    return toError(err);
  }
}

export async function createManualAction(input: ManualShipmentInput): Promise<CreateManualResult | Fail> {
  const ctx = await requireAccountContext();
  try {
    const r = await createManualShipment(actorFrom(ctx), input);
    await kick(r.requestId, ctx.accountId);
    revalidatePath("/manual-shipments");
    return plain(r);
  } catch (err) {
    return toError(err);
  }
}

export async function resendLabelAction(
  id: string,
  acknowledgedCodes: string[] = [],
): Promise<{ ok: true } | Fail> {
  const ctx = await requireAccountContext();
  try {
    const r = await resendLabel(
      actorFrom(ctx),
      Id.parse(id),
      z.array(z.string().max(200)).max(100).parse(acknowledgedCodes),
    );
    await kick(r.request.id, ctx.accountId);
  } catch (err) {
    return toError(err);
  }
  revalidatePath(`/manual-shipments/${id}`);
  return { ok: true };
}

export async function voidLabelAction(id: string): Promise<{ ok: true } | Fail> {
  const ctx = await requireAccountContext();
  try {
    const r = await voidLabel(actorFrom(ctx), Id.parse(id));
    await kick(r.request.id, ctx.accountId);
  } catch (err) {
    return toError(err);
  }
  revalidatePath(`/manual-shipments/${id}`);
  return { ok: true };
}

export async function bulkLabelsAction(
  fulfillmentIds: string[],
): Promise<{ jobIds: string[]; skipped: number } | Fail> {
  const ctx = await requireAccountContext();
  try {
    const r = await requestBulkLabels(actorFrom(ctx), fulfillmentIds);
    for (const j of r.jobs) await read({ accountId: ctx.accountId, kind: "bulk", id: j.id });
    return { jobIds: r.jobs.map((j) => j.id), skipped: r.skipped };
  } catch (err) {
    return toError(err);
  }
}

export async function bulkStatusAction(jobIds: string[]) {
  const ctx = await requireAccountContext();
  return plain(await labelPrintJobs(actorFrom(ctx), z.array(Id).max(50).parse(jobIds)));
}

export async function refetchLabelAction(
  fulfillmentId: string,
  manualId: string,
): Promise<{ ok: true } | Fail> {
  const ctx = await requireAccountContext();
  try {
    const r = await requestLabelRefetch(actorFrom(ctx), Id.parse(fulfillmentId));
    await read({ accountId: r.accountId, kind: "fetch", id: r.fulfillmentId });
  } catch (err) {
    return toError(err);
  }
  revalidatePath(`/manual-shipments/${manualId}`);
  return { ok: true };
}

export async function quoteAction(input: {
  connectionId: string;
  courierId: number;
  weight: number;
  codAmount?: number;
  toOffice?: boolean;
  currency?: string;
}): Promise<{ quoteId: string } | Fail> {
  const ctx = await requireAccountContext();
  try {
    const q = await requestQuote(actorFrom(ctx), input);
    await read({ accountId: ctx.accountId, kind: "quote", id: q.id });
    return { quoteId: q.id };
  } catch (err) {
    return toError(err);
  }
}

export async function quoteStatusAction(quoteId: string) {
  const ctx = await requireAccountContext();
  try {
    return { quote: plain(await quoteResult(actorFrom(ctx), Id.parse(quoteId))) };
  } catch (err) {
    return toError(err);
  }
}

export async function officesAction(connectionId: string, courierId: number, q: string) {
  const ctx = await requireAccountContext();
  const offices = await euOffices(
    actorFrom(ctx),
    Id.parse(connectionId),
    z.number().int().positive().parse(courierId),
    z.string().max(60).parse(q),
  ).catch((err: unknown) => {
    // A connection outside the actor's scope / permission is simply "no offices" for the search box.
    if (err instanceof DomainError || err instanceof ForbiddenError) return [];
    throw err;
  });
  return plain(offices);
}

// ───────────────────────── FHB Joy connections ─────────────────────────

type Result = { ok?: boolean; error?: string } | undefined;
const codes = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

export async function createJoyConnectionAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await createJoyConnection(actorFrom(ctx), {
      companyId: String(form.get("companyId") ?? ""),
      name: String(form.get("name") ?? ""),
      appId: String(form.get("appId") ?? ""),
      secret: String(form.get("secret") ?? ""),
      settings: {
        parcelServices: codes(form.get("parcelServices")),
        pickupServices: codes(form.get("pickupServices")),
        sender: String(form.get("sender") ?? "") || null,
        senderName: String(form.get("senderName") ?? "") || null,
      },
    });
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/manual-shipments", "layout");
  return { ok: true };
}

export async function saveJoySettingsAction(
  connectionId: string,
  _prev: Result,
  form: FormData,
): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await updateJoySettings(actorFrom(ctx), Id.parse(connectionId), {
      parcelServices: codes(form.get("parcelServices")),
      pickupServices: codes(form.get("pickupServices")),
      sender: String(form.get("sender") ?? "") || null,
      senderName: String(form.get("senderName") ?? "") || null,
    });
    const appId = String(form.get("appId") ?? "").trim();
    const secret = String(form.get("secret") ?? "").trim();
    if (appId && secret) await rotateJoyCredentials(actorFrom(ctx), connectionId, { appId, secret });
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/manual-shipments", "layout");
  return { ok: true };
}

const Mode = z.enum(["READ_ONLY", "DRY_RUN", "CANARY", "LIVE"]);

/** Raising is OWNER-only and audited (setConnectionMode); lowering is allowed to admins. */
export async function setJoyModeAction(connectionId: string, _prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await setConnectionMode(actorFrom(ctx), Id.parse(connectionId), Mode.parse(form.get("mode")));
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function testJoyAction(connectionId: string): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    const r = await requestJoyTest(actorFrom(ctx), Id.parse(connectionId));
    await read({ accountId: r.accountId, kind: "joyTest", id: r.connectionId });
  } catch (err) {
    return toError(err);
  }
  return { ok: true };
}
