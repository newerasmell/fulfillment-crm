import { normalisePhoneE164 } from "@/integrations/fhb-v3/phone";
import type { ValidationFinding } from "@/integrations/fhb-v3/validators";
import { JOY_LIMITS } from "./schemas";

/**
 * FHB Joy pre-flight validators (INTEGRATION_NOTES §3, §5). Pure: no network, no database. Same finding shape
 * as every other vendor ({code, severity, field, message_bg, message_en, suggestedFix?}); `field` uses the Joy
 * body names (`zip`, `phone`, …) so a vendor 400 `id` and our finding point at the same input.
 * Every Joy label is real and billable: a vendor 400 in production means a rule is missing here.
 */

export type { ValidationFinding };

export interface JoyShipmentDraft {
  /** Deterministic id (Fulfillment.externalId). */
  id: string;
  variableSymbol: string;
  parcelService: string | null;
  /** Parcel services the connection is configured for (Joy has no list endpoint); empty = not configured. */
  allowedParcelServices: readonly string[];
  name: string | null;
  street: string | null;
  city: string | null;
  zip: string | null;
  province?: string | null;
  /** ISO-2, any case (sent lowercase). */
  country: string | null;
  email: string | null;
  phone: string | null;
  /** The group's own phone rule for the destination (used only for a country the ITU table lacks). */
  phoneRule?: { cc: string; trunk: string } | null;
  /** COD amount in `codCurrency` (null / 0 = no COD). */
  cod: number | null;
  codCurrency: string | null;
  /** Destination's local currency from CountrySetting; null = not configured. */
  localCurrency: string | null;
  numberOfPackages: number;
  /** Per-package weight in kg; when given, one per package. */
  weights?: number[] | null;
  /** The parcel service delivers only to pick-up points. */
  requiresDeliveryPoint?: boolean;
  deliveryPoint?: string | null;
  note?: string | null;
  /** Another shipment at this connection already uses this id. */
  duplicateId?: boolean;
}

