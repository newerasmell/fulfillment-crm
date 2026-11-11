import { collectableCod, WHOLE_UNIT_COD_CURRENCIES } from "@/lib/cod-rounding";
import { localCurrencyFor } from "@/server/countries/currency";
import { paymentUnclear } from "@/server/checks/order-checks";
import { shopifyPaymentOf } from "@/server/shopify/payment-facts";
import { z } from "zod";
import { resolveDeliveryOffice } from "./delivery-office";
import { isLabelOnly } from "@/server/labels/pipeline-guard";
import { Prisma, type Fulfillment, type OutboundStatus } from "@/generated/prisma/client";
import { EU_OPS } from "@/integrations/eushipments/adapter";
import {
  buildCreateOrder,
  buildCreateProduct,
  buildCreateRequest,
  buildCreateTransfer,
  vendorRefNumber,
} from "@/integrations/eushipments/mapper";
import {
  CreateProductBody,
  CreateRequestBody,
  CreateTransferBody,
  SERVICE_NAMES,
} from "@/integrations/eushipments/schemas";
import { customPhoneRule } from "@/integrations/eushipments/phone";
import { normaliseStatusText } from "@/integrations/eushipments/status-map";
import { hasBlocks, sofiaToday, validateEuOrder, type Finding } from "@/integrations/eushipments/validators";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, isUniqueViolation, withAccountTransaction } from "@/server/db/client";
import { enqueueOutbound, enqueueOutboundInTx } from "@/server/outbox/outbox";
import { queueGate } from "@/server/pipeline";
import type { ScopedActor } from "@/server/stores";
import { loadEuConnection } from "./connection";

/**
 * euShipments write services (P3-05). Nothing here calls the vendor: each function validates, records our
 * side (Fulfillment / InboundShipment / EushipmentsTransfer) and queues ONE outbox request with a
 * deterministic idempotency key in the same transaction. The worker sends it under the liveMode gate.
 *
 * Duplicate-shipment guard for orders: awb.referenceNumber is NOT unique at euShipments, so our
 * Fulfillment (connectionId, externalId) unique constraint + the orders-history read-back are the guarantee.
 */

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

async function euConnectionFor(actor: ScopedActor, connectionId: string) {
  const { connection, companyId } = await loadEuConnection(actor.accountId, connectionId);
  if (actor.companyScope && (!connection.companyId || !actor.companyScope.includes(connection.companyId)))
    throw new DomainError("not_found");
  if (!connection.enabled) throw new DomainError("connection_disabled");
  if (!companyId) throw new DomainError("no_company_id");
  return { connection, companyId };
}

/** refNumbers at this connection for our products (VendorProduct links, never EANs). */
async function refNumbersFor(accountId: string, connectionId: string, productIds: string[]) {
  return new Map(
    [...(await vendorProductsFor(accountId, connectionId, productIds))].map(([k, v]) => [k, v.ref]),
  );
}

async function vendorProductsFor(accountId: string, connectionId: string, productIds: string[]) {
  const rows = await accountDb(accountId).vendorProduct.findMany({
    where: { connectionId, productId: { in: productIds }, archived: false },
    select: { id: true, productId: true, vendorId: true },
  });
  return new Map(rows.map((r) => [r.productId!, { ref: r.vendorId, vendorProductId: r.id }]));
}

/**
 * Outbox states in which nothing was created at the vendor, so our record may be queued again under the same
 * deterministic key (mirrors the outbox's own re-arm rule: DRY_RUN_RECORDED, REFUSED, FAILED).
 */
const REARMABLE_REQUEST = new Set<OutboundStatus>(["DRY_RUN_RECORDED", "REFUSED", "FAILED"]);
/** Default for EushipmentsSettings.stockStaleHours (the reference example is a daily 06:00 snapshot). */
export const DEFAULT_STOCK_STALE_HOURS = 30;

// ───────────────────────── products ─────────────────────────

export const QueueProductInput = z.object({
  connectionId: z.string().min(1),
  productId: z.string().min(1),
  /** Operator's choice after a barcode collision (e.g. the prefixed SKU as an internal barcode). */
  barcode: z.string().trim().min(1).max(50).optional(),
});

/**
 * Queues create-product. Barcode = the operator's override, else the product's first known EAN. A barcode
 * collision at the vendor becomes an operator task (never retried blindly); re-queue with `barcode` to retry.
 */
export async function queueEuProduct(actor: ScopedActor, raw: z.input<typeof QueueProductInput>) {
  assertCan(actor.role, "connections.manage");
  const input = QueueProductInput.parse(raw);
  const { connection, companyId } = await euConnectionFor(actor, input.connectionId);
  const db = accountDb(actor.accountId);
  const product = await db.product.findUnique({
    where: { id: input.productId },
    include: { eans: { orderBy: { createdAt: "asc" }, take: 1 } },
  });
  if (!product || product.archived) throw new DomainError("not_found");
  const refNumber = vendorRefNumber(product.sku, connection.skuPrefixRule);
  const barcode = input.barcode ?? product.eans[0]?.ean;
  if (!barcode) throw new DomainError("no_barcode");
  const built = buildCreateProduct(companyId, {
    name: product.name,
    refNumber,
    barcode,
    weightGrams: product.weightGrams,
    lengthMm: product.lengthMm,
    widthMm: product.widthMm,
    heightMm: product.heightMm,
    hsCode: product.hsCode,
  });
  if (!built.ok) throw new DomainError("missing_dimensions", `missing: ${built.missing.join(", ")}`);
  const body = CreateProductBody.safeParse(built.body);
  if (!body.success) throw new DomainError("invalid_product", body.error.issues[0]?.message);

  const { request, created } = await enqueueOutbound({
    accountId: actor.accountId,
    connectionId: connection.id,
    operation: EU_OPS.createProduct,
    idempotencyKey: `product:${refNumber}`,
    payload: json({ body: body.data, ctx: { productId: product.id, refNumber, barcode } }),
    createdById: actor.userId,
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "eushipments.product_queued",
    entityType: "Product",
    entityId: product.id,
    after: { connectionId: connection.id, refNumber, barcode, requestId: request.id, created },
  });
  return { request, created };
}

