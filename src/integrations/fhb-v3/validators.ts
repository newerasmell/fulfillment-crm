import { normalisePhoneE164 } from "./phone";
import { FHB_EMAIL_MAX, FHB_NOTE_MAX, FHB_PHONE_MAX, FHB_PRODUCT_NAME_MAX, FHB_URL_MAX } from "./schemas";

/**
 * FHB pre-flight validators (INTEGRATION_NOTES §5). Pure: no network, no database — callers pass in what the
 * mirror and the CRM know. Every finding has the shared shape {code, severity, field, message_bg, message_en,
 * suggestedFix?} that the review queue and the AI layer consume (SPEC §7). A hard finding blocks sending;
 * a soft one must be acknowledged by the operator. A vendor 400 in production means a rule is missing here.
 */

export type Severity = "hard" | "soft";

export interface ValidationFinding {
  code: string;
  severity: Severity;
  /** Dotted path in FHB terms where possible (e.g. "recipient.address.zip"), so the UI can highlight it. */
  field: string | null;
  message_bg: string;
  message_en: string;
  suggestedFix?: { field: string; value: string };
}

const f = (
  code: string,
  severity: Severity,
  field: string | null,
  message_bg: string,
  message_en: string,
  suggestedFix?: ValidationFinding["suggestedFix"],
): ValidationFinding => ({
  code,
  severity,
  field,
  message_bg,
  message_en,
  ...(suggestedFix ? { suggestedFix } : {}),
});

const blank = (v: string | null | undefined) => !v || !v.trim();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const hasHardBlock = (findings: ValidationFinding[]) => findings.some((x) => x.severity === "hard");

// ───────────── orders ─────────────

export interface FhbOrderLineCheck {
  /** CRM SKU / title, for the message only. */
  label: string;
  quantity: number;
  /** FHB product id from the mapping for this connection; null = no mapping. */
  vendorProductId: string | null;
  /** From the FHB mirror: the product exists there and is not archived. */
  vendorActive: boolean;
  /** FHB `free_quantity` (sellable stock) from the last snapshot; null = unknown. */
  freeQuantity: number | null;
  stockSnapshotAt: Date | null;
}

export interface FhbOrderCheck {
  externalId: string | null;
  variableSymbol: string | null;
  country: string | null;
  name: string | null;
  street: string | null;
  city: string | null;
  zip: string | null;
  email: string | null;
  phone: string | null;
  lines: FhbOrderLineCheck[];
  /** COD order? Then codAmount must be known in the destination's local currency. */
  isCod: boolean;
  codAmount: number | null;
  /** Currency the COD amount is expressed in after any conversion. */
  codCurrency: string | null;
  /** Destination country's local currency from CountrySetting (DB); null = not configured. */
  localCurrency: string | null;
  /** The parcel service needs a delivery point (PUDO). */
  requiresDeliveryPoint?: boolean;
  deliveryPoint?: string | null;
  /** Another shipment at this connection already uses the external id / variable symbol. */
  duplicateExternalId?: boolean;
  /** Free-text the FHB note would carry (operator note). */
  note?: string | null;
  customerNote?: string | null;
  /** Shopify risk recommendation / level, lower-case. */
  riskLevel?: string | null;
  /** Declared value could not be expressed in local currency, so it is left out. */
  valueNotConverted?: boolean;
  stockMaxAgeMs?: number;
  now?: Date;
}

export const DEFAULT_STOCK_MAX_AGE_MS = 60 * 60_000;

/** Currencies whose cash on delivery is collected in whole units (no rounding rule stored per country yet). */
export const WHOLE_UNIT_COD_CURRENCIES: ReadonlySet<string> = new Set(["HUF"]);

