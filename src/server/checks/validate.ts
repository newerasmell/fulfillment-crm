import { localCurrencyFor } from "@/server/countries/currency";
import type { Prisma } from "@/generated/prisma/client";
import { PRE_APPROVAL } from "@/server/shopify/statuses";
import { shopifyPaymentOf } from "@/server/shopify/payment-facts";
import { customPhoneRule } from "@/integrations/eushipments/phone";
import { SERVICE_NAMES } from "@/integrations/eushipments/schemas";
import { suspiciousItemIds } from "@/server/products/suspicious";
import { DomainError } from "@/server/accounts";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import { previewEuOrderFindings, previewEuOrderPayload } from "@/server/eushipments/write";
import { previewFhbOrderFindings, previewFhbOrderPayload } from "@/server/fhb/orders";
import { orderFingerprint, transition, type PipelineActor } from "@/server/pipeline";
import {
  loadRoutingContext,
  routeWithContext,
  stockByConnection,
  type ManualChoiceInfo,
  type RoutingDecision,
  type StockCheck,
} from "@/server/routing";
import type { ScopedActor } from "@/server/stores";
import { DEFAULT_REASON_CODES, listReasonCodes } from "@/server/review/reasons";
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

/** The rule's carrier settings as the vendor queue functions take them (only for the routed connection). */
function vendorArgs(connection: { id: string }, routing: RoutingDecision) {
  const carrier = routing.connectionId === connection.id ? routing.carrier : null;
  const courierId = carrier?.courierId ? Number(carrier.courierId) : undefined;
  const serviceName = (SERVICE_NAMES as readonly string[]).includes(carrier?.serviceName ?? "")
    ? (carrier!.serviceName as (typeof SERVICE_NAMES)[number])
    : undefined;
  return {
    fhb: { parcelService: carrier?.parcelService ?? null },
    eu: {
      ...(courierId && Number.isInteger(courierId) && courierId > 0 ? { courierId } : {}),
      ...(serviceName ? { serviceName } : {}),
    },
  };
}

/**
 * The exact body the warehouse's queue function would send for this order now (DESIGN principle 4: "show
 * what will be sent"), from the same pure builders and pre-flight. Reads only; never calls a vendor. Null when
 * a hard finding blocks building it or the connection type does not ship orders.
 */
export async function previewVendorPayload(
  accountId: string,
  orderId: string,
  connection: { id: string; type: string },
  routing: RoutingDecision,
  now: Date = new Date(),
): Promise<unknown> {
  const args = vendorArgs(connection, routing);
  try {
    if (connection.type === "FHB_V3")
      return await previewFhbOrderPayload(accountId, { orderId, connectionId: connection.id, ...args.fhb });
    if (connection.type === "EUSHIPMENTS")
      return await previewEuOrderPayload(
        accountId,
        { orderId, connectionId: connection.id, ...args.eu },
        now,
      );
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
  }
  return null;
}