// ───────────────────────── orders ─────────────────────────

export const QueueOrderInput = z.object({
  orderId: z.string().min(1),
  connectionId: z.string().min(1),
  waybillAvailableDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  courierId: z.number().int().positive().optional(),
  serviceName: z.enum(SERVICE_NAMES).optional(),
  officeId: z.number().int().positive().optional(),
  shipmentPayer: z.enum(["sender", "recipient"]).optional(),
  /** Invoice PDF, base64. Attached right after create (before the AWB exists). */
  invoicePdfBase64: z.string().min(8).optional(),
  /** Warning codes the operator has seen and accepted. */
  acknowledged: z.array(z.string()).default([]),
});

export type QueueOrderResult =
  | { status: "blocked" | "needs_ack"; findings: Finding[] }
  | {
      status: "queued";
      findings: Finding[];
      fulfillmentId: string;
      requestId: string;
      referenceNumber: string;
    };

/**
 * The reference for this order at this connection: an earlier shipment still on our side (QUEUED / SUBMIT_FAILED)
 * keeps its reference (re-queue); otherwise, after a cancelled/deleted shipment, a reship gets `-2`, `-3`, … —
 * euShipments refuses a reference that belongs to a deleted shipment, and our (connectionId, externalId) unique
 * index allows one shipment per reference.
 */
