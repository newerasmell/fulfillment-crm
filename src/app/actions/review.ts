"use server";

import { decideStockWait } from "@/server/stock/waiting";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { checkOrderAs, type Finding } from "@/server/checks";
import { markOrderGatewayCod } from "@/server/shopify/payment";
import {
  clearOrderCod,
  setOrderCod,
  chooseLineProduct,
  clearLineProduct,
  searchLineProducts,
  decideOrder,
  editOrderAddress,
  getOrderRawPayload,
  previewAddress,
  releaseOrder,
  restartOrder,
  approveQtyHold,
  rejectQtyHold,
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

/** "Изпрати отново" for an order the warehouse blocked or cancelled: starts over and is checked again. */
export async function restartAction(orderId: string): Promise<ReviewActionResult> {
  const ctx = await requireAccountContext();
  try {
    await restartOrder(actorFrom(ctx), orderId);
    revalidatePath(orderPath(orderId));
    return { ok: true };
  } catch (err) {
    return toError(err);
  }
}

/** "Избери продукт за реда": a hand-picked product for one order line (this order only). */
export async function chooseLineProductAction(input: {
  orderId: string;
  lineId: string;
  productId: string;
  note?: string | null;
}): Promise<ReviewActionResult> {
  const ctx = await requireAccountContext();
  try {
    await chooseLineProduct(actorFrom(ctx), input);
    revalidatePath(orderPath(input.orderId));
    revalidatePath("/orders");
    return { ok: true };
  } catch (err) {
    return toError(err);
  }
}

export async function clearLineProductAction(input: {
  orderId: string;
  lineId: string;
}): Promise<ReviewActionResult> {
  const ctx = await requireAccountContext();
  try {
    await clearLineProduct(actorFrom(ctx), input);
    revalidatePath(orderPath(input.orderId));
    revalidatePath("/orders");
    return { ok: true };
  } catch (err) {
    return toError(err);
  }
}

export async function searchLineProductsAction(
  orderId: string,
  q: string,
): Promise<Awaited<ReturnType<typeof searchLineProducts>> | { error: string }> {
  const ctx = await requireAccountContext();
  try {
    return await searchLineProducts(actorFrom(ctx), orderId, String(q ?? ""));
  } catch (err) {
    return toError(err);
  }
}

/** "Този метод е наложен платеж": the order's payment gateways join its store's COD list; open orders re-classified. */
export async function markGatewaysCodAction(
  orderId: string,
  gateway: string,
): Promise<ReviewActionResult & { added?: boolean; changed?: number }> {
  const ctx = await requireAccountContext();
  try {
    const r = await markOrderGatewayCod(actorFrom(ctx), orderId, gateway);
    revalidatePath(orderPath(orderId));
    revalidatePath("/orders");
    return { ok: true, added: r.added, changed: r.changed };
  } catch (err) {
    return toError(err);
  }
}

/** "Промени наложения платеж": a person's COD for this order (0 = prepaid). */
export async function setOrderCodAction(input: {
  orderId: string;
  amount: string;
  note?: string | null;
}): Promise<ReviewActionResult> {
  const ctx = await requireAccountContext();
  try {
    await setOrderCod(actorFrom(ctx), input);
    revalidatePath(orderPath(input.orderId));
    revalidatePath("/orders");
    return { ok: true };
  } catch (err) {
    return toError(err);
  }
}

export async function clearOrderCodAction(orderId: string): Promise<ReviewActionResult> {
  const ctx = await requireAccountContext();
  try {
    await clearOrderCod(actorFrom(ctx), orderId);
    revalidatePath(orderPath(orderId));
    revalidatePath("/orders");
    return { ok: true };
  } catch (err) {
    return toError(err);
  }
}

/** Противосаботаж: approve (the units are reserved from now on) or cancel an order held for its quantity. */
export async function decideQtyHoldAction(input: {
  orderId: string;
  decision: "approve" | "reject";
  reason?: string;
}): Promise<{ ok: true; status: string } | { error: string }> {
  const ctx = await requireAccountContext();
  try {
    // Parsed here: an unknown decision must never fall through to "cancel the order".
    const d = z
      .object({
        orderId: z.string().min(1).max(64),
        decision: z.enum(["approve", "reject"]),
        reason: z.string().max(300).optional(),
      })
      .parse(input);
    const actor = actorFrom(ctx);
    const r =
      d.decision === "approve"
        ? await approveQtyHold(actor, d.orderId, d.reason)
        : await rejectQtyHold(actor, d.orderId, d.reason);
    revalidatePath(orderPath(d.orderId));
    revalidatePath("/orders");
    return { ok: true, status: r.status };
  } catch (err) {
    return toError(err);
  }
}

/** "Липсващи артикули": "Чака зареждане" / "Потвърди" for one or many orders (tags change in Shopify via the outbox). */
export async function decideStockWaitAction(input: {
  action: "waiting" | "confirm";
  orderIds: string[];
}): Promise<{ ok: true; queued: number; skipped: number } | { error: string }> {
  const ctx = await requireAccountContext();
  try {
    const r = await decideStockWait(actorFrom(ctx), input);
    revalidatePath("/orders/missing-stock");
    return { ok: true, ...r };
  } catch (err) {
    return toError(err);
  }
}
