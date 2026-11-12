import { z } from "zod";
import { logger } from "@/lib/logger";
import { matchSpeedyOffice, parseSpeedyOffice } from "@/integrations/eushipments/speedy-office";
import { Prisma, type Role } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction } from "@/server/db/client";

/**
 * Delivery to a Speedy office for orders to Bulgaria (owner request 2026-11-11). The order's choice
 * (`Order.deliveryOffice`) wins; without one, an address line "Office Speedy [id] NAME: …" is recognised and matched
 * to the warehouse's office list of the order's courier. An office address that cannot be matched to exactly ONE
 * office is never sent as an address: the caller blocks the order until a person picks the office.
 */

export const DeliveryOfficeChoice = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("address") }),
  z.object({
    mode: z.literal("office"),
    officeId: z.number().int().positive(),
    name: z.string().max(200),
    /**
     * The courier of the office a person picked (owner request 2026-11-12: with no courier set for the country, the
     * office list shows every office courier and the pick decides the courier too).
     */
    courierId: z.number().int().positive().optional(),
  }),
]);
export type DeliveryOfficeChoice = z.infer<typeof DeliveryOfficeChoice>;

/** Only orders to Bulgaria get the office option (every other country stays as it is). */
export const OFFICE_COUNTRIES = new Set(["BG"]);

export type OfficeResolution =
  | { kind: "address" }
  | {
      kind: "office";
      officeId: number;
      name: string;
      source: "chosen" | "speedy_id" | "name";
      /** The courier the office belongs to (sent as the body's courierId when the order has none). */
      courierId: number;
    }
  /** An office address (or a chosen office) that is not one office of the list: blocked for a person. */
  | {
      kind: "unresolved";
      reason: "no_match" | "ambiguous" | "chosen_missing" | "no_courier" | "address_is_office";
      search: string;
    };

export async function resolveDeliveryOffice(
  accountId: string,
  connectionId: string,
  courierId: number | undefined,
  order: {
    id: string;
    countryCode: string | null;
    shippingAddress: unknown;
    deliveryOffice: unknown;
  },
): Promise<OfficeResolution> {
  const address = (order.shippingAddress ?? {}) as Record<string, string | null>;
  const country = (address.countryCode ?? order.countryCode ?? "").toUpperCase();
  if (!OFFICE_COUNTRIES.has(country)) return { kind: "address" };
  const db = accountDb(accountId);
  const parsed = parseSpeedyOffice(address.address1) ?? parseSpeedyOffice(address.address2);
  const choice = DeliveryOfficeChoice.safeParse(order.deliveryOffice);
  if (choice.success) {
    // "До адрес" while the address is still an office line: the warehouse would read "Office …" in the street as
    // an office keyword and guess one. A person edits the address first (or picks the office).
    if (choice.data.mode === "address")
      return parsed
        ? { kind: "unresolved", reason: "address_is_office", search: parsed.officeName }
        : { kind: "address" };
    // An office belongs to one courier: the order's courier, or the courier of the office a person picked.
    const chosenCourier = courierId ?? choice.data.courierId;
    if (!chosenCourier) return { kind: "unresolved", reason: "no_courier", search: choice.data.name };
    // A courier set for the order later (default courier) that is not the picked office's: pick again.
    if (courierId && choice.data.courierId && choice.data.courierId !== courierId)
      return { kind: "unresolved", reason: "chosen_missing", search: choice.data.name };
    const office = await db.eushipmentsOffice.findFirst({
      where: { connectionId, officeId: choice.data.officeId, courierId: chosenCourier },
      select: { officeId: true, name: true },
    });
    return office
      ? {
          kind: "office",
          officeId: office.officeId,
          name: office.name,
          source: "chosen",
          courierId: chosenCourier,
        }
      : { kind: "unresolved", reason: "chosen_missing", search: choice.data.name };
  }
  if (!parsed) return { kind: "address" };
  if (!courierId) return { kind: "unresolved", reason: "no_courier", search: parsed.officeName };
  const offices = await db.eushipmentsOffice.findMany({
    where: { connectionId, courierId },
    select: { officeId: true, courierOfficeId: true, name: true },
  });
  const m = matchSpeedyOffice(parsed, offices);
  logger.debug(
    {
      orderId: order.id,
      speedyId: parsed.speedyId,
      officeName: parsed.officeName,
      result: m.kind,
      officeId: m.kind === "matched" ? m.office.officeId : null,
    },
    "speedy office recognised",
  );
  if (m.kind === "matched")
    return { kind: "office", officeId: m.office.officeId, name: m.office.name, source: m.by, courierId };
  return {
    kind: "unresolved",
    reason: m.kind === "ambiguous" ? "ambiguous" : "no_match",
    search: parsed.officeName,
  };
}