export async function reshipReference(
  db: { fulfillment: { findMany: (args: object) => Promise<{ externalId: string; status: string }[]> } },
  connectionId: string,
  orderId: string,
  base: string,
) {
  const earlier = await db.fulfillment.findMany({
    where: { connectionId, orderId },
    select: { externalId: true, status: true },
  });
  if (earlier.length === 0) return base;
  const open = earlier.find((e) => e.status === "QUEUED" || e.status === "SUBMIT_FAILED");
  if (open) return open.externalId;
  // A shipment that may exist at the vendor keeps its reference, so the duplicate check refuses a second one.
  const live = earlier.find((e) => e.status !== "CANCELLED");
  if (live) return live.externalId;
  const used = new Set(earlier.map((e) => e.externalId));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * The COD to collect in the destination's local currency: the order's own COD when the order is already in that
 * currency, else a stored local amount (Order.codLocalAmount/codLocalCurrency). null = cannot be determined.
 */
export function localCod(
  order: {
    currency: string;
    codAmount: { toString(): string } | null;
    total: { toString(): string };
    codLocalAmount: { toString(): string } | null;
    codLocalCurrency: string | null;
  },
  localCurrency: string | null,
): { amount: string; currency: string } | null {
  // Whole units where the courier collects whole units (HUF, collectableCod); other currencies unchanged.
  const collectable = (amount: string, currency: string) =>
    WHOLE_UNIT_COD_CURRENCIES.has(currency) ? String(collectableCod(Number(amount), currency)) : amount;
  if (localCurrency && order.currency.toUpperCase() === localCurrency.toUpperCase()) {
    const currency = localCurrency.toUpperCase();
    return { amount: collectable((order.codAmount ?? order.total).toString(), currency), currency };
  }
  if (order.codLocalAmount != null && order.codLocalCurrency) {
    const currency = order.codLocalCurrency.toUpperCase();
    return { amount: collectable(order.codLocalAmount.toString(), currency), currency };
  }
  return null;
}

/**
 * Our referenceNumber (the same id everywhere; INTEGRATION_NOTES §4.3): the Shopify order number as it is, with
 * the store's optional prefix ({PREFIX}-{number}); manual orders (no store) get "M-{number}".
 */
export function referenceFor(order: { number: string }, store: { vendorIdPrefix?: string | null } | null) {
  const n = order.number.replace(/^#/, "").trim();
  if (!store) return `M-${n}`;
  const p = store.vendorIdPrefix?.trim();
  return p ? `${p}-${n}` : n;
}

const isPdf = (b64: string) => {
  try {
    return Buffer.from(b64, "base64").subarray(0, 5).toString("latin1") === "%PDF-";
  } catch {
    return false;
  }
};

const block = (code: string, field: string, bg: string, en: string): Finding => ({
  code,
  severity: "block",
  field,
  message_bg: bg,
  message_en: en,
});

const warn = (code: string, field: string, bg: string, en: string): Finding => ({
  code,
  severity: "warn",
  field,
  message_bg: bg,
  message_en: en,
});

/**
 * Stock pre-flight (INTEGRATION_NOTES §4.3, §5): euShipments accepts an order only when the warehouse has the
 * stock. Hard block when Σqty of a product exceeds the last get-prod-avails snapshot minus CRM reservations,
 * or when there is no snapshot at all; a soft warning when the snapshot is older than the threshold.
 */
async function stockFindings(
  accountId: string,
  lines: { productId: string | null; quantity: number; title: string }[],
  vps: Map<string, { ref: string; vendorProductId: string }>,
  staleHours: number,
  now: Date,
): Promise<Finding[]> {
  const need = new Map<string, { qty: number; index: number; title: string }>();
  lines.forEach((l, index) => {
    const vp = l.productId ? vps.get(l.productId) : undefined;
    if (!vp) return; // product_not_mapped is reported already
    const prev = need.get(vp.vendorProductId);
    need.set(vp.vendorProductId, {
      qty: (prev?.qty ?? 0) + l.quantity,
      index: prev?.index ?? index,
      title: prev?.title ?? l.title,
    });
  });
  if (need.size === 0) return [];
  const levels = await accountDb(accountId).stockLevel.findMany({
    where: { vendorProductId: { in: [...need.keys()] } },
    select: { vendorProductId: true, free: true, reserved: true, snapshotAt: true },
  });
  const byVp = new Map(levels.map((l) => [l.vendorProductId, l]));
  const out: Finding[] = [];
  let oldest: Date | null = null;
  for (const [vpId, n] of need) {
    const field = `products[${n.index}].qty`;
    const level = byVp.get(vpId);
    if (!level) {
      out.push(
        block(
          "no_stock_snapshot",
          field,
          `Няма наличност от euShipments за „${n.title}“ (складът още не е синхронизиран).`,
          `No euShipments stock is known for "${n.title}" (the stock has not been synced yet).`,
        ),
      );
      continue;
    }
    const available = level.free - level.reserved;
    if (n.qty > available)
      out.push(
        block(
          "insufficient_stock",
          field,
          `„${n.title}“: нужни ${n.qty}, свободни ${Math.max(0, available)} в euShipments.`,
          `"${n.title}": ${n.qty} needed, ${Math.max(0, available)} free at euShipments.`,
        ),
      );
    if (!oldest || level.snapshotAt < oldest) oldest = level.snapshotAt;
  }
  if (oldest && now.getTime() - oldest.getTime() > staleHours * 3600_000) {
    const hours = Math.floor((now.getTime() - oldest.getTime()) / 3600_000);
    out.push(
      warn(
        "stock_snapshot_stale",
        "products",
        `Наличността от euShipments е отпреди ${hours} ч. (праг ${staleHours} ч.).`,
        `The euShipments stock snapshot is ${hours} h old (threshold ${staleHours} h).`,
      ),
    );
  }
  return out;
}

type EuPreflightOrder = Prisma.OrderGetPayload<{
  include: { lines: { include: { product: true } }; store: { select: { code: true; vendorIdPrefix: true } } };
}>;

/**
 * Every pre-flight finding for one order at one euShipments connection (mapping, weights, COD in local
 * currency, stock, the vendor validators) plus the built body. Reads only; no permission or scope check —
 * the callers do that (queueEuOrder, and the validator engine's preview via previewEuOrderFindings).
 */
/**
 * courierId / serviceName for one order: an explicit one from the caller, else the connection's default for the
 * destination country (Куриери → "Куриер по подразбиране"). When the account has SEVERAL couriers for the country
 * (couriers mirror) and none is chosen, euShipments refuses create-order ("Please provide a courier ID") — that is
 * caught here as a block before anything is sent. A chosen courier missing from a non-empty mirror is a block too.
 */
export async function courierFor(
  accountId: string,
  connectionId: string,
  country: string | null,
  input: { courierId?: number; serviceName?: (typeof SERVICE_NAMES)[number]; officeId?: number },
) {
  const db = accountDb(accountId);
  const findings: Finding[] = [];
  const preset = country
    ? await db.eushipmentsCountryCourier.findUnique({
        where: { accountId_connectionId_country: { accountId, connectionId, country } },
      })
    : null;
  const courierId = input.courierId ?? preset?.courierId ?? undefined;
  const presetService = (SERVICE_NAMES as readonly string[]).includes(preset?.serviceName ?? "")
    ? (preset!.serviceName as (typeof SERVICE_NAMES)[number])
    : undefined;
  const serviceName = input.serviceName ?? (input.courierId ? undefined : presetService);
  const mirror = await countryCouriers(accountId, connectionId, country);
  if (!courierId && mirror.length > 1)
    findings.push(
      block(
        "courier_choice_missing",
        "courierId",
        `За ${country} има ${mirror.length} куриера в euShipments — изберете куриер по подразбиране (Складове → euShipments → Куриери).`,
        `There are ${mirror.length} euShipments couriers for ${country} — choose a default courier (Warehouses → euShipments → Couriers).`,
      ),
    );
  if (courierId) {
    const all = await db.eushipmentsCourier.count({ where: { connectionId } });
    const known = await db.eushipmentsCourier.findFirst({ where: { connectionId, courierId } });
    if (known && mirror.length && !mirror.some((c) => c.courierId === courierId))
      findings.push(
        block(
          "courier_wrong_country",
          "courierId",
          `Куриер „${known.name}“ не работи в ${country} — изберете куриер за тази държава.`,
          `The courier "${known.name}" does not serve ${country} — choose a courier for this country.`,
        ),
      );
    if (known && !known.toAddress && !input.officeId)
      findings.push(
        block(
          "courier_office_only",
          "courierId",
          `Куриер „${known.name}“ доставя само до офис, а поръчката е до адрес.`,
          `The courier "${known.name}" delivers to offices only, and this order goes to an address.`,
        ),
      );
    if (all > 0 && !known)
      findings.push(
        block(
          "courier_unknown",
          "courierId",
          `Куриер ${courierId} не е сред куриерите на тази връзка — изберете друг.`,
          `Courier ${courierId} is not one of this connection's couriers — choose another one.`,
        ),
      );
  }
  return { courierId, serviceName, findings };
}

/**
 * Couriers of the mirror that serve an ISO country: the couriers web service names the country ("Greece"), the
 * countries mirror maps it to ISO. Unknown mapping → [] (nothing is assumed).
 */
export async function countryCouriers(accountId: string, connectionId: string, iso: string | null) {
  if (!iso) return [];
  const db = accountDb(accountId);
  const countries = await db.eushipmentsCountry.findMany({
    where: { connectionId, isoCode: { equals: iso, mode: "insensitive" } },
    select: { name: true, cyrillicName: true },
  });
  const names = countries
    .flatMap((c) => [c.name, c.cyrillicName])
    .filter((n): n is string => !!n)
    .map((n) => n.trim().toLowerCase());
  if (!names.length) return [];
  const couriers = await db.eushipmentsCourier.findMany({
    where: { connectionId },
    orderBy: { name: "asc" },
  });
  return couriers.filter((c) => !!c.country && names.includes(c.country.trim().toLowerCase()));
}

async function euOrderPreflight(
  accountId: string,
  connection: { id: string },
  companyId: number,
  order: EuPreflightOrder,
  input: z.output<typeof QueueOrderInput>,
  now: Date,
) {
  const db = accountDb(accountId);
  const reference = await reshipReference(
    db,
    connection.id,
    order.id,
    referenceFor(order, order.store ?? null),
  );
  const findings: Finding[] = [];

  // Two stores without a prefix can both have #1001: name the clash before the (connectionId, externalId) unique
  // index refuses it.
  const clash = await db.fulfillment.findFirst({
    where: { connectionId: connection.id, externalId: reference, orderId: { not: order.id } },
    select: { order: { select: { number: true } } },
  });
  if (clash)
    findings.push(
      block(
        "reference_taken",
        "awb.referenceNumber",
        `Номерът ${reference} вече е използван към този склад от поръчка ${clash.order.number} (друг магазин). Задайте „Префикс към склада“ на един от магазините.`,
        `The reference ${reference} is already used at this warehouse by order ${clash.order.number} (another store). Set a "warehouse prefix" on one of the stores.`,
      ),
    );

  // Never ship a Shopify order as prepaid while money is still owed (custom local-language COD gateways).
  const unclear = paymentUnclear({
    paymentMethod: order.paymentMethod,
    currency: order.currency,
    // A person's manual COD (OrderCodOverride) decides the payment instead of Shopify's facts.
    shopifyPayment:
      order.source === "SHOPIFY" &&
      !(await db.orderCodOverride.findUnique({
        where: { accountId_orderId: { accountId, orderId: order.id } },
      }))
        ? shopifyPaymentOf(order.raw)
        : null,
  });
  if (unclear) findings.push(block("payment_unclear", "awb.bankRepayment", unclear.bg, unclear.en));
  const lines = order.lines.filter((l) => l.quantity > 0);
  if (!lines.length)
    findings.push(block("no_lines", "products", "Поръчката няма редове.", "The order has no lines."));
  const vps = await vendorProductsFor(
    accountId,
    connection.id,
    lines.map((l) => l.productId).filter((p): p is string => !!p),
  );
  const refs = new Map([...vps].map(([k, v]) => [k, v.ref]));
  for (const l of lines) {
    if (!l.productId || !refs.has(l.productId))
      findings.push(
        block(
          "product_not_mapped",
          "products",
          `„${l.title}“ няма продукт в euShipments за тази връзка.`,
          `"${l.title}" has no euShipments product on this connection.`,
        ),
      );
  }
  // One finding per product without a weight, so the order screen can offer "Въведи тегло" per line. The
  // weight lives on the master product (Продукти) and applies to every order.
  const missingWeight = new Map<string, string>();
  for (const l of lines)
    if (!l.product?.weightGrams) missingWeight.set(l.productId ?? `line:${l.id}`, l.product?.name ?? l.title);
  for (const [key, name] of missingWeight)
    findings.push(
      block(
        "weight_missing",
        key.startsWith("line:") ? "awb.totalWeight" : `product:${key}.weightGrams`,
        `Липсва тегло на продукт „${name}“.`,
        `The product "${name}" has no weight.`,
      ),
    );

  const destination =
    ((order.shippingAddress ?? {}) as Record<string, string | null>).countryCode?.toUpperCase() ??
    order.countryCode?.toUpperCase() ??
    null;
  const countrySetting = destination
    ? await db.countrySetting.findUnique({
        where: { accountId_country: { accountId, country: destination } },
      })
    : null;

  const cod = order.paymentMethod === "COD";
  // COD goes in the destination's local currency (CLAUDE.md). Same currency as the order: the COD itself;
  // otherwise only a stored local amount in that currency — never a made-up conversion (same rule as FHB).
  const localCurrency = localCurrencyFor(countrySetting, destination);
  const local = cod ? localCod(order, localCurrency) : null;
  if (cod && !local)
    findings.push(
      block(
        "cod_local_missing",
        "awb.bankRepayment",
        localCurrency
          ? `Наложеният платеж е в ${order.currency}, а не е изчислен в местната валута ${localCurrency}.`
          : `Няма настройка за държавата ${destination ?? "?"} (местна валута) — Настройки → Държави.`,
        localCurrency
          ? `The COD is in ${order.currency} and has no amount in the local currency ${localCurrency}.`
          : `No setting (local currency) for the country ${destination ?? "?"} — Settings → Countries.`,
      ),
    );
  if (local && localCurrency && local.currency !== localCurrency)
    findings.push(
      block(
        "cod_currency_mismatch",
        "awb.bankRepayment",
        `Наложеният платеж е в ${local.currency}, а държавата е в ${localCurrency}.`,
        `The COD is in ${local.currency} but the country uses ${localCurrency}.`,
      ),
    );
  if (input.invoicePdfBase64 && !isPdf(input.invoicePdfBase64))
    findings.push(
      block("invoice_not_pdf", "invoice", "Фактурата не е PDF файл.", "The invoice is not a PDF file."),
    );

  const settings = await db.eushipmentsSettings.findUnique({
    where: { accountId_connectionId: { accountId: accountId, connectionId: connection.id } },
  });
  findings.push(
    ...(await stockFindings(
      accountId,
      lines,
      vps,
      settings?.stockStaleHours ?? DEFAULT_STOCK_STALE_HOURS,
      now,
    )),
  );
  const cashReceiptCod = settings?.cashReceiptCod ?? false;
  const today = sofiaToday(now);
  let courier = await courierFor(accountId, connection.id, destination, input);
  // To a Speedy office (BG): the order's choice, or an "Office Speedy [id] NAME: …" address matched to ONE office.
  const office = input.officeId
    ? null
    : await resolveDeliveryOffice(accountId, connection.id, courier.courierId, order);
  const officeId = input.officeId ?? (office?.kind === "office" ? office.officeId : undefined);
  // No courier for the country, and a person picked an office: its courier is the order's courier — checked like
  // a chosen one (unknown / wrong country / office-only), never "choose a courier".
  if (!courier.courierId && office?.kind === "office")
    courier = await courierFor(accountId, connection.id, destination, {
      ...input,
      courierId: office.courierId,
      officeId: office.officeId,
    });
  findings.push(...courier.findings.filter((f) => !(officeId && f.code === "courier_office_only")));
  if (office?.kind === "unresolved" && office.reason === "address_is_office")
    findings.push(
      block(
        "office_address_as_street",
        "recipient.streetName",
        `Избрано е „До адрес“, но адресът е офис на Speedy („${office.search}“) — поправете адреса или изберете офиса в „Доставка“.`,
        `"To address" is chosen but the address is a Speedy office ("${office.search}") — fix the address or choose the office under "Delivery".`,
      ),
    );
  else if (office?.kind === "unresolved")
    findings.push(
      block(
        "office_unresolved",
        "recipient.officeId",
        `Адресът е офис на Speedy („${office.search}“), но не е намерен точно един офис в списъка на склада — изберете офиса в „Доставка“.`,
        `The address is a Speedy office ("${office.search}") but not exactly one office of the warehouse's list matches — choose the office under "Delivery".`,
      ),
    );
  const built = buildCreateOrder({
    referenceNumber: reference,
    senderId: companyId,
    waybillAvailableDate: input.waybillAvailableDate ?? today,
    courierId: courier.courierId,
    serviceName: courier.serviceName,
    officeId,
    shipmentPayer: input.shipmentPayer,
    address: (order.shippingAddress ?? {}) as Record<string, string | null>,
    phone: order.phone,
    phoneRule: customPhoneRule(countrySetting?.phoneRules),
    email: order.email,
    codLocal: local ? local.amount : null,
    lines: lines.map((l) => ({
      refNumber: (l.productId && refs.get(l.productId)) || l.sku || "?",
      qty: l.quantity,
      unitPrice: l.unitPrice.toString(),
    })),
    totalWeightKg: lines.reduce((a, l) => a + (l.product?.weightGrams ?? 0) * l.quantity, 0) / 1000,
    cashReceiptCod,
  });
  findings.push(...validateEuOrder(built, { cashReceiptCod, today }));

  return { reference, findings, built, lines };
}

/**
 * The findings queueEuOrder would report for this order, without queueing anything (P4-01 validator engine).
 * A connection without an euShipments companyId reports that as a block.
 */
export async function previewEuOrderFindings(
  accountId: string,
  raw: z.input<typeof QueueOrderInput>,
  now: Date = new Date(),
): Promise<Finding[]> {
  const input = QueueOrderInput.parse(raw);
  const { connection, companyId } = await loadEuConnection(accountId, input.connectionId);
  if (!companyId)
    return [
      block(
        "no_company_id",
        "senderId",
        "Връзката няма euShipments фирма (companyId).",
        "The connection has no euShipments company (companyId).",
      ),
    ];
  const order = await accountDb(accountId).order.findUnique({
    where: { id: input.orderId },
    include: {
      lines: { include: { product: true } },
      store: { select: { code: true, vendorIdPrefix: true } },
    },
  });
  if (!order) throw new DomainError("not_found");
  return (await euOrderPreflight(accountId, connection, companyId, order, input, now)).findings;
}

/**
 * The create-order body queueEuOrder would send for this order now (P4-04 payload preview): built by the same
 * pre-flight, nothing queued, no vendor call. Null when the connection has no euShipments companyId.
 */
export async function previewEuOrderPayload(
  accountId: string,
  raw: z.input<typeof QueueOrderInput>,
  now: Date = new Date(),
) {
  const input = QueueOrderInput.parse(raw);
  const { connection, companyId } = await loadEuConnection(accountId, input.connectionId);
  if (!companyId) return null;
  const order = await accountDb(accountId).order.findUnique({
    where: { id: input.orderId },
    include: {
      lines: { include: { product: true } },
      store: { select: { code: true, vendorIdPrefix: true } },
    },
  });
  if (!order) throw new DomainError("not_found");
  return (await euOrderPreflight(accountId, connection, companyId, order, input, now)).built.body;
}

export async function queueEuOrder(
  actor: ScopedActor,
  raw: z.input<typeof QueueOrderInput>,
  now: Date = new Date(),
): Promise<QueueOrderResult> {
  assertCan(actor.role, "orders.fulfill");
  const input = QueueOrderInput.parse(raw);
  const { connection, companyId } = await euConnectionFor(actor, input.connectionId);
  const db = accountDb(actor.accountId);
  const order = await db.order.findUnique({
    where: { id: input.orderId },
    include: {
      lines: { include: { product: true } },
      store: { select: { code: true, vendorIdPrefix: true } },
    },
  });
  if (!order || (actor.companyScope && (!order.companyId || !actor.companyScope.includes(order.companyId))))
    throw new DomainError("not_found");
  if (await isLabelOnly(db, order.id)) throw new DomainError("label_only_order");
  const { reference, findings, built, lines } = await euOrderPreflight(
    actor.accountId,
    connection,
    companyId,
    order,
    input,
    now,
  );
  if (hasBlocks(findings)) return { status: "blocked", findings };
  const unacked = findings.filter((f) => f.severity === "warn" && !input.acknowledged.includes(f.code));
  if (unacked.length) return { status: "needs_ack", findings };

  const run = () =>
    withAccountTransaction(actor.accountId, async (tx, { lockKey, lockForUpdate }) => {
      await lockKey(`eushipments:order:${connection.id}:${reference}`);
      const existing = await tx.fulfillment.findUnique({
        where: { connectionId_externalId: { connectionId: connection.id, externalId: reference } },
      });
      if (existing) {
        // Queued again only when nothing can exist at the vendor: our side is still before submission AND the
        // outbox request never left (dry run, refused by the mode gate / disabled connection, or a definite
        // rejection). Anything in flight, sent or uncertain stays a duplicate.
        const req = await tx.outboundRequest.findUnique({
          where: {
            connectionId_idempotencyKey: {
              connectionId: connection.id,
              idempotencyKey: `order:${reference}`,
            },
          },
          select: { status: true },
        });
        const ourSideOpen = existing.status === "QUEUED" || existing.status === "SUBMIT_FAILED";
        if (!ourSideOpen || (req && !REARMABLE_REQUEST.has(req.status)))
          throw new DomainError("duplicate_reference");
      }
      // The pipeline is the gate: only an APPROVED / SUBMIT_FAILED order is queued (strict, before anything is
      // written). The order row lock serialises this with a concurrent cancel, hold or check.
      await lockForUpdate("Order", order.id);
      await queueGate(tx, {
        orderId: order.id,
        userId: actor.userId,
        source: "eushipments.queue",
        connectionId: connection.id,
        rearmQueued: existing?.status === "QUEUED",
      });
      // The courier this shipment is created with (Shopify gets its name with the tracking number).
      const sentCourierId = (built.body as { courierId?: number }).courierId;
      // The office the body goes to (chosen, or recognised from a Speedy office address).
      const sentOfficeId =
        (built.body as { recipient?: { officeId?: number | null } }).recipient?.officeId ?? null;
      const carrier = sentCourierId
        ? ((
            await tx.eushipmentsCourier.findFirst({
              where: { connectionId: connection.id, courierId: sentCourierId },
              select: { name: true },
            })
          )?.name ?? null)
        : null;
      let fulfillment: Fulfillment;
      if (existing) {
        fulfillment = await tx.fulfillment.update({
          where: { id: existing.id },
          data: {
            status: "QUEUED",
            carrier,
            deliveryPoint: sentOfficeId ? { officeId: sentOfficeId } : Prisma.DbNull,
          },
        });
        // The order may have been edited since: the shipment's lines follow the body being queued now.
        await tx.fulfillmentLine.deleteMany({ where: { fulfillmentId: existing.id } });
        await tx.fulfillmentLine.createMany({
          data: lines.map((l) => ({
            accountId: actor.accountId,
            fulfillmentId: existing.id,
            orderLineId: l.id,
            quantity: l.quantity,
          })),
        });
      } else {
        fulfillment = await tx.fulfillment.create({
          data: {
            accountId: actor.accountId,
            orderId: order.id,
            connectionId: connection.id,
            externalId: reference,
            status: "QUEUED",
            carrier,
            deliveryPoint: sentOfficeId ? { officeId: sentOfficeId } : undefined,
          },
        });
        await tx.fulfillmentLine.createMany({
          data: lines.map((l) => ({
            accountId: actor.accountId,
            fulfillmentId: fulfillment.id,
            orderLineId: l.id,
            quantity: l.quantity,
          })),
        });
      }
      const { request } = await enqueueOutboundInTx(tx, {
        accountId: actor.accountId,
        connectionId: connection.id,
        operation: EU_OPS.createOrder,
        idempotencyKey: `order:${reference}`,
        payload: json({
          body: built.body,
          ctx: {
            fulfillmentId: fulfillment.id,
            referenceNumber: reference,
            ...(input.invoicePdfBase64 ? { invoicePdfBase64: input.invoicePdfBase64 } : {}),
          },
        }),
        fulfillmentId: fulfillment.id,
        createdById: actor.userId,
      });
      return { fulfillment, request };
    });
  let res;
  try {
    res = await run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("duplicate_reference");
    throw err;
  }
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "eushipments.order_queued",
    entityType: "Order",
    entityId: order.id,
    after: {
      connectionId: connection.id,
      referenceNumber: reference,
      fulfillmentId: res.fulfillment.id,
      requestId: res.request.id,
      acknowledged: input.acknowledged,
    },
  });
  return {
    status: "queued",
    findings,
    fulfillmentId: res.fulfillment.id,
    requestId: res.request.id,
    referenceNumber: reference,
  };
}