const f = (
  code: string,
  severity: ValidationFinding["severity"],
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
const len = (v: string | null | undefined) => (v ?? "").trim().length;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Whole-unit currencies where a fractional COD is suspicious (rounding rules not modelled; §2.3). */
const WHOLE_UNIT = new Set(["HUF"]);

export function validateJoyShipment(d: JoyShipmentDraft): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  if (d.duplicateId)
    out.push(
      f(
        "joy.id.duplicate",
        "hard",
        "id",
        "Вече има етикет с този номер — нов няма да бъде създаден.",
        "A label with this id already exists — no second one is created.",
      ),
    );
  if (blank(d.parcelService))
    out.push(
      f(
        "joy.parcel_service.missing",
        "hard",
        "parcelService",
        "Изберете куриерска услуга.",
        "Choose a parcel service.",
      ),
    );
  else if (d.allowedParcelServices.length > 0 && !d.allowedParcelServices.includes(d.parcelService!.trim()))
    out.push(
      f(
        "joy.parcel_service.not_enabled",
        "hard",
        "parcelService",
        `Услугата „${d.parcelService}“ не е разрешена за тази Joy връзка.`,
        `Parcel service "${d.parcelService}" is not enabled for this Joy connection.`,
      ),
    );
  else if (d.allowedParcelServices.length === 0)
    out.push(
      f(
        "joy.parcel_service.unconfigured",
        "soft",
        "parcelService",
        "Joy връзката няма списък с разрешени услуги — проверете кода на услугата.",
        "The Joy connection has no list of enabled parcel services — check the service code.",
      ),
    );

  if (len(d.name) < JOY_LIMITS.nameMin)
    out.push(
      f(
        "joy.name.short",
        "hard",
        "name",
        "Името на получателя трябва да е поне 3 знака.",
        "Recipient name needs at least 3 characters.",
      ),
    );
  if (len(d.street) < JOY_LIMITS.streetMin)
    out.push(
      f(
        "joy.street.short",
        "hard",
        "street",
        "Улицата трябва да е поне 3 знака.",
        "Street needs at least 3 characters.",
      ),
    );
  else if (!/\d/.test(d.street!))
    out.push(
      f("joy.street.no_number", "soft", "street", "Улицата няма номер.", "The street has no house number."),
    );
  if (len(d.city) < JOY_LIMITS.cityMin)
    out.push(
      f(
        "joy.city.short",
        "hard",
        "city",
        "Градът трябва да е поне 2 знака.",
        "City needs at least 2 characters.",
      ),
    );
  const zl = len(d.zip);
  if (zl < JOY_LIMITS.zipMin || zl > JOY_LIMITS.zipMax)
    out.push(
      f(
        "joy.zip.length",
        "hard",
        "zip",
        "Пощенският код трябва да е 3–12 знака.",
        "The ZIP code must be 3–12 characters.",
      ),
    );
  if (!d.country || !/^[A-Za-z]{2}$/.test(d.country.trim()))
    out.push(
      f(
        "joy.country.invalid",
        "hard",
        "country",
        "Невалидна държава (ISO код от 2 букви).",
        "Invalid country (2-letter ISO code).",
      ),
    );

  if (blank(d.email))
    out.push(
      f("joy.email.missing", "hard", "email", "Имейлът е задължителен за Joy.", "Joy requires an email."),
    );
  else if (d.email!.trim().length > JOY_LIMITS.emailMax)
    out.push(
      f(
        "joy.email.too_long",
        "hard",
        "email",
        "Имейлът е по-дълъг от 50 знака.",
        "The email is longer than 50 characters.",
      ),
    );
  else if (!EMAIL.test(d.email!.trim()))
    out.push(f("joy.email.invalid", "hard", "email", "Невалиден имейл.", "Invalid email."));

  const e164 = normalisePhoneE164(d.phone, d.country, d.phoneRule);
  if (blank(d.phone))
    out.push(
      f("joy.phone.missing", "hard", "phone", "Телефонът е задължителен.", "A phone number is required."),
    );
  else if (!e164 || e164.length < JOY_LIMITS.phoneMin || e164.length > JOY_LIMITS.phoneMax)
    out.push(
      f(
        "joy.phone.invalid",
        "hard",
        "phone",
        "Телефонът не може да се приведе в международен формат (6–20 знака).",
        "The phone cannot be put into international format (6–20 characters).",
      ),
    );
  else if (e164 !== d.phone!.trim())
    out.push(
      f(
        "joy.phone.normalised",
        "soft",
        "phone",
        `Телефонът ще бъде изпратен като ${e164}.`,
        `The phone will be sent as ${e164}.`,
        {
          field: "phone",
          value: e164,
        },
      ),
    );

  if (blank(d.variableSymbol))
    out.push(
      f(
        "joy.variable_symbol.missing",
        "hard",
        "variableSymbol",
        "Липсва вариабилен символ.",
        "Missing variable symbol.",
      ),
    );
  else if (
    d.parcelService?.trim() === "posta_expres" &&
    !new RegExp(`^\\d{1,${JOY_LIMITS.postaExpresVsMax}}$`).test(d.variableSymbol)
  )
    out.push(
      f(
        "joy.variable_symbol.posta_expres",
        "hard",
        "variableSymbol",
        "За posta_expres вариабилният символ трябва да е до 10 цифри.",
        "For posta_expres the variable symbol must be numeric, at most 10 digits.",
      ),
    );

  if (!Number.isInteger(d.numberOfPackages) || d.numberOfPackages < 1)
    out.push(
      f(
        "joy.packages.invalid",
        "hard",
        "numberOfPackages",
        "Броят пакети трябва да е поне 1.",
        "At least one package.",
      ),
    );
  if (d.weights && d.weights.length > 0) {
    if (d.weights.length !== d.numberOfPackages)
      out.push(
        f(
          "joy.weight.count",
          "hard",
          "weight",
          "Теглата трябва да са по едно за всеки пакет.",
          "Give one weight per package.",
        ),
      );
    if (d.weights.some((w) => !(w > 0)))
      out.push(
        f(
          "joy.weight.invalid",
          "hard",
          "weight",
          "Теглото трябва да е положително число.",
          "Weights must be positive.",
        ),
      );
  }

  if (d.requiresDeliveryPoint && blank(d.deliveryPoint))
    out.push(
      f(
        "joy.delivery_point.missing",
        "hard",
        "deliveryPoint",
        "Услугата доставя само до пункт — изберете пункт.",
        "This service delivers to pick-up points only — choose one.",
      ),
    );
  if ((d.note ?? "").length > JOY_LIMITS.noteMax)
    out.push(
      f(
        "joy.note.too_long",
        "hard",
        "note",
        "Бележката е над 250 знака.",
        "The note is longer than 250 characters.",
      ),
    );

  // COD always in the destination's local currency (reference warning, CLAUDE.md).
  if (d.cod && d.cod > 0) {
    if (!d.localCurrency)
      out.push(
        f(
          "joy.cod.no_local_currency",
          "hard",
          "cod",
          "Няма настроена местна валута за държавата — наложеният платеж не може да се изпрати.",
          "No local currency is set up for the country — COD cannot be sent.",
        ),
      );
    else if ((d.codCurrency ?? "").toUpperCase() !== d.localCurrency.toUpperCase())
      out.push(
        f(
          "joy.cod.currency",
          "hard",
          "cod",
          `Наложеният платеж трябва да е в ${d.localCurrency}.`,
          `COD must be in ${d.localCurrency}.`,
        ),
      );
    else if (WHOLE_UNIT.has(d.localCurrency.toUpperCase()) && !Number.isInteger(d.cod))
      out.push(
        f(
          "joy.cod.fractional",
          "soft",
          "cod",
          "Наложеният платеж има стотинки във валута без дробни единици.",
          "COD has decimals in a whole-unit currency.",
        ),
      );
  } else if (d.cod !== null && d.cod < 0) {
    out.push(
      f(
        "joy.cod.negative",
        "hard",
        "cod",
        "Наложеният платеж не може да е отрицателен.",
        "COD cannot be negative.",
      ),
    );
  }
  return out;
}
