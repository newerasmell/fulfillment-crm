import { z } from "zod";
import { AWB_LIMITS, ShipmentPriceBody } from "@/integrations/eushipments/awb-schemas";
import { JOY_LIMITS } from "@/integrations/fhb-joy/schemas";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";

/**
 * Read-call requests made from the UI (bulk label PDF, price quote, label re-fetch, Joy connection test). They
 * only write a row; the worker makes the vendor read call (no vendor call from route handlers / components).
 */

const Ids = z.array(z.string().min(1).max(64)).min(1).max(500);

/** Bulk label print: one job per connection and vendor batch size (Joy 100, euShipments 50). */
export async function requestBulkLabels(actor: ScopedActor, rawIds: string[]) {
  assertCan(actor.role, "orders.fulfill");
  const ids = [...new Set(Ids.parse(rawIds))];
  const db = accountDb(actor.accountId);
  const rows = await db.fulfillment.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      connectionId: true,
      status: true,
      vendorOrderId: true,
      connection: { select: { type: true } },
      order: { select: { companyId: true } },
      manualShipment: { select: { kind: true } },
    },
  });
  const usable = rows.filter(
    (r) =>
      (!actor.companyScope || actor.companyScope.includes(r.order.companyId ?? "")) &&
      (r.manualShipment?.kind === "JOY_LABEL" || (r.manualShipment?.kind === "AWB" && r.vendorOrderId)) &&
      !["QUEUED", "SUBMITTING", "SUBMIT_FAILED", "CANCELLED"].includes(r.status),
  );
  if (usable.length === 0) throw new DomainError("nothing_to_print");
  const byConn = new Map<string, { type: string; ids: string[] }>();
  for (const r of usable) {
    const g = byConn.get(r.connectionId) ?? { type: r.connection.type, ids: [] };
    g.ids.push(r.id);
    byConn.set(r.connectionId, g);
  }
  const jobs: { id: string; accountId: string }[] = [];
  for (const [connectionId, g] of byConn) {
    const size = g.type === "FHB_JOY" ? JOY_LIMITS.labelsMax : AWB_LIMITS.mergedPrintMax;
    for (let i = 0; i < g.ids.length; i += size) {
      const job = await db.labelPrintJob.create({
        data: {
          accountId: actor.accountId,
          connectionId,
          fulfillmentIds: g.ids.slice(i, i + size),
          createdById: actor.userId,
        },
        select: { id: true, accountId: true },
      });
      jobs.push(job);
    }
  }
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "labels.bulk_print",
    entityType: "LabelPrintJob",
    entityId: jobs[0]!.id,
    after: { jobs: jobs.map((j) => j.id), shipments: usable.length, skipped: ids.length - usable.length },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { jobs, skipped: ids.length - usable.length };
}

export async function labelPrintJobs(actor: ScopedActor, jobIds: string[]) {
  return accountDb(actor.accountId).labelPrintJob.findMany({
    where: { id: { in: jobIds }, ...(actor.companyScope ? { createdById: actor.userId } : {}) },
    select: {
      id: true,
      status: true,
      labelId: true,
      error: true,
      errors: true,
      fulfillmentIds: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

export const QuoteInput = z.object({
  connectionId: z.string().min(1).max(64),
  courierId: z.number().int().positive(),
  weight: z.number().positive().max(10_000),
  codAmount: z.number().min(0).max(1_000_000).default(0),
  toOffice: z.boolean().default(false),
  openPackage: z.boolean().default(false),
  insuranceAmount: z.number().min(0).max(1_000_000).default(0),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});

/** euShipments shipment-price (a read call): queued for the worker, the form polls the row. */
export async function requestQuote(actor: ScopedActor, raw: z.input<typeof QuoteInput>) {
  assertCan(actor.role, "orders.fulfill");
  const v = QuoteInput.parse(raw);
  const db = accountDb(actor.accountId);
  const c = await db.fulfillmentConnection.findUnique({ where: { id: v.connectionId } });
  if (
    !c ||
    c.type !== "EUSHIPMENTS" ||
    (actor.companyScope && !actor.companyScope.includes(c.companyId ?? ""))
  )
    throw new DomainError("not_found");
  const companyId = Number((c.vendorIds as { companyId?: unknown } | null)?.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) throw new DomainError("no_company_id");
  const request = ShipmentPriceBody.parse({
    courierId: v.courierId,
    companyId,
    weight: v.weight,
    codAmount: v.codAmount,
    openPackage: v.openPackage,
    insuranceAmount: v.insuranceAmount,
    returnDocs: 2,
    toOffice: v.toOffice,
    ...(v.currency ? { currency: v.currency } : {}),
  });
  return db.shippingQuote.create({
    data: { accountId: actor.accountId, connectionId: c.id, request, createdById: actor.userId },
    select: { id: true, accountId: true },
  });
}

export async function quoteResult(actor: ScopedActor, quoteId: string) {
  const q = await accountDb(actor.accountId).shippingQuote.findUnique({
    where: { id: quoteId },
    select: { id: true, status: true, response: true, error: true, createdById: true },
  });
  if (!q || q.createdById !== actor.userId) throw new DomainError("not_found");
  return q;
}

/** Re-fetch one label (AWB print / Joy reprint) — the worker reads it, the CRM stores it. */
export async function requestLabelRefetch(actor: ScopedActor, fulfillmentId: string) {
  assertCan(actor.role, "orders.fulfill");
  const f = await accountDb(actor.accountId).fulfillment.findUnique({
    where: { id: fulfillmentId },
    select: {
      id: true,
      status: true,
      order: { select: { companyId: true } },
      manualShipment: { select: { kind: true } },
    },
  });
  if (
    !f ||
    !f.manualShipment ||
    (actor.companyScope && !actor.companyScope.includes(f.order.companyId ?? ""))
  )
    throw new DomainError("not_found");
  if (!["JOY_LABEL", "AWB"].includes(f.manualShipment.kind)) throw new DomainError("no_label");
  return { accountId: actor.accountId, fulfillmentId: f.id };
}

/** Joy connection test (POST /login only). */
export async function requestJoyTest(actor: ScopedActor, connectionId: string) {
  assertCan(actor.role, "connections.manage");
  const c = await accountDb(actor.accountId).fulfillmentConnection.findUnique({
    where: { id: connectionId },
  });
  if (!c || c.type !== "FHB_JOY" || (actor.companyScope && !actor.companyScope.includes(c.companyId ?? "")))
    throw new DomainError("not_found");
  return { accountId: actor.accountId, connectionId };
}