/** Deletable only in New / Information received / Awaiting pickup and within 14 days (spec). */
const DELETABLE = new Set(["new", "information received", "awaiting pickup"]);
const DELETE_MAX_AGE_MS = 14 * 24 * 3600_000;

/** Can euShipments still delete this shipment (status and the 14-day window, INTEGRATION_NOTES §4.3)? */
export function isEuOrderDeletable(
  f: { rawStatus: string | null; status: string; submittedAt: Date | null; createdAt: Date },
  now: Date = new Date(),
) {
  const statusOk = f.rawStatus ? DELETABLE.has(normaliseStatusText(f.rawStatus)) : f.status === "ACCEPTED";
  const since = f.submittedAt ?? f.createdAt;
  return statusOk && now.getTime() - since.getTime() <= DELETE_MAX_AGE_MS;
}

export async function queueEuOrderDeletion(
  actor: ScopedActor,
  fulfillmentId: string,
  now: Date = new Date(),
) {
  assertCan(actor.role, "orders.fulfill");
  const db = accountDb(actor.accountId);
  const f = await db.fulfillment.findUnique({ where: { id: fulfillmentId }, include: { order: true } });
  if (!f || (actor.companyScope && (!f.order.companyId || !actor.companyScope.includes(f.order.companyId))))
    throw new DomainError("not_found");
  await euConnectionFor(actor, f.connectionId);
  if (!isEuOrderDeletable(f, now)) throw new DomainError("not_deletable");
  const { request, created } = await enqueueOutbound({
    accountId: actor.accountId,
    connectionId: f.connectionId,
    operation: EU_OPS.deleteOrder,
    idempotencyKey: `delete:${f.externalId}`,
    payload: json({ body: {}, ctx: { fulfillmentId: f.id, referenceNumber: f.externalId } }),
    fulfillmentId: f.id,
    createdById: actor.userId,
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "eushipments.order_delete_queued",
    entityType: "Fulfillment",
    entityId: f.id,
    after: { referenceNumber: f.externalId, requestId: request.id },
  });
  return { request, created };
}