export function validateFhbOrder(o: FhbOrderCheck): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  const now = o.now ?? new Date();

  if (blank(o.externalId))
    out.push(
      f(
        "fhb.order.id_missing",
        "hard",
        "id",
        "Липсва номер на поръчката за склада.",
        "The warehouse order id is missing.",
      ),
    );
  if (o.duplicateExternalId)
    out.push(
      f(
        "fhb.order.duplicate_id",
        "hard",
        "id",
        "Поръчка със същия номер вече е изпратена към този склад.",
        "An order with the same id was already sent to this warehouse.",
      ),
    );
  if (!o.variableSymbol || !/^\d{1,10}$/.test(o.variableSymbol))
    out.push(
      f(
        "fhb.order.variable_symbol_invalid",
        "hard",
        "variable_symbol",
        "Вариабилният символ трябва да е до 10 цифри.",
        "The variable symbol must be up to 10 digits.",
      ),
    );

  const required: [keyof FhbOrderCheck, string, string, string][] = [
    ["name", "recipient.address.name", "Липсва име на получателя.", "The recipient name is missing."],
    ["street", "recipient.address.street", "Липсва адрес (улица).", "The street address is missing."],
    ["city", "recipient.address.city", "Липсва град.", "The city is missing."],
    ["zip", "recipient.address.zip", "Липсва пощенски код.", "The postal code is missing."],
  ];
  for (const [key, field, bg, en] of required) {
    if (blank(o[key] as string | null)) out.push(f(`fhb.address.${key}_missing`, "hard", field, bg, en));
  }
  if (!o.country || !/^[A-Z]{2}$/i.test(o.country))
    out.push(
      f(
        "fhb.address.country_invalid",
        "hard",
        "recipient.address.country",
        "Държавата трябва да е двубуквен ISO код.",
        "The country must be a two-letter ISO code.",
      ),
    );
  if (!blank(o.street) && !/\d/.test(o.street!))
    out.push(
      f(
        "fhb.address.street_no_number",
        "soft",
        "recipient.address.street",
        "Адресът няма номер.",
        "The street address has no house number.",
      ),
    );

  const email = o.email?.trim() ?? "";
  if (!email)
    out.push(
      f(
        "fhb.contact.email_missing",
        "hard",
        "recipient.contact.email",
        "Липсва имейл.",
        "The email is missing.",
      ),
    );
  else if (email.length > FHB_EMAIL_MAX)
    out.push(
      f(
        "fhb.contact.email_too_long",
        "hard",
        "recipient.contact.email",
        `Имейлът е по-дълъг от ${FHB_EMAIL_MAX} знака — FHB ще откаже поръчката.`,
        `The email is longer than ${FHB_EMAIL_MAX} characters — FHB will reject the order.`,
      ),
    );
  else if (!EMAIL.test(email))
    out.push(
      f(
        "fhb.contact.email_invalid",
        "hard",
        "recipient.contact.email",
        "Невалиден имейл.",
        "The email is not valid.",
      ),
    );

  if (blank(o.phone)) {
    out.push(
      f(
        "fhb.contact.phone_missing",
        "hard",
        "recipient.contact.phone",
        "Липсва телефон.",
        "The phone is missing.",
      ),
    );
  } else {
    const e164 = normalisePhoneE164(o.phone, o.country);
    if (!e164 || e164.length > FHB_PHONE_MAX)
      out.push(
        f(
          "fhb.contact.phone_invalid",
          "hard",
          "recipient.contact.phone",
          "Телефонът не може да се приведе в международен формат за държавата.",
          "The phone cannot be put into international format for the destination country.",
        ),
      );
    else if (e164 !== o.phone!.trim())
      out.push(
        f(
          "fhb.contact.phone_normalised",
          "soft",
          "recipient.contact.phone",
          `Телефонът ще бъде изпратен като ${e164}.`,
          `The phone will be sent as ${e164}.`,
          { field: "recipient.contact.phone", value: e164 },
        ),
      );
  }

  if (o.lines.length === 0)
    out.push(
      f("fhb.order.no_lines", "hard", "items", "Поръчката няма продукти.", "The order has no products."),
    );
  const demand = new Map<string, { qty: number; line: FhbOrderLineCheck }>();
  o.lines.forEach((line, i) => {
    const field = `items[${i}]`;
    if (!Number.isInteger(line.quantity) || line.quantity < 1)
      out.push(
        f(
          "fhb.line.quantity_invalid",
          "hard",
          `${field}.quantity`,
          `Невалидно количество: ${line.label}.`,
          `Invalid quantity: ${line.label}.`,
        ),
      );
    if (!line.vendorProductId) {
      out.push(
        f(
          "fhb.line.unmapped",
          "hard",
          `${field}.id`,
          `Продуктът няма връзка към FHB: ${line.label}.`,
          `The product is not mapped to FHB: ${line.label}.`,
        ),
      );
      return;
    }
    if (!line.vendorActive)
      out.push(
        f(
          "fhb.line.vendor_missing",
          "hard",
          `${field}.id`,
          `Продуктът ${line.vendorProductId} липсва или е архивиран във FHB.`,
          `Product ${line.vendorProductId} is missing or archived at FHB.`,
        ),
      );
    const d = demand.get(line.vendorProductId) ?? { qty: 0, line };
    d.qty += Math.max(0, line.quantity);
    demand.set(line.vendorProductId, d);
  });
  const maxAge = o.stockMaxAgeMs ?? DEFAULT_STOCK_MAX_AGE_MS;
  for (const [id, { qty, line }] of demand) {
    if (line.freeQuantity === null || line.freeQuantity < qty)
      out.push(
        f(
          "fhb.stock.insufficient",
          "hard",
          "items",
          `Недостатъчна свободна наличност във FHB за ${id}: нужни ${qty}, свободни ${line.freeQuantity ?? "?"}.`,
          `Not enough free stock at FHB for ${id}: need ${qty}, free ${line.freeQuantity ?? "?"}.`,
        ),
      );
    if (!line.stockSnapshotAt || now.getTime() - line.stockSnapshotAt.getTime() > maxAge)
      out.push(
        f(
          "fhb.stock.snapshot_stale",
          "soft",
          "items",
          `Наличността за ${id} е от стара снимка.`,
          `The stock figure for ${id} comes from an old snapshot.`,
        ),
      );
  }

  if (!o.localCurrency) {
    if (o.isCod)
      out.push(
        f(
          "fhb.cod.no_local_currency",
          "hard",
          "cod",
          `Няма зададена местна валута за ${o.country ?? "държавата"} — наложеният платеж не може да се изпрати.`,
          `No local currency is configured for ${o.country ?? "the country"} — COD cannot be sent.`,
        ),
      );
  } else if (o.isCod && (o.codAmount === null || o.codCurrency !== o.localCurrency)) {
    out.push(
      f(
        "fhb.cod.not_convertible",
        "hard",
        "cod",
        `Наложеният платеж трябва да е в ${o.localCurrency}; няма сума в тази валута.`,
        `COD must be in ${o.localCurrency}; no amount in that currency is available.`,
      ),
    );
  } else if (o.isCod && o.codAmount !== null && o.codAmount <= 0) {
    out.push(f("fhb.cod.zero", "hard", "cod", "Наложеният платеж е 0.", "The COD amount is zero."));
  }
  // Per-country rounding rules are not modelled yet (INTEGRATION_NOTES §2.3). Until they are, a COD with a
  // fractional part in a currency that is collected in whole units is flagged for the operator.
  if (
    o.isCod &&
    o.codAmount !== null &&
    o.codCurrency &&
    WHOLE_UNIT_COD_CURRENCIES.has(o.codCurrency.toUpperCase()) &&
    Math.round(o.codAmount * 100) % 100 !== 0
  )
    out.push(
      f(
        "fhb.cod.fractional",
        "soft",
        "cod",
        `Наложеният платеж ${o.codAmount} ${o.codCurrency} има дробна част; в тази валута се събират цели суми.`,
        `The COD ${o.codAmount} ${o.codCurrency} has a fractional part; this currency is collected in whole units.`,
      ),
    );
  if (o.valueNotConverted)
    out.push(
      f(
        "fhb.value.not_converted",
        "soft",
        "value",
        "Обявената стойност не е в местна валута и няма да бъде изпратена.",
        "The declared value is not in the local currency and will not be sent.",
      ),
    );

  if (o.requiresDeliveryPoint && blank(o.deliveryPoint))
    out.push(
      f(
        "fhb.order.delivery_point_missing",
        "hard",
        "delivery_point",
        "Поръчка до офис/автомат без избрана точка.",
        "Pick-up point delivery without a selected point.",
      ),
    );
  if (o.deliveryPoint && o.deliveryPoint.length > 255)
    out.push(
      f(
        "fhb.order.delivery_point_invalid",
        "hard",
        "delivery_point",
        "Невалиден код на точка.",
        "Invalid delivery point code.",
      ),
    );
  if (o.note && o.note.length > FHB_NOTE_MAX)
    out.push(
      f(
        "fhb.order.note_truncated",
        "soft",
        "note",
        `Бележката ще бъде съкратена до ${FHB_NOTE_MAX} знака.`,
        `The note will be cut to ${FHB_NOTE_MAX} characters.`,
      ),
    );
  if (!blank(o.customerNote))
    out.push(
      f("fhb.order.customer_note", "soft", null, "Клиентът е оставил бележка.", "The customer left a note."),
    );
  if (o.riskLevel && ["medium", "high", "investigate", "cancel"].includes(o.riskLevel.toLowerCase()))
    out.push(
      f(
        "fhb.order.risk",
        "soft",
        null,
        "Shopify отбелязва риск за поръчката.",
        "Shopify flags this order as risky.",
      ),
    );
  return out;
}