async function vendorFindings(
  accountId: string,
  orderId: string,
  connection: { id: string; type: string },
  routing: RoutingDecision,
  now: Date,
): Promise<Finding[]> {
  const args = vendorArgs(connection, routing);
  try {
    if (connection.type === "FHB_V3") {
      return (
        await previewFhbOrderFindings(accountId, { orderId, connectionId: connection.id, ...args.fhb })
      ).map(fromFhb);
    }
    if (connection.type === "EUSHIPMENTS") {
      return (
        await previewEuOrderFindings(accountId, { orderId, connectionId: connection.id, ...args.eu }, now)
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
    include: {
      lines: {
        select: {
          title: true,
          sku: true,
          productId: true,
          quantity: true,
          unitPrice: true,
          variantLinkId: true,
          productChoice: { select: { id: true } },
        },
      },
      company: { select: { lineId: true } },
      codOverride: { select: { id: true } },
      // "Изпрати от" (P4-09): a person's warehouse choice replaces the routing decision until it is cleared.
      warehouseChoice: true,
    },
  });
  if (!order) throw new DomainError("not_found");

  const ctx = await loadRoutingContext(accountId);
  const routingOrder = {
    companyId: order.companyId,
    // The product line bounds the stock fallback (P5-00), exactly as routeOrder() sees the order.
    lineId: order.company?.lineId ?? null,
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
  const choice = opts.connectionId ? null : order.warehouseChoice;
  const manual = choice ? ctx.connections.find((c) => c.id === choice.connectionId) : undefined;
  if (opts.connectionId) {
    const chosen = ctx.connections.find((c) => c.id === opts.connectionId);
    if (!chosen) throw new DomainError("not_found");
    connection = chosen;
    stock = (await stockByConnection(accountId, [chosen], routingOrder.lines)).get(chosen.id) ?? null;
  } else if (choice && manual) {
    connection = manual;
    stock = (await stockByConnection(accountId, [manual], routingOrder.lines)).get(manual.id) ?? null;
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

  // "Съмнителни връзки", live from the current names: the variant's link, or the shipping warehouse's product link.
  const variantIds = order.lines.map((l) => l.variantLinkId).filter((x): x is string => !!x);
  const productIds = order.lines.map((l) => l.productId).filter((x): x is string => !!x);
  const suspicious =
    variantIds.length || productIds.length
      ? await suspiciousItemIds(accountId, {
          variants: { id: { in: variantIds } },
          vendors: {
            productId: { in: productIds },
            ...(connection ? { connectionId: connection.id } : {}),
          },
        })
      : new Set<string>();
  const suspiciousProducts = suspicious.size
    ? new Set(
        (
          await db.vendorProduct.findMany({
            where: { id: { in: [...suspicious] } },
            select: { productId: true },
          })
        ).map((v) => v.productId),
      )
    : new Set<string | null>();

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
      // A person's manual COD (OrderCodOverride) decides the payment instead of Shopify's facts.
      shopifyPayment: order.source === "SHOPIFY" && !order.codOverride ? shopifyPaymentOf(order.raw) : null,
      lines: order.lines.map((l) => ({
        ...l,
        // A product a person picked for this line by hand is not what the shop variant links to: only the
        // warehouse side of the chosen product can disagree.
        suspiciousLink:
          (!l.productChoice && !!l.variantLinkId && suspicious.has(l.variantLinkId)) ||
          (!!l.productId && suspiciousProducts.has(l.productId)),
      })),
    },
    {
      localCurrency: localCurrencyFor(setting, country),
      phoneRule: customPhoneRule(setting?.phoneRules),
      routing,
      stock,
      duplicates,
    },
  );
  const vendor = connection ? await vendorFindings(accountId, order.id, connection, routing, now) : [];
  const manualRouting =
    choice && manual
      ? manualDecision(routing, manual, routingOrder.companyId, stock, {
          via: choice.via === "reroute" ? "reroute" : "manual",
          userId: choice.chosenById,
          userName: choice.chosenById ? await memberName(accountId, choice.chosenById) : null,
          reasonCode: choice.reasonCode,
          reasonLabel: await reasonLabel(accountId, choice.reasonCode),
          reasonText: choice.reasonText,
          at: choice.updatedAt.toISOString(),
        })
      : null;
  // A chosen warehouse that was switched off since: never sent there silently, never re-routed silently either.
  const choiceFindings: Finding[] =
    choice && manual && !manual.enabled
      ? [
          {
            code: "routing.chosen_connection_disabled",
            severity: "hard",
            source: "routing",
            field: null,
            message_bg: `Ръчно избраният склад „${manual.name}“ е изключен — изберете друг или върнете маршрута.`,
            message_en: `The warehouse chosen by hand ("${manual.name}") is disabled — choose another or go back to routing.`,
          },
        ]
      : [];
  const findings = sortFindings([...level.findings, ...vendor, ...choiceFindings]);
  const result: OrderCheckResult = {
    orderId: order.id,
    connectionId: connection?.id ?? null,
    routing:
      manualRouting ??
      (opts.connectionId && opts.connectionId !== routing.connectionId ? { ...routing, stock } : routing),
    findings,
    ...countBy(findings),
    normalised: level.normalised,
    checkedAt: now,
  };

  if (opts.persist !== false) {
    const data = {
      connectionId: result.connectionId,
      ruleId:
        manualRouting || (opts.connectionId && opts.connectionId !== routing.connectionId)
          ? null
          : routing.ruleId,
      routing: json(result.routing),
      findings: json(result.findings),
      hardCount: result.hardCount,
      softCount: result.softCount,
      // The fingerprint of the data validated here: approve refuses once the order no longer matches it.
      normalised: json({ ...result.normalised, orderFingerprint: orderFingerprint(order) }),
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

const STOCK_TEXT = {
  ok: { bg: "наличност OK", en: "stock OK" },
  insufficient: { bg: "няма достатъчна наличност", en: "not enough stock" },
  unknown: { bg: "наличността не е известна", en: "stock unknown" },
} as const;

async function reasonLabel(accountId: string, code: string) {
  const c =
    (await listReasonCodes(accountId, { includeInactive: true })).find((x) => x.code === code) ??
    DEFAULT_REASON_CODES.find((x) => x.code === code);
  return c ? { bg: c.labelBg, en: c.labelEn } : { bg: code, en: code };
}

async function memberName(accountId: string, userId: string) {
  const m = await accountDb(accountId).membership.findFirst({
    where: { userId },
    select: { user: { select: { name: true, email: true } } },
  });
  return m ? (m.user.name ?? m.user.email) : null;
}

/**
 * The routing decision as stored for a person's warehouse choice (P4-09): via "manual", the chosen warehouse, who
 * and why, and what routing would have picked. The rule's carrier settings apply only when the person chose the
 * routed warehouse itself.
 */
function manualDecision(
  routing: RoutingDecision,
  chosen: {
    id: string;
    name: string;
    type: RoutingDecision["connectionType"] & string;
    companyId: string | null;
  },
  orderCompanyId: string | null,
  stock: StockCheck | null,
  info: Omit<ManualChoiceInfo, "routed">,
): RoutingDecision {
  const crossCompany = !!orderCompanyId && !!chosen.companyId && orderCompanyId !== chosen.companyId;
  const st = STOCK_TEXT[stock?.status ?? "unknown"];
  const who = info.userName ?? "—";
  const head =
    info.via === "reroute"
      ? { bg: `Пренасочена (${who})`, en: `Rerouted (${who})` }
      : { bg: `Ръчен избор (${who})`, en: `Chosen by hand (${who})` };
  const cross = crossCompany
    ? {
        bg: "; склад на друга фирма (отчита се само в CRM)",
        en: "; another company's warehouse (recorded in the CRM only)",
      }
    : { bg: "", en: "" };
  return {
    ...routing,
    connectionId: chosen.id,
    connectionName: chosen.name,
    connectionType: chosen.type,
    via: "manual",
    ruleId: null,
    ruleNumber: null,
    ruleName: null,
    crossCompany,
    carrier: routing.connectionId === chosen.id ? routing.carrier : null,
    stock,
    explanation: {
      bg: `${head.bg}, причина „${info.reasonLabel.bg}“ → ${chosen.name}; ${st.bg}${cross.bg}`,
      en: `${head.en}, reason "${info.reasonLabel.en}" → ${chosen.name}; ${st.en}${cross.en}`,
    },
    manual: {
      ...info,
      routed: {
        connectionId: routing.connectionId,
        connectionName: routing.connectionName,
        via: routing.via,
        ruleNumber: routing.ruleNumber,
        explanation: routing.explanation,
      },
    },
  };
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
 * Runs the pre-flight checks inside the pipeline: IMPORTED / NEEDS_REVIEW / READY / SUBMIT_FAILED
 * → CHECKING → READY (no finding) or NEEDS_REVIEW (any finding). An order in another state (e.g. already at
 * the warehouse) is validated and its check stored, but its status is left alone.
 */
export async function checkOrder(
  accountId: string,
  orderId: string,
  opts: { actor: PipelineActor; connectionId?: string; now?: Date },
): Promise<CheckOrderResult> {
  const source = "checks";
  const started = await withAccountTransaction(accountId, async (tx, { lockForUpdate }) => {
    await lockForUpdate("Order", orderId);
    await repairChosenLines(tx, orderId);
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
    moved = await withAccountTransaction(accountId, async (tx, { lockForUpdate }) => {
      await lockForUpdate("Order", orderId);
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

/**
 * A product a person picked for a line by hand (OrderLineProductChoice) wins over anything that rewrote the line
 * meanwhile (a variant re-link racing the pick, a future writer): before the order is checked, every line of an
 * order still in review gets its chosen product back. Never touches an order past review.
 */
async function repairChosenLines(tx: Prisma.TransactionClient, orderId: string) {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (!order || !PRE_APPROVAL.has(order.status)) return;
  const drifted = await tx.orderLine.findMany({
    where: { orderId, productChoice: { isNot: null } },
    select: { id: true, productId: true, productChoice: { select: { productId: true } } },
  });
  for (const l of drifted)
    if (l.productChoice && l.productId !== l.productChoice.productId)
      await tx.orderLine.update({ where: { id: l.id }, data: { productId: l.productChoice.productId } });
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
