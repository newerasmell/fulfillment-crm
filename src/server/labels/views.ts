import { DomainError } from "@/server/accounts";
import { assertCan, can } from "@/server/auth/rbac";
import { accountDb } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import { joySettingsOf } from "./connection";
import { voidableLabel } from "./manual";

/** Read models for Ръчни пратки и етикети (list, detail, connection settings). Scoped by account and company. */

export const LIST_TABS = ["all", "labels", "warehouse", "attention"] as const;
export type ListTab = (typeof LIST_TABS)[number];

const scopeWhere = (actor: ScopedActor) =>
  actor.companyScope ? { order: { companyId: { in: actor.companyScope } } } : {};

export async function listManualShipments(
  actor: ScopedActor,
  opts: { tab?: ListTab; q?: string; take?: number } = {},
) {
  const db = accountDb(actor.accountId);
  const tab = opts.tab ?? "all";
  const where = {
    ...scopeWhere(actor),
    ...(tab === "labels" ? { kind: { in: ["JOY_LABEL", "AWB", "PRE_AWB"] } } : {}),
    ...(tab === "warehouse" ? { kind: "WAREHOUSE" } : {}),
    ...(tab === "attention"
      ? {
          OR: [
            {
              fulfillment: {
                status: { in: ["SUBMIT_FAILED", "UNKNOWN", "BLOCKED", "EXCEPTION"] as never[] },
              },
            },
            { order: { status: { in: ["SUBMIT_FAILED", "NEEDS_REVIEW"] as never[] } } },
          ],
        }
      : {}),
    ...(opts.q
      ? {
          OR: [
            { order: { number: { contains: opts.q, mode: "insensitive" as const } } },
            { order: { customerName: { contains: opts.q, mode: "insensitive" as const } } },
            { fulfillment: { trackingNumbers: { has: opts.q } } },
            { fulfillment: { externalId: { contains: opts.q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };
  const [rows, counts] = await Promise.all([
    db.manualShipment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: opts.take ?? 100,
      include: {
        connection: { select: { id: true, name: true, type: true, liveMode: true } },
        order: {
          select: {
            id: true,
            number: true,
            status: true,
            customerName: true,
            countryCode: true,
            codAmount: true,
            currency: true,
            createdAt: true,
          },
        },
        fulfillment: {
          select: {
            id: true,
            externalId: true,
            status: true,
            rawStatus: true,
            trackingNumbers: true,
            labelFileKey: true,
            vendorOrderId: true,
          },
        },
      },
    }),
    db.manualShipment.groupBy({ by: ["kind"], where: scopeWhere(actor), _count: true }),
  ]);
  return {
    rows,
    counts: Object.fromEntries(counts.map((c) => [c.kind, c._count])) as Record<string, number>,
  };
}

export async function getManualShipment(actor: ScopedActor, id: string) {
  const db = accountDb(actor.accountId);
  const ms = await db.manualShipment.findUnique({
    where: { id },
    include: {
      connection: { select: { id: true, name: true, type: true, liveMode: true, canaryDailyCap: true } },
      order: {
        include: {
          events: { orderBy: { createdAt: "asc" } },
          lines: { select: { id: true, title: true, sku: true, quantity: true, unitPrice: true } },
          check: {
            select: { findings: true, hardCount: true, softCount: true, routing: true, connectionId: true },
          },
        },
      },
      fulfillment: {
        include: {
          events: { orderBy: { occurredAt: "asc" } },
          labels: {
            select: { id: true, kind: true, format: true, source: true, sizeBytes: true, createdAt: true },
            orderBy: { createdAt: "desc" },
          },
        },
      },
    },
  });
  if (!ms || (actor.companyScope && !actor.companyScope.includes(ms.order.companyId ?? "")))
    throw new DomainError("not_found");
  const requests = ms.fulfillmentId
    ? await db.outboundRequest.findMany({
        where: { fulfillmentId: ms.fulfillmentId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          operation: true,
          status: true,
          evaluatedMode: true,
          attempts: true,
          lastError: true,
          createdAt: true,
          sentAt: true,
          confirmedAt: true,
          ...(can(actor.role, "outbox.payloads") ? { payload: true } : {}),
        },
      })
    : [];
  const bulk = ms.fulfillmentId
    ? await db.shipmentLabel.findMany({
        where: { kind: "bulk", fulfillmentIds: { has: ms.fulfillmentId } },
        select: { id: true, source: true, createdAt: true, sizeBytes: true },
        orderBy: { createdAt: "desc" },
        take: 5,
      })
    : [];
  const open = requests.find((r) =>
    ["PENDING", "AWAITING_CONFIRMATION", "DRY_RUN_RECORDED", "REFUSED", "FAILED", "HELD", "PAUSED"].includes(
      r.status,
    ),
  );
  return {
    ms,
    requests,
    bulkLabels: bulk,
    voidable: voidableLabel(ms.kind, ms.fulfillment),
    /** The request the CANARY dialog / "send again" acts on. */
    openRequest: open ?? null,
  };
}

/** Connections usable for manual shipments, by kind, with their mode (the form shows it next to the choice). */
export async function manualConnections(actor: ScopedActor) {
  const rows = await accountDb(actor.accountId).fulfillmentConnection.findMany({
    where: {
      enabled: true,
      type: { in: ["FHB_V3", "FHB_JOY", "EUSHIPMENTS"] },
      ...(actor.companyScope ? { companyId: { in: actor.companyScope } } : {}),
    },
    select: { id: true, name: true, type: true, liveMode: true, companyId: true, vendorIds: true },
    orderBy: { name: "asc" },
  });
  return rows.map(({ vendorIds, ...c }) => ({
    ...c,
    joy: c.type === "FHB_JOY" ? (({ lastTest: _t, ...s }) => (void _t, s))(joySettingsOf(vendorIds)) : null,
  }));
}

/**
 * The euShipments connection behind the AWB form's mirror lookups: the form's permission and the actor's
 * company scope, like requestQuote — a scoped user never lists another company's connection mirror.
 */
async function formConnection(actor: ScopedActor, connectionId: string) {
  assertCan(actor.role, "orders.fulfill");
  const c = await accountDb(actor.accountId).fulfillmentConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, type: true, companyId: true },
  });
  if (
    !c ||
    c.type !== "EUSHIPMENTS" ||
    (actor.companyScope && !actor.companyScope.includes(c.companyId ?? ""))
  )
    throw new DomainError("not_found");
  return c;
}

/** Couriers and offices from the euShipments mirror (read-only, for the AWB form). */
export async function euCouriers(actor: ScopedActor, connectionId: string) {
  await formConnection(actor, connectionId);
  const db = accountDb(actor.accountId);
  return db.eushipmentsCourier.findMany({ where: { connectionId }, orderBy: { name: "asc" }, take: 200 });
}

export async function joyConnectionsForSettings(actor: ScopedActor) {
  const rows = await accountDb(actor.accountId).fulfillmentConnection.findMany({
    where: { type: "FHB_JOY", ...(actor.companyScope ? { companyId: { in: actor.companyScope } } : {}) },
    select: {
      id: true,
      name: true,
      liveMode: true,
      enabled: true,
      companyId: true,
      vendorIds: true,
      canaryDailyCap: true,
      company: { select: { name: true } },
    },
    orderBy: { name: "asc" },
  });
  return rows.map(({ vendorIds, ...c }) => ({ ...c, settings: joySettingsOf(vendorIds) }));
}

/** Courier offices / PUDO of one courier from the euShipments mirror (search by city / name / code). */
export async function euOffices(actor: ScopedActor, connectionId: string, courierId: number, q: string) {
  await formConnection(actor, connectionId);
  const term = q.trim();
  return accountDb(actor.accountId).eushipmentsOffice.findMany({
    where: {
      connectionId,
      courierId,
      ...(term
        ? {
            OR: [
              { cityName: { contains: term, mode: "insensitive" as const } },
              { name: { contains: term, mode: "insensitive" as const } },
              { code: { contains: term, mode: "insensitive" as const } },
              { postCode: { startsWith: term } },
            ],
          }
        : {}),
    },
    select: { officeId: true, name: true, cityName: true, address: true, postCode: true, code: true },
    orderBy: [{ cityName: "asc" }, { name: "asc" }],
    take: 30,
  });
}
