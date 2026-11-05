import { normalisePhoneE164 } from "@/integrations/fhb-v3/phone";
import { SHOPIFY_TEST_TAG } from "@/server/pipeline";
import type { RoutingDecision, StockCheck } from "@/server/routing";
import type { Finding } from "./findings";

/**
 * Order-level pre-flight checks (P4-01): what must hold whichever warehouse ships the order. Pure — the
 * caller loads the order, its country setting, the routing decision and possible duplicates. Vendor-specific
 * rules stay in the vendor validators (src/integrations/<vendor>/validators.ts).
 */

export interface CheckAddress {
  name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  zip?: string | null;
  countryCode?: string | null;
  phone?: string | null;
}

export interface CheckOrder {
  number: string;
  customerName: string | null;
  email: string | null;
  phone: string | null;
  shippingAddress: CheckAddress | null;
  countryCode: string | null;
  currency: string;
  total: number;
  paymentMethod: "COD" | "PREPAID";
  codAmount: number | null;
  codLocalAmount: number | null;
  codLocalCurrency: string | null;
  tags: string[];
  /**
   * Shopify payment facts (Shopify orders only): the gateways used and the amount still owed. A PREPAID order with
   * money still owed is never shipped as prepaid — either the gateway is a COD method the store has not listed
   * (custom, local-language names) or the customer has not paid yet.
   */
  shopifyPayment?: { gateways: string[]; outstanding: number | null } | null;
  /** A person set the COD by hand (OrderCodOverride): it decides; a difference to Shopify is only shown. */
  codManual?: boolean;
  lines: {
    title: string;
    sku: string | null;
    productId: string | null;
    quantity: number;
    /** "Съмнителни връзки": the line's store variant (or the shipping warehouse's product) names another product. */
    suspiciousLink?: boolean;
  }[];
}

/**
 * A PREPAID order with money still owed in Shopify: never shipped as prepaid (a COD gateway the store has not listed,
 * or not paid yet). Shared by the order checks and the warehouse pre-flights (the last line before a send).
 */
export function paymentUnclear(o: {
  paymentMethod: string;
  currency: string;
  shopifyPayment?: { gateways: string[]; outstanding: number | null } | null;
}): { bg: string; en: string } | null {
  const owed = o.shopifyPayment?.outstanding ?? 0;
  if (o.paymentMethod !== "PREPAID" || owed <= 0.005) return null;
  const names = o.shopifyPayment!.gateways.map((g) => `„${g}“`).join(", ") || "—";
  return {
    bg: `Записана е като предплатена, но в Shopify има неплатени ${owed.toFixed(2)} ${o.currency} (метод: ${names}). Ако е наложен платеж — отбележете метода като наложен платеж за магазина; ако клиентът още не е платил — изчакайте плащането.`,
    en: `Recorded as prepaid, but Shopify shows ${owed.toFixed(2)} ${o.currency} still owed (method: ${names}). If it is cash on delivery, mark the method as COD for the store; if the customer has not paid yet, wait for the payment.`,
  };
}

export interface OrderCheckContext {
  /** CountrySetting.currency for the destination; null = not configured. */
  localCurrency: string | null;
  /** The group's own phone rule for the destination (CountrySetting.phoneRules); only used by the E.164
   *  conversion for a country the built-in calling-code table lacks. */
  phoneRule?: { cc: string; trunk: string } | null;
  routing: RoutingDecision;
  /** Stock at the connection that will ship (the routed one, or the operator's choice). */
  stock: StockCheck | null;
  /** Other live orders that look like the same purchase (same email/phone and total, close in time). */
  duplicates: { number: string }[];
}

export interface OrderCheckOutput {
  findings: Finding[];
  /** What the senders will use instead of the stored value (shown as original → corrected). */
  normalised: { phone: string | null; country: string | null };
}

const blank = (v: string | null | undefined) => !v || !v.trim();

const f = (
  code: string,
  severity: Finding["severity"],
  field: string | null,
  message_bg: string,
  message_en: string,
  suggestedFix?: Finding["suggestedFix"],
  source: Finding["source"] = "order",
): Finding => ({
  code,
  severity,
  source,
  field,
  message_bg,
  message_en,
  ...(suggestedFix ? { suggestedFix } : {}),
});

