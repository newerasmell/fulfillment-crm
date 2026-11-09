"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { createProductFromVariant, linkVariant } from "@/server/shopify/products";
import { queueProductsToWarehouse, type QueueToWarehouseResult } from "@/server/products/to-warehouse";

type Result = { ok?: boolean; error?: string } | undefined;

function toError(err: unknown): Result {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

export async function linkVariantAction(linkId: string, _prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await linkVariant(actorFrom(ctx), linkId, z.string().trim().min(1).max(100).parse(form.get("sku")));
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/products");
  return { ok: true };
}

export async function createProductFromVariantAction(
  linkId: string,
  _prev: Result,
  _form: FormData,
): Promise<Result> {
  const ctx = await requireAccountContext();
  try {
    await createProductFromVariant(actorFrom(ctx), linkId);
  } catch (err) {
    return toError(err);
  }
  revalidatePath("/products");
  return { ok: true };
}

/** "Създаване в склада": queue the create of the chosen masters at one warehouse (outbox + live mode). */
export async function queueToWarehouseAction(input: {
  connectionId: string;
  productIds: string[];
}): Promise<(QueueToWarehouseResult & { ok: true }) | { error: string }> {
  const ctx = await requireAccountContext();
  try {
    const r = await queueProductsToWarehouse(actorFrom(ctx), input);
    revalidatePath("/products/to-warehouse");
    return { ok: true, ...r };
  } catch (err) {
    return (toError(err) as { error: string }) ?? { error: "unexpected" };
  }
}
