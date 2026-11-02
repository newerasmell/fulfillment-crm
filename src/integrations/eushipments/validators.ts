import type { BuiltOrder } from "./mapper";
import { productsSumCents } from "./mapper";
import { CreateOrderBody } from "./schemas";

/**
 * Pre-flight validators for euShipments create-order (INTEGRATION_NOTES §4.3, §4.4, §5). Pure.
 * "block" = cannot be submitted; "warn" = the operator must acknowledge. A vendor 400/422 in production
 * means a rule is missing here: add it with a test.
 */

export interface Finding {
  code: string;
  severity: "block" | "warn";
  field: string;
  message_bg: string;
  message_en: string;
  suggestedFix?: string;
}

/** The vendor keeps the first 8 characters as building number and appends the rest to addressText after "|". */
export const BUILDING_NUMBER_KEPT = 8;
/** addressText values longer than this are truncated when the order is stored. */
export const ADDRESS_TEXT_STORED = 100;
/** waybillAvailableDate: from today up to 9 days ahead. */
export const WAYBILL_MAX_DAYS_AHEAD = 9;

/** Today's calendar date in Europe/Sofia (the vendor's "today"), YYYY-MM-DD. */
export function sofiaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Sofia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** What the vendor will store as addressText (building overflow appended after "|", cut at 100). */
export function storedAddressText(
  addressText: string | null | undefined,
  buildingNumber: string | null | undefined,
) {
  const overflow =
    buildingNumber && buildingNumber.length > BUILDING_NUMBER_KEPT
      ? buildingNumber.slice(BUILDING_NUMBER_KEPT)
      : "";
  const full = [addressText ?? "", overflow].filter(Boolean).join("|");
  return { full, stored: full.slice(0, ADDRESS_TEXT_STORED), truncated: full.length > ADDRESS_TEXT_STORED };
}

const PHONE_REASON: Record<string, [string, string]> = {
  empty: ["Липсва телефон на получателя.", "Recipient phone is missing."],
  invalid_characters: ["Телефонът съдържа букви или други символи.", "The phone contains letters or other characters."],
  foreign_number: ["Телефонът е с код на друга държава.", "The phone has another country's calling code."],
  wrong_length: ["Телефонът е с грешен брой цифри за държавата.", "The phone has the wrong number of digits for the country."],
  no_rule: ["Няма правило за телефони за тази държава.", "No phone rule for this destination country."],
}; // prettier-ignore

export interface OrderContext {
  cashReceiptCod: boolean;
  /** Today in Europe/Sofia (default: now). */
  today?: string;
}

export function validateEuOrder(built: BuiltOrder, ctx: OrderContext): Finding[] {
  const out: Finding[] = [];
  const { body } = built;
  const r = body.recipient;

  // 1. Phone (§4.4).
  if (!built.phone.ok) {
    const [bg, en] = PHONE_REASON[built.phone.reason] ?? PHONE_REASON.wrong_length!;
    out.push({
      code: "phone_invalid",
      severity: "block",
      field: "recipient.phoneNumber",
      message_bg: bg,
      message_en: en,
    });
  }

  // 2. Shape and length limits from the reference.
  const parsed = CreateOrderBody.safeParse(body);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.join(".");
      if (field === "recipient.phoneNumber" && !built.phone.ok) continue; // already reported
      out.push({
        code: "invalid_field",
        severity: "block",
        field,
        message_bg: `Невалидно или липсващо поле ${field}: ${issue.message}`,
        message_en: `Invalid or missing field ${field}: ${issue.message}`,
      });
    }
  }

  // 3. waybillAvailableDate window.
  const today = ctx.today ?? sofiaToday();
  const last = addDays(today, WAYBILL_MAX_DAYS_AHEAD);
  if (body.waybillAvailableDate < today || body.waybillAvailableDate > last) {
    out.push({
      code: "waybill_date_window",
      severity: "block",
      field: "waybillAvailableDate",
      message_bg: `Датата за обработка трябва да е между ${today} и ${last}.`,
      message_en: `The processing date must be between ${today} and ${last}.`,
      suggestedFix: today,
    });
  }

  // 4. COD = Σ(price × qty) for cash-receipt senders (§4.3).
  if (ctx.cashReceiptCod) {
    if (built.priceProblem) {
      out.push({
        code: "cod_price_split",
        severity: "block",
        field: "products",
        message_bg:
          "Наложеният платеж не може да се разпредели точно по цените на редовете — коригирайте ръчно.",
        message_en: "The COD cannot be split exactly over the line prices — adjust the prices manually.",
      });
    } else {
      const sum = productsSumCents(body.products);
      const cod = Math.round((body.awb.bankRepayment ?? 0) * 100);
      if (sum !== cod) {
        out.push({
          code: "cod_sum_mismatch",
          severity: "block",
          field: "awb.bankRepayment",
          message_bg: `Сумата на цените (${(sum / 100).toFixed(2)}) не е равна на наложения платеж (${(cod / 100).toFixed(2)}).`,
          message_en: `The sum of line prices (${(sum / 100).toFixed(2)}) does not equal the COD (${(cod / 100).toFixed(2)}).`,
        });
      }
    }
  }

  // 5. Truncation warnings (the vendor cuts silently).
  if (r.buildingNumber && r.buildingNumber.length > BUILDING_NUMBER_KEPT) {
    out.push({
      code: "building_number_truncated",
      severity: "warn",
      field: "recipient.buildingNumber",
      message_bg: `Номерът на сградата ще бъде съкратен до „${r.buildingNumber.slice(0, BUILDING_NUMBER_KEPT)}“, останалото отива в допълнителния адрес.`,
      message_en: `The building number will be cut to "${r.buildingNumber.slice(0, BUILDING_NUMBER_KEPT)}"; the rest moves to the address text.`,
    });
  }
  const text = storedAddressText(r.addressText, r.buildingNumber);
  if (text.truncated) {
    out.push({
      code: "address_text_truncated",
      severity: "warn",
      field: "recipient.addressText",
      message_bg: `Допълнителният адрес ще бъде съкратен до ${ADDRESS_TEXT_STORED} знака.`,
      message_en: `The address text will be cut to ${ADDRESS_TEXT_STORED} characters.`,
      suggestedFix: text.stored,
    });
  }

  // 6. Street without a house number (soft, §5).
  const toOffice = r.officeId != null || !!r.officeCode;
  if (!toOffice && r.streetName && !/\d/.test(`${r.streetName} ${r.buildingNumber ?? ""}`)) {
    out.push({
      code: "street_without_number",
      severity: "warn",
      field: "recipient.streetName",
      message_bg: "Адресът няма номер на сграда.",
      message_en: "The street has no house number.",
    });
  }
  return out;
}

export const hasBlocks = (findings: Finding[]) => findings.some((f) => f.severity === "block");
