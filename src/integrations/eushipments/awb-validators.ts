import type { ValidationFinding } from "@/integrations/fhb-v3/validators";
import { AWB_LIMITS, CreateAwbBody, PreAwbBody } from "./awb-schemas";
import { normalisePhone } from "./phone";
import { addDays, BUILDING_NUMBER_KEPT, storedAddressText, WAYBILL_MAX_DAYS_AHEAD } from "./validators";

/**
 * Pre-flight validators + body builders for euShipments courier AWBs (createAWB / preAWB; INTEGRATION_NOTES
 * §4.4, §4.7, §5). Pure. Findings use the shared hard/soft shape. A courier AWB is a real shipment (and its
 * referenceNumber is NOT unique at euShipments), so a duplicate reference is a hard block decided by our DB.
 */

export interface AwbDraft {
  /** createAWB = courier waybill now; preAWB = order registered, waybill created later by euShipments. */
  service: "createAWB" | "preAWB";
  referenceNumber: string;
  /** euShipments companyId of the connection (senderId). */
  senderId: number | null;
  courierId: number | null;
  serviceName?: string | null;
  waybillAvailableDate: string;
  /** Today in Europe/Sofia. */
  today: string;
  name: string | null;
  phone: string | null;
  email?: string | null;
  /** ISO-2 (any case). */
  country: string | null;
  cityName: string | null;
  zip: string | null;
  region?: string | null;
  street: string | null;
  buildingNumber?: string | null;
  addressText?: string | null;
  /** Courier office / PUDO (from the offices mirror). */
  officeId?: number | null;
  parcels: number;
  totalWeight: number | null;
  declaredValue?: number | null;
  /** COD in `codCurrency`; null/0 = none. */
  cod: number | null;
  codCurrency: string | null;
  localCurrency: string | null;
  observations?: string | null;
  contents?: string | null;
  openPackage?: boolean;
  duplicateReference?: boolean;
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
const t = (v: string | null | undefined) => (v ?? "").trim();

const PHONE: Record<string, [string, string]> = {
  empty: ["Липсва телефон на получателя.", "Recipient phone is missing."],
  invalid_characters: ["Телефонът съдържа букви или други символи.", "The phone contains letters or other characters."],
  foreign_number: ["Телефонът е с код на друга държава.", "The phone has another country's calling code."],
  wrong_length: ["Телефонът е с грешен брой цифри за държавата.", "The phone has the wrong number of digits for the country."],
}; // prettier-ignore

/** The phone as it will be sent (euShipments per-country rules; unknown country → as typed). */
export function awbPhone(phone: string | null, country: string | null) {
  const r = normalisePhone(phone, country);
  if (r.ok) return r.value;
  if (r.reason === "no_rule" && t(phone)) return t(phone);
  return null;
}

export function validateAwb(d: AwbDraft): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  const pre = d.service === "preAWB";
  if (d.duplicateReference)
    out.push(
      f(
        "awb.reference.duplicate",
        "hard",
        "awb.referenceNumber",
        "Вече има товарителница с този номер — euShipments не пази уникалност, нова няма да бъде създадена.",
        "An AWB with this reference already exists — euShipments does not enforce uniqueness, none is created.",
      ),
    );
  if (!d.senderId)
    out.push(
      f(
        "awb.sender.missing",
        "hard",
        "senderId",
        "Връзката няма euShipments фирма (senderId).",
        "The connection has no euShipments company (senderId).",
      ),
    );
  if (!d.courierId && !pre)
    out.push(f("awb.courier.missing", "hard", "courierId", "Изберете куриер.", "Choose a courier."));
  if (blank(d.referenceNumber) || d.referenceNumber.length > AWB_LIMITS.referenceMax)
    out.push(
      f(
        "awb.reference.invalid",
        "hard",
        "awb.referenceNumber",
        "Невалиден референтен номер.",
        "Invalid reference number.",
      ),
    );

