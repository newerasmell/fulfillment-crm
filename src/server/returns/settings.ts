import { z } from "zod";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import type { Actor } from "@/server/accounts";
import { accountDb } from "@/server/db/client";

/** Returns + COD settings of a group (P6-01/P6-02). No row = these defaults. */
export const RETURNS_COD_DEFAULTS = { returnOverdueDays: 14, codMissingDays: 14, notifySupport: true };
export type ReturnsCodSettingsValue = typeof RETURNS_COD_DEFAULTS;

export async function getReturnsCodSettings(accountId: string): Promise<ReturnsCodSettingsValue> {
  const row = await accountDb(accountId).returnsCodSettings.findUnique({ where: { accountId } });
  return row
    ? {
        returnOverdueDays: row.returnOverdueDays,
        codMissingDays: row.codMissingDays,
        notifySupport: row.notifySupport,
      }
    : { ...RETURNS_COD_DEFAULTS };
}

export const ReturnsCodSettingsInput = z.object({
  returnOverdueDays: z.coerce.number().int().min(1).max(120),
  codMissingDays: z.coerce.number().int().min(1).max(180),
  notifySupport: z.boolean(),
});

export async function updateReturnsCodSettings(actor: Actor, raw: z.input<typeof ReturnsCodSettingsInput>) {
  assertCan(actor.role, "account.settings");
  const input = ReturnsCodSettingsInput.parse(raw);
  const before = await getReturnsCodSettings(actor.accountId);
  await accountDb(actor.accountId).returnsCodSettings.upsert({
    where: { accountId: actor.accountId },
    create: { accountId: actor.accountId, ...input },
    update: input,
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "returns_cod.settings",
    entityType: "ReturnsCodSettings",
    entityId: actor.accountId,
    before,
    after: input,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return input;
}
