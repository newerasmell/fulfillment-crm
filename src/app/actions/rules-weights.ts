"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import { enqueueOrderCheck } from "@/server/checks/jobs";
import type { EnqueueCheck, RecheckResult } from "@/server/checks/recheck";
import { saveCountryCurrency, saveCountrySetting } from "@/server/countries/phone-rules";
import { webBoss } from "@/server/jobs/boss";
import { QUEUES } from "@/server/jobs/queues";
import {
  fillWeightsFromWarehouse,
  setProductWeight,
  type ShopifyWeightQueued,
} from "@/server/products/weights";

/**
 * Source fixes (2026-11-03): a country's phone rule and a product's weight are saved once and apply to every
 * order; the open orders they affect are re-checked (inline up to a limit, the rest in the background). No
 * Shopify or vendor call here: weight writes go to ShopifyWeightWrite and the worker's sender.
 */

export type RecheckState =
  | {
      ok?: boolean;
      error?: string;
      recheck?: RecheckResult;
      shopify?: ShopifyWeightQueued | null;
      bulk?: {
        filled: number;
        candidates: number;
        noSuggestion: number;
        conflicts: number;
        fromPreferred: number;
      };
    }
  | undefined;

function toError(err: unknown): RecheckState {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

/** Background re-checks for the orders beyond the inline limit (failure only delays them: re-check by hand). */
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

const lengthsOf = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number);

export async function saveCountryRuleAction(_prev: RecheckState, form: FormData): Promise<RecheckState> {
  const ctx = await requireAccountContext();
  try {
    const remove = form.get("remove") === "1";
    const currency = String(form.get("currency") ?? "").trim();
    const r = await saveCountrySetting(
      actorFrom(ctx),
      {
        country: String(form.get("country") ?? ""),
        ...(currency ? { currency } : {}),
        rule: remove
          ? null
          : {
              style: String(form.get("style")) === "national" ? "national" : "international",
              cc: String(form.get("cc") ?? "")
                .replace(/^\+/, "")
                .trim(),
              trunk: String(form.get("trunk") ?? "").trim(),
              lengths: lengthsOf(form.get("lengths")),
            },
      },
      { enqueue: enqueuerFor(ctx.accountId) },
    );
    revalidatePath("/settings/countries");
    revalidatePath("/orders", "layout");
    return { ok: true, recheck: r.recheck };
  } catch (err) {
    return toError(err);
  }
}

export async function saveProductWeightAction(
  productId: string,
  _prev: RecheckState,
  form: FormData,
): Promise<RecheckState> {
  const ctx = await requireAccountContext();
  try {
    const source = String(form.get("source") ?? "manual");
    const r = await setProductWeight(
      actorFrom(ctx),
      z.string().min(1).max(64).parse(productId),
      {
        grams: String(form.get("grams") ?? ""),
        source: (["manual", "eushipments", "fhb", "shopify"].includes(source)
          ? source
          : "manual") as "manual",
        writeToShopify: form.get("writeToShopify") === "on",
      },
      { enqueue: enqueuerFor(ctx.accountId) },
    );
    // LIVE writes are sent by the worker; nudge the sweep instead of waiting for its next run.
    if (r.shopify?.queued)
      try {
        const boss = await webBoss();
        await boss.send(QUEUES.shopifyWeightWrite.name, {}, { singletonKey: "shopify-weight-sweep" });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "shopify weight sweep nudge failed");
      }
    revalidatePath("/products", "layout");
    revalidatePath("/orders", "layout");
    return { ok: true, recheck: r.recheck, shopify: r.shopify };
  } catch (err) {
    return toError(err);
  }
}

export async function fillWeightsAction(_prev: RecheckState, form: FormData): Promise<RecheckState> {
  const ctx = await requireAccountContext();
  try {
    const prefer = String(form.get("preferConnectionId") ?? "").trim();
    const r = await fillWeightsFromWarehouse(actorFrom(ctx), {
      lineId: ctx.activeLineId ?? null,
      preferConnectionId: prefer ? z.string().max(64).parse(prefer) : null,
      enqueue: enqueuerFor(ctx.accountId),
    });
    revalidatePath("/products", "layout");
    revalidatePath("/orders", "layout");
    return { ok: true, recheck: r.recheck, bulk: r };
  } catch (err) {
    return toError(err);
  }
}

/** Настройки → Държави: only the local currency of one country (any row). */
export async function saveCountryCurrencyAction(_prev: RecheckState, form: FormData): Promise<RecheckState> {
  const ctx = await requireAccountContext();
  try {
    const r = await saveCountryCurrency(
      actorFrom(ctx),
      { country: String(form.get("country") ?? ""), currency: String(form.get("currency") ?? "") },
      { enqueue: enqueuerFor(ctx.accountId) },
    );
    revalidatePath("/settings/countries");
    revalidatePath("/orders", "layout");
    return { ok: true, recheck: r.recheck };
  } catch (err) {
    return toError(err);
  }
}