// ───────────── products ─────────────

export interface FhbProductCheck {
  vendorProductId: string | null;
  name: string | null;
  photo?: string | null;
  notifyUrl?: string | null;
  /** Multi-product components (FHB ids) with what the mirror knows about them. */
  components?: { id: string; quantity: number; exists: boolean; type: string | null }[];
  /** For an update: the product is multi at FHB now (demoting is not supported). */
  currentType?: string | null;
  targetType?: "single" | "multi";
}

export function validateFhbProduct(p: FhbProductCheck): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  if (blank(p.vendorProductId))
    out.push(
      f(
        "fhb.product.id_missing",
        "hard",
        "id",
        "Липсва код на продукта за FHB.",
        "The FHB product id is missing.",
      ),
    );
  else if (/[#&%]/.test(p.vendorProductId!))
    out.push(
      f(
        "fhb.product.id_chars",
        "hard",
        "id",
        "Кодът на продукта съдържа #, & или % — FHB не ги допуска.",
        "The product id contains #, & or % — FHB does not allow them.",
      ),
    );
  if (blank(p.name))
    out.push(
      f(
        "fhb.product.name_missing",
        "hard",
        "name",
        "Липсва име на продукта.",
        "The product name is missing.",
      ),
    );
  else if (p.name!.length > FHB_PRODUCT_NAME_MAX)
    out.push(
      f(
        "fhb.product.name_too_long",
        "hard",
        "name",
        `Името е по-дълго от ${FHB_PRODUCT_NAME_MAX} знака.`,
        `The name is longer than ${FHB_PRODUCT_NAME_MAX} characters.`,
      ),
    );
  if (p.photo && p.photo.length > FHB_URL_MAX)
    out.push(
      f(
        "fhb.product.photo_too_long",
        "soft",
        "photo",
        "Адресът на снимката е твърде дълъг и няма да бъде изпратен.",
        "The photo URL is too long and will not be sent.",
      ),
    );
  if (p.notifyUrl && p.notifyUrl.length > FHB_URL_MAX)
    out.push(
      f(
        "fhb.product.notify_url_too_long",
        "hard",
        "notify_url",
        "Адресът за известия е по-дълъг от 255 знака.",
        "The notification URL is longer than 255 characters.",
      ),
    );
  if (p.currentType === "multi" && p.targetType === "single")
    out.push(
      f(
        "fhb.product.demote_not_supported",
        "hard",
        "type",
        "Комплект не може да стане единичен продукт във FHB.",
        "FHB cannot turn a multi-product back into a single product.",
      ),
    );
  if (p.targetType === "multi") {
    const comps = p.components ?? [];
    if (comps.length === 0)
      out.push(
        f(
          "fhb.product.multi_empty",
          "hard",
          "items",
          "Комплектът няма съставки.",
          "The multi-product has no components.",
        ),
      );
    const seen = new Set<string>();
    comps.forEach((c, i) => {
      const field = `items[${i}].id`;
      if (seen.has(c.id))
        out.push(
          f(
            "fhb.product.multi_duplicate",
            "hard",
            field,
            `Съставката ${c.id} е повторена.`,
            `Component ${c.id} is listed twice.`,
          ),
        );
      seen.add(c.id);
      if (c.id === p.vendorProductId)
        out.push(
          f(
            "fhb.product.multi_self",
            "hard",
            field,
            "Комплектът сочи към себе си.",
            "The multi-product refers to itself.",
          ),
        );
      else if (!c.exists)
        out.push(
          f(
            "fhb.product.multi_component_missing",
            "hard",
            field,
            `Съставката ${c.id} не съществува (или е архивирана) във FHB.`,
            `Component ${c.id} does not exist (or is archived) at FHB.`,
          ),
        );
      else if (c.type === "multi")
        out.push(
          f(
            "fhb.product.multi_nested",
            "hard",
            field,
            `Съставката ${c.id} сама е комплект.`,
            `Component ${c.id} is itself a multi-product.`,
          ),
        );
      if (!Number.isInteger(c.quantity) || c.quantity < 1)
        out.push(
          f(
            "fhb.product.multi_quantity",
            "hard",
            `items[${i}].quantity`,
            "Невалидно количество на съставка.",
            "Invalid component quantity.",
          ),
        );
    });
  }
  return out;
}

// ───────────── stock receipts ─────────────

export interface FhbStockReceiptCheck {
  externalRef: string;
  name: string | null;
  lines: { label: string; vendorProductId: string | null; quantity: number; vendorType?: string | null }[];
  expectedDate?: string | null;
  trackingCode?: string | null;
}

export function validateFhbStockReceipt(r: FhbStockReceiptCheck): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  if (blank(r.externalRef) || r.externalRef.length > 255)
    out.push(
      f("fhb.receipt.id_invalid", "hard", "id", "Невалиден номер на доставката.", "Invalid receipt id."),
    );
  if (blank(r.name) || r.name!.trim().length > 50)
    out.push(
      f(
        "fhb.receipt.name_invalid",
        "hard",
        "name",
        "Името на доставката трябва да е от 1 до 50 знака.",
        "The receipt name must be 1–50 characters.",
      ),
    );
  if (r.expectedDate && !/^\d{4}-\d{2}-\d{2}$/.test(r.expectedDate))
    out.push(f("fhb.receipt.date_invalid", "hard", "expected_date", "Невалидна дата.", "Invalid date."));
  if (r.trackingCode && r.trackingCode.length > 255)
    out.push(
      f(
        "fhb.receipt.tracking_too_long",
        "hard",
        "tracking_code",
        "Номерът за проследяване е твърде дълъг.",
        "The tracking code is too long.",
      ),
    );
  if (r.lines.length === 0)
    out.push(
      f("fhb.receipt.no_lines", "hard", "items", "Доставката няма продукти.", "The receipt has no products."),
    );
  r.lines.forEach((l, i) => {
    if (!l.vendorProductId)
      out.push(
        f(
          "fhb.receipt.unmapped",
          "hard",
          `items[${i}].id`,
          `Продуктът няма връзка към FHB: ${l.label}.`,
          `The product is not mapped to FHB: ${l.label}.`,
        ),
      );
    else if (l.vendorType === "multi")
      out.push(
        f(
          "fhb.receipt.multi_product",
          "hard",
          `items[${i}].id`,
          `${l.vendorProductId} е комплект — заприхождават се само единични продукти.`,
          `${l.vendorProductId} is a multi-product — only single products can be received.`,
        ),
      );
    if (!Number.isInteger(l.quantity) || l.quantity < 1)
      out.push(
        f(
          "fhb.receipt.quantity_invalid",
          "hard",
          `items[${i}].quantity`,
          "Невалидно количество.",
          "Invalid quantity.",
        ),
      );
  });
  return out;
}

/** Maps an FHB 400 `violations` map to findings on the same field paths (a missing pre-flight rule!). */
export function findingsFromViolations(violations: Record<string, string[]>): ValidationFinding[] {
  return Object.entries(violations).map(([field, codes]) =>
    f(
      `fhb.vendor.${codes[0] || "invalid"}`,
      "hard",
      field,
      `FHB отказа полето ${field}: ${codes.join(", ")}.`,
      `FHB rejected the field ${field}: ${codes.join(", ")}.`,
    ),
  );
}