// ───────────────────────── order page: "Доставка" (До адрес / До офис) ─────────────────────────

/** Statuses in which the delivery may still change (same as the address: nothing approved or queued yet). */
const EDITABLE = new Set(["IMPORTED", "NEEDS_REVIEW", "READY", "ON_HOLD"]);

type Actor = { accountId: string; userId: string; role: string; companyScope: readonly string[] | null };

async function orderForOffice(actor: Actor, orderId: string) {
  const db = accountDb(actor.accountId);
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      companyId: true,
      status: true,
      countryCode: true,
      shippingAddress: true,
      deliveryOffice: true,
      updatedAt: true,
      check: { select: { routing: true, connectionId: true } },
    },
  });
  if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? ""))) return null;
  // The warehouse the order was validated for (the check's connection: a rule's, or the one a person chose).
  const connectionId = order.check?.connectionId ?? null;
  const connection = connectionId
    ? await db.fulfillmentConnection.findUnique({ where: { id: connectionId }, select: { type: true } })
    : null;
  if (!connectionId || connection?.type !== "EUSHIPMENTS") return { order, connectionId: null };
  const routing = (order.check?.routing ?? null) as {
    connectionId?: string | null;
    carrier?: { courierId?: string | null } | null;
  } | null;
  const { courierFor } = await import("./write");
  const address = (order.shippingAddress ?? {}) as Record<string, string | null>;
  const country = (address.countryCode ?? order.countryCode ?? "").toUpperCase() || null;
  // The rule's courier only when the rule chose this warehouse (as Fulfill does).
  const routed = routing?.connectionId === connectionId ? Number(routing?.carrier?.courierId) : NaN;
  const courier = await courierFor(actor.accountId, connectionId, country, {
    ...(Number.isInteger(routed) && routed > 0 ? { courierId: routed } : {}),
  });
  return { order, connectionId, courierId: courier.courierId, country };
}

/** What the order page shows under "Доставка" (orders to Bulgaria on an euShipments warehouse only). */
export async function deliveryOfficeView(actor: Actor, orderId: string) {
  const ctx = await orderForOffice(actor, orderId);
  if (!ctx) return null;
  const address = (ctx.order.shippingAddress ?? {}) as Record<string, string | null>;
  const country = (address.countryCode ?? ctx.order.countryCode ?? "").toUpperCase();
  if (!OFFICE_COUNTRIES.has(country) || !ctx.connectionId) return null;
  const resolution = await resolveDeliveryOffice(actor.accountId, ctx.connectionId, ctx.courierId, ctx.order);
  const chosen = DeliveryOfficeChoice.safeParse(ctx.order.deliveryOffice);
  const shownCourier = ctx.courierId ?? (resolution.kind === "office" ? resolution.courierId : undefined);
  const courierName = shownCourier
    ? ((
        await accountDb(actor.accountId).eushipmentsCourier.findFirst({
          where: { connectionId: ctx.connectionId, courierId: shownCourier },
          select: { name: true },
        })
      )?.name ?? String(shownCourier))
    : null;
  return {
    resolution,
    courierName,
    manual: chosen.success,
    editable: EDITABLE.has(ctx.order.status),
    version: ctx.order.updatedAt.toISOString(),
  };
}

/** The couriers whose offices may be picked: the order's courier, else every office courier of the country. */
async function officeCouriers(
  actor: Actor,
  connectionId: string,
  courierId: number | undefined,
  country: string | null,
) {
  const { countryCouriers } = await import("./write");
  const all = await countryCouriers(actor.accountId, connectionId, country);
  const list = courierId ? all.filter((c) => c.courierId === courierId) : all.filter((c) => c.toOffice);
  // A set courier missing from the mirror still counts (its offices are what the body would use).
  if (courierId && !list.length) return [{ courierId, name: String(courierId) }];
  return list.map((c) => ({ courierId: c.courierId, name: c.name }));
}

/**
 * Offices of the order's warehouse, by name (or by an id typed as a number): of the order's courier, or — none set —
 * of every office courier of the country, each with its courier's name. At most 30.
 */
