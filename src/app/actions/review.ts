"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { checkOrderAs, type Finding } from "@/server/checks";
import {
  decideOrder,
  editOrderAddress,
  getOrderRawPayload,
  previewAddress,
  releaseOrder,
  saveReasonCode,
  setReasonCodeActive,
  type DecisionKind,
  type RawSection,
} from "@/server/review";

/** Server actions of the review screens (P4-04 / P4-05). Every rule is enforced in src/server/review. */

export type ReviewActionResult = { ok?: boolean; error?: string; message?: string } | undefined;

function toError(err: unknown): { error: string } {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

const orderPath = (id: string) => `/orders/${encodeURIComponent(id)}`;

export async function saveAddressAction(input: {
  orderId: string;
  version: string;
  values: Record<string, string | null>;
  via?: string;
}): Promise<ReviewActionResult & { changed?: number }> {
  const ctx = await requireAccountContext();
  try {
    const r = await editOrderAddress(actorFrom(ctx), input.orderId, {
      values: input.values,
      version: input.version,
      via: input.via,
    });
    revalidatePath(orderPath(input.orderId));
    return { ok: true, changed: r.changed.length };
  } catch (err) {
    return toError(err);
  }
}

export async function previewAddressAction(input: {
  orderId: string;
  values: Record<string, string | null>;
}): Promise<{ findings?: Finding[]; normalisedPhone?: string | null; error?: string }> {
  const ctx = await requireAccountContext();
  try {
    return await previewAddress(actorFrom(ctx), input.orderId, input.values);
  } catch (err) {
    return toError(err);
  }
}

export async function decideAction(input: {
  orderId: string;
  decision: DecisionKind;
  reasonCode: string | null;
  reasonText: string | null;
  openedAt: string | null;
}): Promise<ReviewActionResult> {
  const ctx = await requireAccountContext();
  try {
    await decideOrder(actorFrom(ctx), input);
    revalidatePath(orderPath(input.orderId));
    revalidatePath("/orders");
    return { ok: true };
  } catch (err) {
    return toError(err);
  }
}

export async function recheckAction(orderId: string): Promise<ReviewActionResult> {
  const ctx = await requireAccountContext();
  try {
    await checkOrderAs(actorFrom(ctx), orderId);
    revalidatePath(orderPath(orderId));
    return { ok: true };
  } catch (err) {
    return toError(err);
  }
}

/** Releases an operator hold: the order starts over (IMPORTED) and is checked again right away. */
export async function releaseAction(orderId: string): Promise<ReviewActionResult> {
  const ctx = await requireAccountContext();
  try {
    await releaseOrder(actorFrom(ctx), orderId);
    revalidatePath(orderPath(orderId));
    return { ok: true };
  } catch (err) {
    return toError(err);
  }
}

/** One raw payload section of the order detail, loaded when an admin opens it (never part of the page). */
export async function rawPayloadAction(
  orderId: string,
  section: RawSection,
): Promise<{ json?: string; error?: string }> {
  const ctx = await requireAccountContext();
  try {
    return { json: JSON.stringify(await getOrderRawPayload(actorFrom(ctx), orderId, section), null, 2) };
  } catch (err) {
    return toError(err);
  }
}

export async function saveReasonCodeAction(
  _prev: ReviewActionResult,
  form: FormData,
): Promise<ReviewActionResult> {
  const ctx = await requireAccountContext();
  try {
    await saveReasonCode(actorFrom(ctx), {
      code: String(form.get("code") ?? ""),
      labelBg: String(form.get("labelBg") ?? ""),
      labelEn: String(form.get("labelEn") ?? ""),
      decisions: form.getAll("decisions").map(String) as DecisionKind[],
      ...(form.get("sortOrder") ? { sortOrder: Number(form.get("sortOrder")) } : {}),
    });
    revalidatePath("/orders/reviews");
    return { ok: true };
  } catch (err) {
    return toError(err);
  }
}

export async function toggleReasonCodeAction(code: string, active: boolean): Promise<void> {
  const ctx = await requireAccountContext();
  try {
    await setReasonCodeActive(actorFrom(ctx), code, active);
  } catch (err) {
    toError(err); // known refusals (forbidden, not_found, "other" must stay on) leave the list unchanged
  }
  revalidatePath("/orders/reviews");
}
