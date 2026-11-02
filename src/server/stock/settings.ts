import { z } from "zod";
import type { Actor } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb } from "@/server/db/client";

/** Stock board thresholds of a group (P5-01). Defaults apply until an admin saves them. */
export const StockSettingsInput = z.object({
  shopifyThreshold: z.coerce.number().int().min(0).max(10_000),
  fhbStaleHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 14),
  euStaleHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 14),
  runOutDays: z.coerce.number().int().min(1).max(90),
});
export type StockSettingsValues = z.output<typeof StockSettingsInput>;

export const DEFAULT_STOCK_SETTINGS: StockSettingsValues = {
  shopifyThreshold: 2,
  fhbStaleHours: 2,
  euStaleHours: 30,
  runOutDays: 7,
};

export async function getStockSettings(accountId: string): Promise<StockSettingsValues> {
  const row = await accountDb(accountId).stockSettings.findUnique({ where: { accountId } });
  if (!row) return DEFAULT_STOCK_SETTINGS;
  return {
    shopifyThreshold: row.shopifyThreshold,
    fhbStaleHours: row.fhbStaleHours,
    euStaleHours: row.euStaleHours,
    runOutDays: row.runOutDays,
  };
}

/** Stale threshold of one connection type (FHB is pushed + reconciled, euShipments is a daily snapshot). */
export const staleHoursFor = (s: StockSettingsValues, type: string) =>
  type === "EUSHIPMENTS" ? s.euStaleHours : s.fhbStaleHours;

export async function updateStockSettings(actor: Actor, raw: z.input<typeof StockSettingsInput>) {
  assertCan(actor.role, "stock.settings");
  const input = StockSettingsInput.parse(raw);
  const before = await getStockSettings(actor.accountId);
  await accountDb(actor.accountId).stockSettings.upsert({
    where: { accountId: actor.accountId },
    create: { accountId: actor.accountId, ...input },
    update: input,
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "stock.settings",
    entityType: "StockSettings",
    entityId: actor.accountId,
    before,
    after: input,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return input;
}