  const max = addDays(d.today, WAYBILL_MAX_DAYS_AHEAD);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(d.waybillAvailableDate) ||
    d.waybillAvailableDate < d.today ||
    d.waybillAvailableDate > max
  )
    out.push(
      f(
        "awb.date.window",
        "hard",
        "waybillAvailableDate",
        `Датата на изпращане трябва да е между ${d.today} и ${max}.`,
        `The dispatch date must be between ${d.today} and ${max}.`,
      ),
    );

  if (blank(d.name))
    out.push(
      f(
        "awb.name.missing",
        "hard",
        "recipient.name",
        "Липсва име на получателя.",
        "Recipient name is missing.",
      ),
    );
  else if (t(d.name).length > AWB_LIMITS.nameMax)
    out.push(
      f(
        "awb.name.too_long",
        "hard",
        "recipient.name",
        "Името е над 100 знака.",
        "The name is longer than 100 characters.",
      ),
    );

  const country = t(d.country).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country))
    out.push(
      f("awb.country.invalid", "hard", "recipient.countryIsoCode", "Невалидна държава.", "Invalid country."),
    );
  if (blank(d.cityName))
    out.push(f("awb.city.missing", "hard", "recipient.cityName", "Липсва град.", "City is missing."));
  else if (t(d.cityName).length > AWB_LIMITS.cityMax)
    out.push(
      f(
        "awb.city.too_long",
        "hard",
        "recipient.cityName",
        "Градът е над 100 знака.",
        "City longer than 100 characters.",
      ),
    );
  if (t(d.zip).length > AWB_LIMITS.zipMax)
    out.push(
      f(
        "awb.zip.too_long",
        "hard",
        "recipient.zipCode",
        "Пощенският код е над 15 знака.",
        "ZIP longer than 15 characters.",
      ),
    );
  if (pre) {
    // cityName is always sent, so cityName AND zipCode are both needed (cityId is not used).
    if (blank(d.zip))
      out.push(
        f(
          "awb.zip.required_with_city",
          "hard",
          "recipient.zipCode",
          "Pre-AWB с име на град изисква и пощенски код.",
          "Pre-AWB with a city name also needs the ZIP code.",
        ),
      );
  } else if (blank(d.zip) && blank(d.region))
    out.push(
      f(
        "awb.zip.missing",
        "hard",
        "recipient.zipCode",
        "Нужен е пощенски код или регион.",
        "A ZIP code or a region is needed.",
      ),
    );
  if (country === "RO" && blank(d.region))
    out.push(
      f(
        "awb.region.ro",
        "hard",
        "recipient.region",
        "За Румъния регионът е задължителен.",
        "Romania requires the region (county).",
      ),
    );

  const toOffice = !!d.officeId;
  const streetMax = pre ? AWB_LIMITS.preStreetMax : AWB_LIMITS.streetMax;
  if (blank(d.street) && (pre || !toOffice))
    out.push(
      f(
        "awb.street.missing",
        "hard",
        "recipient.streetName",
        pre ? "Pre-AWB изисква улица дори при доставка до офис." : "Липсва улица (или изберете офис).",
        pre ? "Pre-AWB needs a street even for office delivery." : "Street is missing (or choose an office).",
      ),
    );
  else if (t(d.street).length > streetMax)
    out.push(
      f(
        "awb.street.too_long",
        "hard",
        "recipient.streetName",
        `Улицата е над ${streetMax} знака.`,
        `Street longer than ${streetMax} characters.`,
      ),
    );
  else if (!toOffice && !blank(d.street) && !/\d/.test(d.street!) && blank(d.buildingNumber))
    out.push(
      f(
        "awb.street.no_number",
        "soft",
        "recipient.streetName",
        "Адресът няма номер.",
        "The address has no house number.",
      ),
    );

  if (pre && d.buildingNumber && !/^\d+$/.test(t(d.buildingNumber)))
    out.push(
      f(
        "awb.building.integer",
        "hard",
        "recipient.buildingNumber",
        "За Pre-AWB номерът трябва да е цяло число.",
        "For Pre-AWB the building number must be an integer.",
      ),
    );
  if (!pre && d.buildingNumber && t(d.buildingNumber).length > BUILDING_NUMBER_KEPT)
    out.push(
      f(
        "awb.building.split",
        "soft",
        "recipient.buildingNumber",
        "Номерът е над 8 знака — останалото отива в допълнителния адрес.",
        "The building number is longer than 8 — the rest moves to the address text.",
      ),
    );
  const at = storedAddressText(d.addressText, pre ? null : d.buildingNumber);
  if (at.truncated)
    out.push(
      f(
        "awb.address_text.truncated",
        "soft",
        "recipient.addressText",
        "Допълнителният адрес ще бъде отрязан до 100 знака.",
        "The address text will be cut to 100 characters.",
      ),
    );

  const ph = normalisePhone(d.phone, country);
  if (!ph.ok) {
    if (ph.reason === "no_rule" && !blank(d.phone))
      out.push(
        f(
          "awb.phone.no_rule",
          "soft",
          "recipient.phoneNumber",
          "Няма правило за телефони за тази държава — изпраща се както е въведен.",
          "No phone rule for this country — sent as entered.",
        ),
      );
    else {
      const [bg, en] = PHONE[ph.reason] ?? PHONE.wrong_length!;
      out.push(f("awb.phone.invalid", "hard", "recipient.phoneNumber", bg, en));
    }
  } else if (ph.changed)
    out.push(
      f(
        "awb.phone.normalised",
        "soft",
        "recipient.phoneNumber",
        `Телефонът ще бъде изпратен като ${ph.value}.`,
        `The phone will be sent as ${ph.value}.`,
        {
          field: "phone",
          value: ph.value,
        },
      ),
    );
  if (pre && d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim()))
    out.push(
      f(
        "awb.email.invalid",
        "hard",
        "recipient.email",
        "Невалиден имейл (Pre-AWB го проверява).",
        "Invalid email (Pre-AWB validates it).",
      ),
    );

  if (!Number.isInteger(d.parcels) || d.parcels < 1)
    out.push(
      f(
        "awb.parcels.invalid",
        "hard",
        "awb.parcels",
        "Броят пакети трябва да е поне 1.",
        "At least one parcel.",
      ),
    );
  const minW = pre ? AWB_LIMITS.preTotalWeightMin : AWB_LIMITS.totalWeightMin;
  if (d.totalWeight == null || !(d.totalWeight >= minW))
    out.push(
      f(
        "awb.weight.min",
        "hard",
        "awb.totalWeight",
        `Общото тегло трябва да е поне ${minW} кг.`,
        `Total weight must be at least ${minW} kg.`,
      ),
    );
  if ((d.observations ?? "").length > AWB_LIMITS.observationsMax)
    out.push(
      f(
        "awb.observations.too_long",
        "hard",
        "awb.observations",
        "Бележката е над 100 знака.",
        "Notes longer than 100 characters.",
      ),
    );
  if ((d.contents ?? "").length > AWB_LIMITS.productsMax)
    out.push(
      f(
        "awb.contents.too_long",
        "hard",
        "awb.products",
        "Съдържанието е над 1000 знака.",
        "Contents longer than 1000 characters.",
      ),
    );

  if (d.cod && d.cod > 0) {
    if (!d.localCurrency)
      out.push(
        f(
          "awb.cod.no_local_currency",
          "hard",
          "awb.bankRepayment",
          "Няма настроена местна валута за държавата.",
          "No local currency set up for the country.",
        ),
      );
    else if (t(d.codCurrency).toUpperCase() !== d.localCurrency.toUpperCase())
      out.push(
        f(
          "awb.cod.currency",
          "hard",
          "awb.bankRepayment",
          `Наложеният платеж трябва да е в ${d.localCurrency}.`,
          `COD must be in ${d.localCurrency}.`,
        ),
      );
  } else if (d.cod != null && d.cod < 0)
    out.push(
      f(
        "awb.cod.negative",
        "hard",
        "awb.bankRepayment",
        "Наложеният платеж не може да е отрицателен.",
        "COD cannot be negative.",
      ),
    );
  if (d.declaredValue && d.declaredValue > 0) {
    // CLAUDE.md: declared value goes to the vendor in the destination country's local currency.
    if (!d.localCurrency || t(d.codCurrency).toUpperCase() !== d.localCurrency.toUpperCase())
      out.push(
        f(
          "awb.declared_value.currency",
          "hard",
          "awb.declaredValue",
          d.localCurrency
            ? `Обявената стойност трябва да е в ${d.localCurrency}.`
            : "Няма настроена местна валута за държавата — обявената стойност не може да се изпрати.",
          d.localCurrency
            ? `Declared value must be in ${d.localCurrency}.`
            : "No local currency set up for the country — declared value cannot be sent.",
        ),
      );
  } else if (d.declaredValue != null && d.declaredValue < 0)
    out.push(
      f(
        "awb.declared_value.negative",
        "hard",
        "awb.declaredValue",
        "Обявената стойност не може да е отрицателна.",
        "Declared value cannot be negative.",
      ),
    );
  return out;
}