export function orderLevelFindings(o: CheckOrder, ctx: OrderCheckContext): OrderCheckOutput {
  const out: Finding[] = [];
  const addr = o.shippingAddress ?? {};
  const country = (addr.countryCode ?? o.countryCode ?? "").trim().toUpperCase() || null;

  // Safety first: Shopify test orders never reach a warehouse.
  if (o.tags.includes(SHOPIFY_TEST_TAG))
    out.push(
      f(
        "order.test_order",
        "hard",
        null,
        "Тестова поръчка от Shopify — не се изпраща към склад.",
        "Shopify test order — never sent to a warehouse.",
      ),
    );

  // Lines and product mapping.
  const lines = o.lines.filter((l) => l.quantity > 0);
  if (!lines.length)
    out.push(f("order.no_lines", "hard", "lines", "Поръчката няма редове.", "The order has no lines."));
  o.lines.forEach((l, i) => {
    if (l.quantity > 0 && !l.productId)
      out.push(
        f(
          "order.line_unmatched",
          "hard",
          `lines[${i}].product`,
          `„${l.sku ?? l.title}“ не е свързан с продукт (опашка „Несвързани“).`,
          `"${l.sku ?? l.title}" is not linked to a product (see the unmatched queue).`,
        ),
      );
  });

  // A link whose names disagree (SKU reused for another product): a person must look — never a hard block.
  o.lines.forEach((l, i) => {
    if (l.quantity > 0 && l.productId && l.suspiciousLink)
      out.push(
        f(
          "order.line_name_mismatch",
          "soft",
          `lines[${i}].product`,
          `„${l.sku ?? l.title}“: Името в магазина и в склада се различават — проверете връзката.`,
          `"${l.sku ?? l.title}": The store and warehouse names differ — check the link.`,
        ),
      );
  });

  // Address completeness.
  if (blank(addr.name)) {
    if (!blank(o.customerName))
      out.push(
        f(
          "order.address.name_missing",
          "soft",
          "shippingAddress.name",
          "В адреса липсва име — ще се използва името на клиента.",
          "The address has no name — the customer name will be used.",
          { field: "shippingAddress.name", value: o.customerName!.trim() },
        ),
      );
    else
      out.push(
        f(
          "order.address.name_missing",
          "hard",
          "shippingAddress.name",
          "Липсва име на получателя.",
          "The recipient name is missing.",
        ),
      );
  }
  const required: [keyof CheckAddress, string, string][] = [
    ["address1", "Липсва адрес (улица).", "The street address is missing."],
    ["city", "Липсва град.", "The city is missing."],
    ["zip", "Липсва пощенски код.", "The postal code is missing."],
  ];
  for (const [key, bg, en] of required)
    if (blank(addr[key]))
      out.push(f(`order.address.${key}_missing`, "hard", `shippingAddress.${key}`, bg, en));
  if (!country || !/^[A-Z]{2}$/.test(country))
    out.push(
      f(
        "order.address.country_invalid",
        "hard",
        "shippingAddress.countryCode",
        "Липсва или е невалидна държава.",
        "The country is missing or invalid.",
      ),
    );

  // Phone: must be convertible to E.164 for the destination (vendors get the normalised form).
  const rawPhone = o.phone ?? addr.phone ?? null;
  const phone = normalisePhoneE164(rawPhone, country, ctx.phoneRule);
  if (blank(rawPhone))
    out.push(
      f(
        "order.phone_missing",
        "hard",
        "phone",
        "Липсва телефон на получателя.",
        "The recipient phone is missing.",
      ),
    );
  else if (!phone)
    out.push(
      f(
        "order.phone_invalid",
        "hard",
        "phone",
        `Телефонът „${rawPhone}“ не може да се превърне в международен формат за ${country ?? "държавата"}.`,
        `The phone "${rawPhone}" cannot be converted to international format for ${country ?? "the country"}.`,
      ),
    );
  if (blank(o.email))
    out.push(
      f("order.email_missing", "soft", "email", "Липсва имейл на клиента.", "The customer email is missing."),
    );

  // COD: amount known, not above the total, in the destination's local currency (CLAUDE.md).
  const unclear = o.codManual ? null : paymentUnclear(o);
  const owedNow = o.shopifyPayment?.outstanding;
  if (
    o.codManual &&
    owedNow != null &&
    Math.abs(owedNow - (o.paymentMethod === "COD" ? (o.codAmount ?? 0) : 0)) > 0.005
  ) {
    const manual = o.paymentMethod === "COD" ? (o.codAmount ?? 0).toFixed(2) : "0.00";
    out.push(
      f(
        "order.cod_manual_differs",
        "soft",
        "codAmount",
        `Наложеният платеж е променен ръчно на ${manual} ${o.currency}, а в Shopify неплатената сума е ${owedNow.toFixed(2)} ${o.currency}.`,
        `The COD was changed by hand to ${manual} ${o.currency}; Shopify shows ${owedNow.toFixed(2)} ${o.currency} still owed.`,
      ),
    );
  }
  if (unclear) out.push(f("order.payment_unclear", "hard", "paymentMethod", unclear.bg, unclear.en));
  if (o.paymentMethod === "COD") {
    if (o.codAmount == null || o.codAmount <= 0)
      out.push(
        f(
          "order.cod_amount_missing",
          "hard",
          "codAmount",
          "Наложеният платеж няма сума.",
          "The cash-on-delivery amount is missing.",
          o.total > 0 ? { field: "codAmount", value: o.total.toFixed(2) } : undefined,
        ),
      );
    else if (o.codAmount > o.total + 0.005)
      out.push(
        f(
          "order.cod_exceeds_total",
          "soft",
          "codAmount",
          `Наложеният платеж (${o.codAmount.toFixed(2)}) е по-голям от сумата на поръчката (${o.total.toFixed(2)}).`,
          `The COD (${o.codAmount.toFixed(2)}) is higher than the order total (${o.total.toFixed(2)}).`,
          { field: "codAmount", value: o.total.toFixed(2) },
        ),
      );
    if (!ctx.localCurrency)
      out.push(
        f(
          "order.cod_country_setting_missing",
          "hard",
          "countryCode",
          `Няма настройка за държава ${country ?? "?"} — не е известна местната валута за наложения платеж.`,
          `No setting for country ${country ?? "?"} — the local currency for the COD is unknown.`,
        ),
      );
    else if (
      o.currency.toUpperCase() !== ctx.localCurrency.toUpperCase() &&
      (o.codLocalAmount == null || o.codLocalCurrency?.toUpperCase() !== ctx.localCurrency.toUpperCase())
    )
      out.push(
        f(
          "order.cod_not_local_currency",
          "hard",
          "codLocalAmount",
          `Наложеният платеж е в ${o.currency}, а трябва да е в ${ctx.localCurrency} (местната валута).`,
          `The COD is in ${o.currency} but must be in ${ctx.localCurrency} (the local currency).`,
        ),
      );
  }

  // Routing and stock at the warehouse that will ship.
  if (!ctx.routing.connectionId)
    out.push(
      f(
        "routing.no_connection",
        "hard",
        null,
        "Няма избран склад: " + ctx.routing.explanation.bg,
        "No warehouse chosen: " + ctx.routing.explanation.en,
        undefined,
        "routing",
      ),
    );
  for (const l of ctx.stock?.lines ?? []) {
    if (!l.productId) continue; // reported as order.line_unmatched
    if (l.available === null)
      out.push(
        f(
          "stock.unknown",
          "soft",
          "lines",
          `„${l.title}“: наличността в склада не е известна (няма връзка с продукта там или снимка на наличността).`,
          `"${l.title}": the warehouse stock is unknown (no product link there or no stock snapshot).`,
          undefined,
          "stock",
        ),
      );
    else if (l.available < l.need)
      out.push(
        f(
          "stock.insufficient",
          "hard",
          "lines",
          `„${l.title}“: нужни ${l.need}, налични ${Math.max(0, l.available)}.`,
          `"${l.title}": ${l.need} needed, ${Math.max(0, l.available)} available.`,
          undefined,
          "stock",
        ),
      );
  }

  if (ctx.duplicates.length)
    out.push(
      f(
        "order.possible_duplicate",
        "soft",
        null,
        `Възможен дубликат на ${ctx.duplicates.map((d) => d.number).join(", ")} (същият клиент и сума).`,
        `Possible duplicate of ${ctx.duplicates.map((d) => d.number).join(", ")} (same customer and total).`,
      ),
    );

  return { findings: out, normalised: { phone, country } };
}