export async function searchDeliveryOffices(actor: Actor, orderId: string, q: string) {
  const ctx = await orderForOffice(actor, orderId);
  if (!ctx?.connectionId) return [];
  const couriers = await officeCouriers(actor, ctx.connectionId, ctx.courierId, ctx.country ?? null);
  if (!couriers.length) return [];
  const courierName = new Map(couriers.map((c) => [c.courierId, c.name]));
  const term = q.trim().slice(0, 100);
  if (term.length < 2) return [];
  const asNumber = /^\d{1,9}$/.test(term) ? Number(term) : null;
  const rows = await accountDb(actor.accountId).eushipmentsOffice.findMany({
    where: {
      connectionId: ctx.connectionId,
      courierId: { in: couriers.map((c) => c.courierId) },
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        ...(asNumber ? [{ courierOfficeId: asNumber }, { officeId: asNumber }] : []),
      ],
    },
    select: {
      officeId: true,
      courierId: true,
      courierOfficeId: true,
      name: true,
      cityName: true,
      address: true,
      isStation: true,
    },
    orderBy: [{ name: "asc" }, { courierId: "asc" }],
    take: 30,
  });
  return rows.map((r) => ({ ...r, courierName: courierName.get(r.courierId) ?? String(r.courierId) }));
}

export const SetDeliveryInput = z.object({
  orderId: z.string().min(1).max(64),
  version: z.string().min(1).max(40),
  /** null = automatic again (recognised from the address). */
  choice: DeliveryOfficeChoice.nullable(),
});

/** A person picks "До адрес" / "До офис" + the office (or back to automatic). Re-checked right after. Audited. */
export async function setDeliveryOffice(
  actor: Actor & { ip?: string | null; userAgent?: string | null },
  raw: unknown,
) {
  assertCan(actor.role as Role, "orders.review");
  const input = SetDeliveryInput.parse(raw);
  const ctx = await orderForOffice(actor, input.orderId);
  if (!ctx) throw new DomainError("not_found");
  if (!ctx.connectionId) throw new DomainError("office_not_supported");
  let choice = input.choice;
  if (choice?.mode === "office") {
    // Only an office of the order's courier, or (none set) of one of the country's office couriers.
    const allowed = (await officeCouriers(actor, ctx.connectionId, ctx.courierId, ctx.country ?? null)).map(
      (c) => c.courierId,
    );
    const wanted = ctx.courierId ?? choice.courierId;
    if (!wanted) throw new DomainError("no_courier");
    if (!allowed.includes(wanted)) throw new DomainError("office_unknown");
    const office = await accountDb(actor.accountId).eushipmentsOffice.findFirst({
      where: { connectionId: ctx.connectionId, officeId: choice.officeId, courierId: wanted },
      select: { officeId: true, name: true, courierId: true },
    });
    if (!office) throw new DomainError("office_unknown");
    choice = { mode: "office", officeId: office.officeId, name: office.name, courierId: office.courierId };
  }
  await withAccountTransaction(actor.accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", input.orderId);
    const order = await tx.order.findUniqueOrThrow({
      where: { id: input.orderId },
      select: { status: true, updatedAt: true, deliveryOffice: true },
    });
    if (!EDITABLE.has(order.status)) throw new DomainError("not_editable");
    if (order.updatedAt.toISOString() !== input.version) throw new DomainError("stale");
    await tx.order.update({
      where: { id: input.orderId },
      data: { deliveryOffice: choice ? (choice as Prisma.InputJsonValue) : Prisma.DbNull },
    });
    await tx.auditLog.create({
      data: {
        accountId: actor.accountId,
        userId: actor.userId,
        action: "order.delivery_office",
        entityType: "Order",
        entityId: input.orderId,
        before: (order.deliveryOffice ?? Prisma.DbNull) as Prisma.InputJsonValue,
        after: (choice ?? Prisma.DbNull) as Prisma.InputJsonValue,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
    });
  });
  const { checkOrder } = await import("@/server/checks");
  try {
    await checkOrder(actor.accountId, input.orderId, { actor: { kind: "user", userId: actor.userId } });
  } catch (err) {
    // Saved and audited; the check sweep re-checks it.
    logger.warn(
      { orderId: input.orderId, err: (err as Error).message },
      "re-check after delivery change failed",
    );
    return { saved: true, rechecked: false };
  }
  return { saved: true, rechecked: true };
}