const opt = (v: string | null | undefined) => (blank(v) ? undefined : t(v));
const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;

/** createAWB body from a draft without hard findings (strict parse = last guard). */
export function buildCreateAwb(d: AwbDraft): CreateAwbBody {
  const country = t(d.country).toUpperCase();
  return CreateAwbBody.parse({
    senderId: d.senderId,
    ...(d.courierId ? { courierId: d.courierId } : {}),
    ...(opt(d.serviceName) ? { serviceName: opt(d.serviceName) } : {}),
    waybillAvailableDate: d.waybillAvailableDate,
    responseData: { id: true },
    recipient: {
      name: t(d.name),
      countryIsoCode: country,
      cityName: t(d.cityName),
      ...(opt(d.zip) ? { zipCode: opt(d.zip) } : {}),
      ...(opt(d.region) ? { region: opt(d.region) } : {}),
      ...(d.officeId ? { officeId: d.officeId } : {}),
      ...(opt(d.street) ? { streetName: opt(d.street) } : {}),
      ...(opt(d.buildingNumber) ? { buildingNumber: opt(d.buildingNumber) } : {}),
      ...(opt(d.addressText) ? { addressText: opt(d.addressText) } : {}),
      contactPerson: t(d.name).slice(0, 100),
      phoneNumber: awbPhone(d.phone, country),
      ...(opt(d.email) ? { email: opt(d.email) } : {}),
    },
    awb: {
      shipmentType: "pack",
      parcels: d.parcels,
      envelopes: 0,
      totalWeight: round(d.totalWeight!, 3),
      ...(d.declaredValue ? { declaredValue: round(d.declaredValue, 2) } : {}),
      bankRepayment: d.cod && d.cod > 0 ? round(d.cod, 2) : 0,
      ...(opt(d.observations) ? { observations: opt(d.observations) } : {}),
      openPackage: !!d.openPackage,
      shipmentPayer: "sender",
      referenceNumber: d.referenceNumber,
      ...(opt(d.contents) ? { products: opt(d.contents) } : {}),
    },
  });
}