// ───────────────────────── booking requests ─────────────────────────

export const QueueBookingInput = z.object({
  connectionId: z.string().min(1),
  warehouseId: z.number().int().positive(),
  /** Our inbound document number: deterministic id, unique per connection, sent as clientReference. */
  documentNumber: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[\x20-\x7E]+$/, "printable ASCII only"),
  deliveryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  courierInc: z.string().trim().max(50).optional(),
  trackNumb: z.string().trim().max(50).optional(),
  packagesCount: z.number().int().min(1).optional(),
  lines: z.array(z.object({ productId: z.string().min(1), quantity: z.number().int().min(1) })).min(1),
});

/**
 * Booking request. euShipments has no idempotency and no lookup for these: the outbox never retries an
 * unknown outcome — it becomes UNCERTAIN with an operator task, and the inbound is marked UNCERTAIN.
 */
export async function queueEuBooking(actor: ScopedActor, raw: z.input<typeof QueueBookingInput>) {
  assertCan(actor.role, "inbound.manage");
  const input = QueueBookingInput.parse(raw);
  const { connection, companyId } = await euConnectionFor(actor, input.connectionId);
  const refs = await refNumbersFor(
    actor.accountId,
    connection.id,
    input.lines.map((l) => l.productId),
  );
  const missing = input.lines.filter((l) => !refs.has(l.productId));
  if (missing.length) throw new DomainError("product_not_mapped");
  const body = CreateRequestBody.safeParse(
    buildCreateRequest({
      companyId,
      warehouseId: input.warehouseId,
      clientReference: input.documentNumber,
      deliveryDate: input.deliveryDate,
      courierInc: input.courierInc,
      trackNumb: input.trackNumb,
      packagesCount: input.packagesCount,
      products: input.lines.map((l) => ({ refNumber: refs.get(l.productId)!, quantity: l.quantity })),
    }),
  );
  if (!body.success) throw new DomainError("invalid_booking", body.error.issues[0]?.message);

  const lineRows = input.lines.map((l) => ({ productId: l.productId, expectedQty: l.quantity }));
  let res;
  try {
    res = await withAccountTransaction(actor.accountId, async (tx, { lockKey }) => {
      await lockKey(`eushipments:booking:${connection.id}:${input.documentNumber}`);
      const existing = await tx.inboundShipment.findUnique({
        where: {
          connectionId_externalRef: { connectionId: connection.id, externalRef: input.documentNumber },
        },
      });
      let inbound;
      if (existing) {
        // Same document number again: only when the booking never reached euShipments (dry run, refused by the
        // mode gate, or a definite rejection). There is no read-back for bookings, so anything else stays a
        // duplicate — never a second booking request.
        const req = await tx.outboundRequest.findUnique({
          where: {
            connectionId_idempotencyKey: {
              connectionId: connection.id,
              idempotencyKey: `booking:${existing.id}`,
            },
          },
          select: { status: true },
        });
        const ourSideOpen =
          !existing.vendorId && (existing.status === "QUEUED" || existing.status === "FAILED");
        if (!ourSideOpen || !req || !REARMABLE_REQUEST.has(req.status))
          throw new DomainError("duplicate_reference");
        await tx.inboundLine.deleteMany({ where: { inboundId: existing.id } });
        inbound = await tx.inboundShipment.update({
          where: { id: existing.id },
          data: {
            status: "QUEUED",
            tracking: input.trackNumb ?? null,
            expectedAt: input.deliveryDate ? new Date(`${input.deliveryDate}T00:00:00Z`) : null,
            raw: Prisma.DbNull,
            lines: { create: lineRows },
          },
        });
      } else {
        inbound = await tx.inboundShipment.create({
          data: {
            accountId: actor.accountId,
            connectionId: connection.id,
            externalRef: input.documentNumber,
            status: "QUEUED",
            tracking: input.trackNumb ?? null,
            expectedAt: input.deliveryDate ? new Date(`${input.deliveryDate}T00:00:00Z`) : null,
            lines: { create: lineRows },
          },
        });
      }
      const { request } = await enqueueOutboundInTx(tx, {
        accountId: actor.accountId,
        connectionId: connection.id,
        operation: EU_OPS.createRequest,
        idempotencyKey: `booking:${inbound.id}`,
        payload: json({ body: body.data, ctx: { inboundId: inbound.id } }),
        createdById: actor.userId,
      });
      return { inbound, request };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("duplicate_reference");
    throw err;
  }
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "eushipments.booking_queued",
    entityType: "InboundShipment",
    entityId: res.inbound.id,
    after: { documentNumber: input.documentNumber, requestId: res.request.id },
  });
  return res;
}

