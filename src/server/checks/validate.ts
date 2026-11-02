import type { Prisma } from "@/generated/prisma/client";
import { SERVICE_NAMES } from "@/integrations/eushipments/schemas";
import { DomainError } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { previewEuOrderFindings } from "@/server/eushipments/write";
import { previewFhbOrderFindings } from "@/server/fhb/orders";
import { transition, type PipelineActor } from "@/server/pipeline";
import {
  loadRoutingContext,
  routeWithContext,
  stockByConnection,
  type RoutingDecision,
  type StockCheck,
} from "@/server/routing";
import type { ScopedActor } from "@/server/stores";
import { countBy, fromEu, fromFhb, sortFindings, type Finding } from "./findings";
import { orderLevelFindings } from "./order-checks";

/**
 * Validator engine (P4-01). validateOrder() returns every finding for one order and one connection — the
 * routed one, or the one the operator chose — and stores the result as the order's OrderCheck:
 *   1. routing (src/server/routing): which warehouse and why, stock there;
 *   2. order-level checks (./order-checks.ts): address, phone, unmatched lines, COD rules, stock, duplicates;
 *   3. the warehouse's own pre-flight validators (FHB / euShipments), exactly as their queue functions run
 *      them, but without queueing anything (previewFhbOrderFindings / previewEuOrderFindings).
 * Reads only, apart from the OrderCheck row. checkOrder() wraps it in the pipeline (CHECKING → READY or
 * NEEDS_REVIEW); the approve transition refuses while the stored check has a hard finding.
 */

export interface ValidateOptions {
  /** Validate for this connection instead of the routed one (operator's choice / reroute). */
  connectionId?: string;
  now?: Date;
  /** Store the result as the order's OrderCheck (default true). */
  persist?: boolean;
  checkedById?: string | null;
}

export interface OrderCheckResult {
  orderId: string;
  connectionId: string | null;
  routing: RoutingDecision;
  findings: Finding[];
  hardCount: number;
  softCount: number;
  normalised: { phone: string | null; country: string | null };
  checkedAt: Date;
}

const num = (d: Prisma.Decimal | null | undefined) => (d == null ? null : Number(d.toString()));
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;
const DUPLICATE_WINDOW_MS = 48 * 3600_000;

async function vendorFindings(
  accountId: string,
  orderId: string,
  connection: { id: string; type: string },
  routing: RoutingDecision,
  now: Date,
): Promise<Finding[]> {
  // The rule's carrier settings apply only when the routed connection is the one being validated.
  const carrier = routing.connectionId === connection.id ? routing.carrier : null;
  try {
    if (connection.type === "FHB_V3") {
      return (
        await previewFhbOrderFindings(accountId, {
          orderId,
          connectionId: connection.id,
          parcelService: carrier?.parcelService ?? null,
        })
      ).map(fromFhb);
    }
    if (connection.type === "EUSHIPMENTS") {
      const courierId = carrier?.courierId ? Number(carrier.courierId) : undefined;
      const serviceName = (SERVICE_NAMES as readonly string[]).includes(carrier?.serviceName ?? "")
        ? (carrier!.serviceName as (typeof SERVICE_NAMES)[number])
        : undefined;
      return (
        await previewEuOrderFindings(
          accountId,
          {
            orderId,
            connectionId: connection.id,
            ...(courierId && Number.isInteger(courierId) && courierId > 0 ? { courierId } : {}),
            ...(serviceName ? { serviceName } : {}),
          },
          now,
        )
      ).map(fromEu);
    }
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    return [
      {
        code: "routing.connection_unusable",
        severity: "hard",
        source: "routing",
        field: null,
        message_bg: `Складът не може да се провери (${err.code}).`,
        message_en: `The warehouse cannot be checked (${err.code}).`,
      },
    ];
  }
  return [
    {
      code: "routing.connection_type_unsupported",
      severity: "hard",
      source: "routing",
      field: null,
      message_bg: "Този тип връзка не изпраща поръчки от наличност.",
      message_en: "This connection type does not ship orders from stock.",
    },
  ];
}