/** preAWB body (different addressing rules: country always, street always, zip or region always). */
export function buildPreAwb(d: AwbDraft): PreAwbBody {
  const country = t(d.country).toUpperCase();
  return PreAwbBody.parse({
    senderId: d.senderId,
    ...(d.courierId ? { courierId: d.courierId } : {}),
    ...(opt(d.serviceName) ? { serviceName: opt(d.serviceName) } : {}),
    waybillAvailableDate: d.waybillAvailableDate,
    recipient: {
      name: t(d.name),
      countryIsoCode: country,
      cityName: t(d.cityName),
      ...(opt(d.zip) ? { zipCode: opt(d.zip) } : {}),
      ...(opt(d.region) ? { region: opt(d.region) } : {}),
      ...(d.officeId ? { officeId: d.officeId } : {}),
      streetName: t(d.street),
      ...(opt(d.buildingNumber) ? { buildingNumber: Number(t(d.buildingNumber)) } : {}),
      ...(opt(d.addressText) ? { addressText: opt(d.addressText) } : {}),
      contactPerson: t(d.name).slice(0, 100),
      phoneNumber: awbPhone(d.phone, country),
      ...(opt(d.email) ? { email: opt(d.email) } : {}),
    },
    awb: {
      parcels: d.parcels,
      envelopes: 0,
      totalWeight: round(d.totalWeight!, 3),
      ...(d.declaredValue ? { declaredValue: round(d.declaredValue, 2) } : {}),
      bankRepayment: d.cod && d.cod > 0 ? round(d.cod, 2) : 0,
      ...(opt(d.observations) ? { observations: opt(d.observations) } : {}),
      openPackage: !!d.openPackage,
      referenceNumber: d.referenceNumber,
      ...(opt(d.contents) ? { products: opt(d.contents) } : {}),
    },
  });
}
