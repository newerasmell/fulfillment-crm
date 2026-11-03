import { z } from "zod";

/**
 * Zod schemas for the FHB Joy API (label printing for parcels we pack ourselves), written from
 * docs/integrations/raw/fhb-joy.openapi.json (captured 2026-10-28; rendered in docs/integrations/fhb-joy.md).
 * Field names and limits are the vendor's; nothing here is invented.
 *
 * Joy is camelCase, and `/packages` names the zip field `psc` while `/shipments` calls it `zip`.
 * Requests are strict (we build them; an unknown key is a bug on our side). Responses are loose: new fields are
 * kept and the documented `status` enum is a plain string, so an unknown value is stored raw and mapped to
 * UNKNOWN instead of failing the parse (CLAUDE.md). `_embedded` is serialised as `[]` when empty.
 */

const str = z.string().nullish();
/** Joy documents numbers; a PHP backend may send numeric strings — accept both, keep a number. */
const numLike = z
  .union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)])
  .transform((v) => Number(v))
  .nullish();

/** PHP-style APIs serialise an empty object as []: treat it as absent. */
const objOrEmpty = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .union([
      schema,
      z
        .array(z.unknown())
        .max(0)
        .transform(() => null),
    ])
    .nullish()
    .transform((v) => v ?? null);

// ───────────── auth ─────────────

/** POST /login — camelCase `appId` (unlike FHB v3's `app_id`). */
export const JoyLoginRequest = z.object({ appId: z.string().min(1), secret: z.string().min(1) }).strict();
export const JoyLoginResponse = z.looseObject({ token: z.string().min(1).max(200), expiration: str });
export type JoyLoginResponse = z.infer<typeof JoyLoginResponse>;

// ───────────── errors ─────────────

/** `{status: "error", message, id}` — `id` names the offending field on validation errors. */
export const JoyErrorBody = z.looseObject({ status: str, message: str, id: str });
export type JoyErrorBody = z.infer<typeof JoyErrorBody>;

// ───────────── shared ─────────────

export const JOY_LIMITS = {
  nameMin: 3,
  streetMin: 3,
  cityMin: 2,
  zipMin: 3,
  zipMax: 12,
  emailMax: 50,
  phoneMin: 6,
  phoneMax: 20,
  /**
   * CRM limit for POST /shipments `note` — the reference gives no maximum there (only POST /packages documents
   * `note` ≤250); we keep the same 250 as a conservative CRM-side rule, not a vendor rule.
   */
  noteMax: 250,
  notifyUrlMax: 255,
  /** `posta_expres`: the variable symbol must be numeric and at most 10 characters. */
  postaExpresVsMax: 10,
  /** GET /labels?ids= accepts at most 100 ids. */
  labelsMax: 100,
  /** GET /shipments?id= (reprint) is refused more than 5 days after creation. */
  reprintDays: 5,
  /** /packages: `id` ≤ 30, name 3–100, street 3–255, city 2–50, psc 3–10, variableSymbol ≤ 40. */
  packageIdMax: 30,
} as const;

const NotifyLinks = z
  .object({
    confirmed: z.string().url().max(JOY_LIMITS.notifyUrlMax).optional(),
    sent: z.string().url().max(JOY_LIMITS.notifyUrlMax).optional(),
    delivered: z.string().url().max(JOY_LIMITS.notifyUrlMax).optional(),
    returned: z.string().url().max(JOY_LIMITS.notifyUrlMax).optional(),
  })
  .strict();

