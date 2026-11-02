"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { actorFrom, requireAccountContext } from "@/server/auth/session";
import type { Finding } from "@/server/checks/findings";
import {
  clearWarehouseChoice,
  RerouteBlockedError,
  requestReroute,
  setWarehouseChoice,
} from "@/server/override";

/** Server actions of "Изпрати от" / "Пренасочи" (P4-09). Every rule is enforced in src/server/override. */

export type OverrideActionResult = {
  ok?: boolean;
  error?: string;
  findings?: Finding[];
  hardCount?: number;
  softCount?: number;
  mode?: string;
};

function toError(err: unknown): OverrideActionResult {
  if (err instanceof ForbiddenError) return { error: "forbidden" };
  if (err instanceof RerouteBlockedError) return { error: err.code, findings: err.findings };
  if (err instanceof DomainError) return { error: err.code };
  if (err instanceof z.ZodError) return { error: "invalid" };
  throw err;
}

const orderPath = (id: string) => `/orders/${encodeURIComponent(id)}`;

export async function chooseWarehouseAction(input: {
  orderId: string;
  connectionId: string;
  reasonCode: string | null;
  reasonText: string | null;
}): Promise<OverrideActionResult> {
  const ctx = await requireAccountContext();
  try {
    const r = await setWarehouseChoice(actorFrom(ctx), input);
    revalidatePath(orderPath(input.orderId));
    return { ok: true, hardCount: r.hardCount, softCount: r.softCount };
  } catch (err) {
    return toError(err);
  }
}

export async function clearWarehouseAction(orderId: string): Promise<OverrideActionResult> {
  const ctx = await requireAccountContext();
  try {
    await clearWarehouseChoice(actorFrom(ctx), orderId);
    revalidatePath(orderPath(orderId));
    return { ok: true };
  } catch (err) {
    return toError(err);
  }
}

export async function rerouteAction(input: {
  orderId: string;
  toConnectionId: string;
  reasonCode: string | null;
  reasonText: string | null;
}): Promise<OverrideActionResult> {
  const ctx = await requireAccountContext();
  try {
    const r = await requestReroute(actorFrom(ctx), input);
    revalidatePath(orderPath(input.orderId));
    return { ok: true, mode: r.mode };
  } catch (err) {
    return toError(err);
  }
}