// ───────────────────────── transfers ─────────────────────────

export const QueueTransferInput = z.object({
  connectionId: z.string().min(1),
  /**
   * The caller's idempotency key for this transfer (a form nonce generated when the form is rendered, or the
   * CRM transfer document id): the same key always means the same protocol, so a double click or a retried
   * action returns the existing transfer instead of creating a second one (a scrap would remove stock twice).
   */
  requestKey: z.string().uuid(),
  sourceWarehouseId: z.number().int().positive(),
  destinationWarehouseId: z.number().int().positive().optional(),
  protocolType: z.union([z.literal(1), z.literal(3)]).default(1),
  comments: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().int().min(1),
        batchNo: z.string().trim().min(1).optional(),
        batchDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
    )
    .min(1),
});

/**
 * Transfer / scrap protocol. The row id is the caller's requestKey, and externalRef is derived from it, so one
 * user intent is one protocol: resends to the vendor are answered 409 + the same protocol, and a repeated call
 * here returns the existing row and request (re-armed only if nothing was created at the vendor).
 */
export async function queueEuTransfer(actor: ScopedActor, raw: z.input<typeof QueueTransferInput>) {
  assertCan(actor.role, "stock.manage");
  const input = QueueTransferInput.parse(raw);
  const { connection, companyId } = await euConnectionFor(actor, input.connectionId);
  const refs = await refNumbersFor(
    actor.accountId,
    connection.id,
    input.lines.map((l) => l.productId),
  );
  if (input.lines.some((l) => !refs.has(l.productId))) throw new DomainError("product_not_mapped");
  const transferId = input.requestKey;
  const body = CreateTransferBody.safeParse(
    buildCreateTransfer({
      companyId,
      transferId,
      sourceWarehouseId: input.sourceWarehouseId,
      destinationWarehouseId: input.destinationWarehouseId,
      protocolType: input.protocolType,
      comments: input.comments,
      items: input.lines.map((l) => ({
        refNumber: refs.get(l.productId)!,
        quantity: l.quantity,
        batchNo: l.batchNo,
        batchDate: l.batchDate,
      })),
    }),
  );
  if (!body.success) throw new DomainError("invalid_transfer", body.error.issues[0]?.message);
  const run = () =>
    withAccountTransaction(actor.accountId, async (tx, { lockKey }) => {
      await lockKey(`eushipments:transfer:${transferId}`);
      const existing = await tx.eushipmentsTransfer.findUnique({ where: { id: transferId } });
      if (existing && existing.connectionId !== connection.id) throw new DomainError("duplicate_reference");
      const transfer =
        existing ??
        (await tx.eushipmentsTransfer.create({
          data: {
            id: transferId,
            accountId: actor.accountId,
            connectionId: connection.id,
            externalRef: body.data.externalRef,
            sourceWarehouseId: input.sourceWarehouseId,
            destinationWarehouseId: input.destinationWarehouseId ?? null,
            protocolType: input.protocolType,
            items: json(input.lines.map((l) => ({ ...l, refNumber: refs.get(l.productId) }))),
            comments: input.comments ?? null,
            createdById: actor.userId,
          },
        }));
      // An existing request is returned as is (in flight / sent / uncertain), or re-armed when nothing was created.
      const { request, created } = await enqueueOutboundInTx(tx, {
        accountId: actor.accountId,
        connectionId: connection.id,
        operation: EU_OPS.createTransfer,
        idempotencyKey: `transfer:${body.data.externalRef}`,
        payload: json({ body: body.data, ctx: { transferId } }),
        createdById: actor.userId,
      });
      if (existing && created)
        await tx.eushipmentsTransfer.update({
          where: { id: existing.id },
          data: {
            status: "QUEUED",
            sourceWarehouseId: input.sourceWarehouseId,
            destinationWarehouseId: input.destinationWarehouseId ?? null,
            protocolType: input.protocolType,
            items: json(input.lines.map((l) => ({ ...l, refNumber: refs.get(l.productId) }))),
            comments: input.comments ?? null,
          },
        });
      return { transfer, request, created };
    });
  let res;
  try {
    res = await run();
  } catch (err) {
    // A concurrent call with the same key lost the race on the primary key: the second run finds the winner.
    if (!isUniqueViolation(err)) throw err;
    try {
      res = await run();
    } catch (again) {
      if (isUniqueViolation(again)) throw new DomainError("duplicate_reference");
      throw again;
    }
  }
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "eushipments.transfer_queued",
    entityType: "EushipmentsTransfer",
    entityId: transferId,
    after: { externalRef: body.data.externalRef, requestId: res.request.id },
  });
  return res;
}
