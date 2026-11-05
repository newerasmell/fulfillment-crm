import { z } from "zod";
import { SERVICE_NAMES } from "@/integrations/eushipments/schemas";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import { countryCouriers } from "./write";

/**
 * "Куриер по подразбиране" per destination country of one euShipments connection (owner request 2026-11-05).
 * When the account has several couriers for a country, create-order must name one (courierId) — the pre-flight
 * (write.ts courierFor) uses this default and blocks the order while none is chosen.
 */

export const CountryCourierInput = z.object({
  connectionId: z.string().min(1).max(64),
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((v) => v.toUpperCase()),
  /** null / empty clears the default. */
  courierId: z.coerce.number().int().positive().nullable(),
  serviceName: z
    .enum(SERVICE_NAMES)
    .nullish()
    .transform((v) => v ?? null),
});

async function scopedConnection(actor: ScopedActor, connectionId: string) {
  const c = await accountDb(actor.accountId).fulfillmentConnection.findFirst({
    where: { id: connectionId, type: "EUSHIPMENTS" },
    select: { id: true, companyId: true },
  });
  if (!c || (actor.companyScope && !actor.companyScope.includes(c.companyId ?? "")))
    throw new DomainError("not_found");
  return c;
}

/**
 * Countries the connection's couriers serve (ISO via the countries mirror) with their couriers and the default.
 * The caller (the connection page) has already scoped the connection to the member.
 */
export async function countryCourierBoard(accountId: string, connectionId: string) {
  const db = accountDb(accountId);
  const [couriers, countries, presets] = await Promise.all([
    db.eushipmentsCourier.findMany({ where: { connectionId }, orderBy: { name: "asc" } }),
    db.eushipmentsCountry.findMany({
      where: { connectionId },
      select: { name: true, cyrillicName: true, isoCode: true },
    }),
    db.eushipmentsCountryCourier.findMany({ where: { connectionId } }),
  ]);
  const isoOf = new Map<string, string>();
  for (const c of countries)
    for (const n of [c.name, c.cyrillicName])
      if (n && c.isoCode) isoOf.set(n.trim().toLowerCase(), c.isoCode.toUpperCase());
  const byIso = new Map<string, { iso: string; name: string; couriers: typeof couriers }>();
  for (const c of couriers) {
    const iso = c.country ? isoOf.get(c.country.trim().toLowerCase()) : undefined;
    if (!iso) continue;
    const e = byIso.get(iso) ?? { iso, name: c.country!, couriers: [] };
    e.couriers.push(c);
    byIso.set(iso, e);
  }
  for (const p of presets)
    if (!byIso.has(p.country)) byIso.set(p.country, { iso: p.country, name: p.country, couriers: [] });
  const presetOf = new Map(presets.map((p) => [p.country, p]));
  return [...byIso.values()]
    .sort((a, b) => b.couriers.length - a.couriers.length || a.name.localeCompare(b.name))
    .map((e) => ({
      ...e,
      courierId: presetOf.get(e.iso)?.courierId ?? null,
      serviceName: presetOf.get(e.iso)?.serviceName ?? null,
      /** Several couriers and no default: orders to this country are blocked before sending. */
      needsChoice: e.couriers.length > 1 && !presetOf.has(e.iso),
    }));
}

export async function setCountryCourier(actor: ScopedActor, raw: z.input<typeof CountryCourierInput>) {
  assertCan(actor.role, "connections.manage");
  const input = CountryCourierInput.parse(raw);
  await scopedConnection(actor, input.connectionId);
  const db = accountDb(actor.accountId);
  const where = {
    accountId_connectionId_country: {
      accountId: actor.accountId,
      connectionId: input.connectionId,
      country: input.country,
    },
  };
  const before = await db.eushipmentsCountryCourier.findUnique({ where });
  if (input.courierId === null) {
    if (before) await db.eushipmentsCountryCourier.delete({ where });
  } else {
    const known = await db.eushipmentsCourier.findFirst({
      where: { connectionId: input.connectionId, courierId: input.courierId },
      select: { id: true },
    });
    if (!known) throw new DomainError("courier_unknown");
    // Only a courier that serves this country (when the mirror can tell).
    const serving = await countryCouriers(actor.accountId, input.connectionId, input.country);
    if (serving.length && !serving.some((c) => c.courierId === input.courierId))
      throw new DomainError("courier_wrong_country");
    await db.eushipmentsCountryCourier.upsert({
      where,
      create: {
        accountId: actor.accountId,
        connectionId: input.connectionId,
        country: input.country,
        courierId: input.courierId,
        serviceName: input.serviceName,
        updatedById: actor.userId,
      },
      update: { courierId: input.courierId, serviceName: input.serviceName, updatedById: actor.userId },
    });
  }
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "eushipments.country_courier",
    entityType: "FulfillmentConnection",
    entityId: input.connectionId,
    before: before
      ? { country: before.country, courierId: before.courierId, serviceName: before.serviceName }
      : null,
    after: { country: input.country, courierId: input.courierId, serviceName: input.serviceName },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}