/** Customs declaration ("colné údaje"), non-EU destinations. */
export const JoyInvoiceDetail = z
  .object({
    number: z.string().min(1),
    total: z.number(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    dateOfIssue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    products: z
      .array(
        z
          .object({
            description: z.string().min(1),
            hsCode: z.string().min(1),
            value: z.number(),
            quantity: z.number().int(),
            countryOfOrigin: z.string().regex(/^[a-z]{2}$/),
          })
          .strict(),
      )
      .optional(),
    fees: z
      .array(
        z
          .object({
            type: z.enum(["shipping", "discount", "other"]),
            description: z.string().min(1),
            value: z.number(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

// ───────────── shipments (synchronous: create + label in one call) ─────────────

/** POST /shipments — `id` in the BODY (a `?id=` on a create gives 405). */
export const JoyShipmentCreate = z
  .object({
    id: z.string().min(1),
    parcelService: z.string().min(1),
    name: z.string().min(JOY_LIMITS.nameMin),
    street: z.string().min(JOY_LIMITS.streetMin),
    city: z.string().min(JOY_LIMITS.cityMin),
    province: z.string().nullable().optional(),
    zip: z.string().min(JOY_LIMITS.zipMin).max(JOY_LIMITS.zipMax),
    country: z.string().regex(/^[a-z]{2}$/),
    email: z.string().email().max(JOY_LIMITS.emailMax),
    phone: z.string().min(JOY_LIMITS.phoneMin).max(JOY_LIMITS.phoneMax),
    variableSymbol: z.string().min(1),
    /** Must always be in the delivery country's local currency (reference warning). */
    cod: z.number().min(0).optional(),
    sender: z.string().min(1).optional(),
    senderName: z.string().min(1).optional(),
    note: z.string().max(JOY_LIMITS.noteMax).optional(),
    numberOfPackages: z.number().int().min(1),
    weight: z.array(z.number().positive()).optional(),
    deliveryPoint: z.string().min(1).optional(),
    labelOrientation: z.enum(["L", "P"]).optional(),
    _embedded: z
      .object({ notifyLinks: z.array(NotifyLinks) })
      .strict()
      .optional(),
    invoiceDetail: JoyInvoiceDetail.optional(),
  })
  .strict()
  .refine((b) => !b.weight || b.weight.length === b.numberOfPackages, {
    message: "weight must have one entry per package",
    path: ["weight"],
  });
export type JoyShipmentCreate = z.infer<typeof JoyShipmentCreate>;

/** 200 of POST /shipments and GET /shipments (reprint): tracking per package + base64 PDF label. */
export const JoyShipmentLabel = z.looseObject({
  packages: z
    .array(
      z.looseObject({ id: z.union([z.string(), z.number()]).transform(String).nullish(), tracking: str }),
    )
    .nullish(),
  label: str,
  _links: z.looseObject({ self: z.looseObject({ href: str }).nullish() }).nullish(),
});
export type JoyShipmentLabel = z.infer<typeof JoyShipmentLabel>;

/** Documented statuses of GET /shipment and GET /packages (stored raw; unknown → UNKNOWN). */
export const JOY_STATUSES = [
  "pending",
  "confirmed",
  "sent",
  "delivered",
  "returned",
  "rejected",
  "undefined",
] as const;

const Embedded = objOrEmpty(
  z.looseObject({
    trackingNumber: z.array(z.string()).nullish(),
    trackingLink: z.array(z.string()).nullish(),
    items: z.array(z.looseObject({ id: str, qty: numLike })).nullish(),
    trackingEvents: z.array(z.looseObject({ date: str, message: str })).nullish(),
  }),
);

/** GET /shipment?id= — detail with tracking. */
export const JoyShipmentInfo = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String).nullish(),
  status: str,
  parcelService: str,
  name: str,
  zip: str,
  variableSymbol: z.union([z.string(), z.number()]).transform(String).nullish(),
  cod: numLike,
  _embedded: Embedded,
});
export type JoyShipmentInfo = z.infer<typeof JoyShipmentInfo>;

/** GET /labels?id= | ?ids=a,b (≤100): one base64 A6 PDF. */
export const JoyLabels = z.looseObject({ labels: z.string().min(1) });

// ───────────── packages (asynchronous flow: create now, label later via /labels) ─────────────

export const JoyPackageCreate = z
  .object({
    id: z.string().min(1).max(JOY_LIMITS.packageIdMax),
    /** Optional at the vendor and silently defaults to `joy`: we always send it (INTEGRATION_NOTES §3). */
    parcelService: z.string().min(1),
    name: z.string().min(3).max(100),
    street: z.string().min(3).max(255),
    city: z.string().min(2).max(50),
    psc: z.string().min(3).max(10),
    country: z.string().regex(/^[a-z]{2}$/),
    email: z.string().email().max(JOY_LIMITS.emailMax),
    phone: z.string().min(JOY_LIMITS.phoneMin).max(JOY_LIMITS.phoneMax),
    variableSymbol: z.string().min(1).max(40),
    cod: z.number().min(0).optional(),
    note: z.string().max(JOY_LIMITS.noteMax).optional(),
    invoiceLink: z.string().url().max(255).optional(),
    numberOfPackages: z.number().int().min(1).optional(),
    deliveryPoint: z.string().min(1).optional(),
    weight: z.array(z.number().positive()).optional(),
    _embedded: z
      .object({ notifyLinks: z.array(NotifyLinks) })
      .strict()
      .optional(),
  })
  .strict();
export type JoyPackageCreate = z.infer<typeof JoyPackageCreate>;

/** 201/200 of POST/PUT /packages: a HAL self link only. */
export const JoyHalLink = z.looseObject({
  _links: z.looseObject({ self: z.looseObject({ href: str }).nullish() }).nullish(),
});

/** GET /packages?id= */
export const JoyPackageInfo = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String).nullish(),
  status: str,
  parcelService: str,
  barcode: str,
  _embedded: Embedded,
});
export type JoyPackageInfo = z.infer<typeof JoyPackageInfo>;

// ───────────── delivery points ─────────────

export const JoyDeliveryPoint = z.looseObject({
  code: z.union([z.string(), z.number()]).transform(String),
  name: str,
  street: str,
  city: str,
  zip: str,
  country: str,
  latitude: numLike,
  longitude: numLike,
});
export const JoyDeliveryPoints = z.array(JoyDeliveryPoint);
export type JoyDeliveryPoint = z.infer<typeof JoyDeliveryPoint>;