export async function validateOrder(
  accountId: string,
  orderId: string,
  opts: ValidateOptions = {},
): Promise<OrderCheckResult> {
  const now = opts.now ?? new Date();
  const db = accountDb(accountId);
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { lines: { select: { title: true, sku: true, productId: true, quantity: true } } },
  });
  if (!order) throw new DomainError("not_found");

  const ctx = await loadRoutingContext(accountId);
  const routingOrder = {
    companyId: order.companyId,
    storeId: order.storeId,
    countryCode: order.countryCode,
    paymentMethod: order.paymentMethod,
    tags: order.tags,
    lines: order.lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      title: l.sku ?? l.title,
    })),
  };
  const routing = await routeWithContext(ctx, routingOrder);

  let connection: { id: string; type: string } | null = null;
  let stock: StockCheck | null = routing.stock;
  if (opts.connectionId) {
    const chosen = ctx.connections.find((c) => c.id === opts.connectionId);
    if (!chosen) throw new DomainError("not_found");
    connection = chosen;
    stock = (await stockByConnection(accountId, [chosen], routingOrder.lines)).get(chosen.id) ?? null;
  } else if (routing.connectionId) {
    connection = { id: routing.connectionId, type: routing.connectionType! };
  }

  const address = (order.shippingAddress ?? {}) as Record<string, string | null>;
  const country = (address.countryCode ?? order.countryCode)?.toUpperCase() ?? null;
  const setting = country
    ? await db.countrySetting.findUnique({ where: { accountId_country: { accountId, country } } })
    : null;
  const contact = [order.email, order.phone].filter((v): v is string => !!v);
  const duplicates = contact.length
    ? await db.order.findMany({
        where: {
          id: { not: order.id },
          status: { notIn: ["CANCELLED"] },
          total: order.total,
          placedAt: {
            gte: new Date(order.placedAt.getTime() - DUPLICATE_WINDOW_MS),
            lte: new Date(order.placedAt.getTime() + DUPLICATE_WINDOW_MS),
          },
          OR: [
            ...(order.email ? [{ email: { equals: order.email, mode: "insensitive" as const } }] : []),
            ...(order.phone ? [{ phone: order.phone }] : []),
          ],
        },
        select: { number: true },
        take: 5,
      })
    : [];

  const level = orderLevelFindings(
    {
      number: order.number,
      customerName: order.customerName,
      email: order.email,
      phone: order.phone,
      shippingAddress: address,
      countryCode: order.countryCode,
      currency: order.currency,
      total: num(order.total) ?? 0,
      paymentMethod: order.paymentMethod,
      codAmount: num(order.codAmount),
      codLocalAmount: num(order.codLocalAmount),
      codLocalCurrency: order.codLocalCurrency,
      tags: order.tags,
      lines: order.lines,
    },
    { localCurrency: setting?.currency ?? null, routing, stock, duplicates },
  );
  const vendor = connection ? await vendorFindings(accountId, order.id, connection, routing, now) : [];
  const findings = sortFindings([...level.findings, ...vendor]);
  const result: OrderCheckResult = {
    orderId: order.id,
    connectionId: connection?.id ?? null,
    routing:
      opts.connectionId && opts.connectionId !== routing.connectionId ? { ...routing, stock } : routing,
    findings,
    ...countBy(findings),
    normalised: level.normalised,
    checkedAt: now,
  };

  if (opts.persist !== false) {
    const data = {
      connectionId: result.connectionId,
      ruleId: opts.connectionId && opts.connectionId !== routing.connectionId ? null : routing.ruleId,
      routing: json(result.routing),
      findings: json(result.findings),
      hardCount: result.hardCount,
      softCount: result.softCount,
      normalised: json(result.normalised),
      checkedById: opts.checkedById ?? null,
      checkedAt: now,
    };
    await db.orderCheck.upsert({
      where: { accountId_orderId: { accountId, orderId: order.id } },
      create: { accountId, orderId: order.id, ...data },
      update: data,
    });
  }
  return result;
}

/** The stored check of an order (null = never checked). */
export async function latestOrderCheck(accountId: string, orderId: string) {
  return accountDb(accountId).orderCheck.findUnique({
    where: { accountId_orderId: { accountId, orderId } },
  });
}

export interface CheckOrderResult extends OrderCheckResult {
  /** The order's pipeline status after the check (unchanged when it was not in a checkable state). */
  status: string;
  moved: boolean;
}

/**
 * Runs the pre-flight checks inside the pipeline: IMPORTED / NEEDS_REVIEW / READY / APPROVED / SUBMIT_FAILED
 * → CHECKING → READY (no finding) or NEEDS_REVIEW (any finding). An order in another state (e.g. already at
 * the warehouse) is validated and its check stored, but its status is left alone.
 */
export async function checkOrder(
  accountId: string,
  orderId: string,
  opts: { actor: PipelineActor; connectionId?: string; now?: Date },
): Promise<CheckOrderResult> {
  const source = "checks";
  const started = await withAccountTransaction(accountId, async (tx) => {
    const r = await transition(tx, {
      orderId,
      to: "CHECKING",
      cause: "check_start",
      actor: opts.actor,
      source,
      mode: "follow",
    });
    return r.changed || r.from === "CHECKING";
  });
  const result = await validateOrder(accountId, orderId, {
    connectionId: opts.connectionId,
    now: opts.now,
    checkedById: opts.actor.kind === "user" ? opts.actor.userId : null,
  });
  let moved = false;
  if (started) {
    moved = await withAccountTransaction(accountId, async (tx) => {
      const r = await transition(tx, {
        orderId,
        to: result.findings.length ? "NEEDS_REVIEW" : "READY",
        cause: "check_result",
        actor: opts.actor,
        source,
        mode: "follow",
        meta: { hardCount: result.hardCount, softCount: result.softCount, connectionId: result.connectionId },
      });
      return r.changed;
    });
  }
  const { status } = await accountDb(accountId).order.findUniqueOrThrow({
    where: { id: orderId },
    select: { status: true },
  });
  return { ...result, status, moved };
}

/** checkOrder for a person (re-check button, reroute): needs orders.review and the order in their scope. */
export async function checkOrderAs(
  actor: ScopedActor,
  orderId: string,
  opts: { connectionId?: string; now?: Date } = {},
) {
  assertCan(actor.role, "orders.review");
  const order = await accountDb(actor.accountId).order.findUnique({
    where: { id: orderId },
    select: { companyId: true },
  });
  if (!order || (actor.companyScope && !actor.companyScope.includes(order.companyId ?? "")))
    throw new DomainError("not_found");
  return checkOrder(actor.accountId, orderId, {
    ...opts,
    actor: { kind: "user", userId: actor.userId },
  });
}
