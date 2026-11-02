import { z } from "zod";

/**
 * Zod schemas for the FHB Kika API v3 endpoints we use, written from docs/integrations/raw/fhb-kika-v3.openapi.json
 * (captured 2026-10-28, changelog 2026-07-29). Field names and limits are the vendor's; nothing here is invented.
 *
 * Requests are strict (we build them; an unknown key is a bug on our side). Responses are loose: new fields are
 * kept, documented enums (status, type, return_type) are plain strings so an unknown value is stored raw and
 * mapped to UNKNOWN instead of failing the parse (CLAUDE.md). Response fields are nullish unless an id.
 * Response bodies are NOT wrapped: the "response" key in the rendered reference is only the example's name.
 */

/** Ids are documented as strings; accept a number too (a numeric id must not fail the whole response). */
const Id = z.union([z.string(), z.number()]).transform((v) => String(v));
const str = z.string().nullish();
const num = z.number().nullish();
const bool = z.boolean().nullish();

/** PHP-style APIs may serialise an empty object as []: treat it as absent. */
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

export const FhbLoginRequest = z.object({ app_id: z.string().min(1), secret: z.string().min(1) }).strict();
export const FhbLoginResponse = z.looseObject({ token: z.string().min(1), expiration: str });
export type FhbLoginResponse = z.infer<typeof FhbLoginResponse>;

// ───────────── errors ─────────────

/** One violation; the delivery-point 400 example has plain strings instead of {code, message}. */
export const FhbViolation = z.union([z.looseObject({ code: str, message: str }), z.string()]);
/** `400 {message, violations: {"field.path": [{code, message}]}}`, `401/404 {message}`. */
export const FhbErrorBody = z.looseObject({
  message: str,
  violations: z.record(z.string(), z.array(FhbViolation)).nullish(),
});
export type FhbErrorBody = z.infer<typeof FhbErrorBody>;

// ───────────── products ─────────────

export const FHB_PRODUCT_NAME_MAX = 150;
export const FHB_URL_MAX = 255;

const ProductComponent = z.object({ id: z.string().min(1), quantity: z.number().int().min(1) }).strict();
const CustomsInformation = z
  .object({
    hs_code: z.string().min(1).max(255).optional(),
    country_of_origin: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional(),
    purchase_price: z.number().nonnegative().optional(),
  })
  .strict();

/** POST /product */
export const FhbProductCreate = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(FHB_PRODUCT_NAME_MAX),
    /** Sent on create only. FHB may correct it to the real EAN on the box: never overwrite it later. */
    ean: z.string().min(1).optional(),
    photo: z.string().max(FHB_URL_MAX).optional(),
    notify_url: z.string().max(FHB_URL_MAX).optional(),
    serial_numbers: z.boolean().optional(),
    type: z.enum(["single", "multi"]).optional(),
    items: z.array(ProductComponent).optional(),
    customs_information: CustomsInformation.optional(),
  })
  .strict();
export type FhbProductCreate = z.infer<typeof FhbProductCreate>;

/** PUT /product?id= (name is required by the spec; `new_id` renames). */
export const FhbProductUpdate = FhbProductCreate.omit({ id: true })
  .extend({ new_id: z.string().min(1).optional() })
  .strict();
export type FhbProductUpdate = z.infer<typeof FhbProductUpdate>;

export const FhbProductView = z.looseObject({
  id: Id,
  internal_code: str,
  ean: str,
  name: str,
  photo: str,
  weight: num,
  volumetric_weight: num,
  notify_url: str,
  archived: bool,
  stock_quantity: num,
  free_quantity: num,
  serial_numbers: bool,
  type: str,
  items: z.array(z.looseObject({ id: Id, name: str, quantity: z.number() })).nullish(),
  customs_information: objOrEmpty(
    z.looseObject({ hs_code: str, country_of_origin: str, purchase_price: num }),
  ),
});
export type FhbProductView = z.infer<typeof FhbProductView>;

/** GET /product/all?page= (250 per page). */
export const FhbProductPage = z.looseObject({
  page: z.number(),
  total: z.number(),
  products: z.array(FhbProductView),
});
export type FhbProductPage = z.infer<typeof FhbProductPage>;

// ───────────── orders ─────────────

export const FHB_EMAIL_MAX = 50;
export const FHB_PHONE_MAX = 20;
export const FHB_NOTE_MAX = 250;
export const FHB_NOTIFICATION_EVENTS = [
  "confirmed",
  "sent",
  "delivered",
  "returned",
  "ticket_created",
  "ticket_updated",
  "ticket_closed",
] as const;
export type FhbNotificationEvent = (typeof FHB_NOTIFICATION_EVENTS)[number];

const OrderAddress = z
  .object({
    name: z.string().min(1),
    street: z.string().min(1),
    city: z.string().min(1),
    zip: z.string().min(1),
    province: z.string().optional(),
    /** ISO 3166-1 alpha-2; the spec's own example sends lower case, we send upper case. */
    country: z.string().regex(/^[A-Za-z]{2}$/),
  })
  .strict();
const OrderContact = z
  .object({ email: z.string().min(1).max(FHB_EMAIL_MAX), phone: z.string().min(1).max(FHB_PHONE_MAX) })
  .strict();
const OrderItem = z.object({ id: z.string().min(1), quantity: z.number().int().min(1) }).strict();
const Notification = z
  .object(
    Object.fromEntries(
      FHB_NOTIFICATION_EVENTS.map((e) => [e, z.string().max(FHB_URL_MAX).optional()]),
    ) as Record<FhbNotificationEvent, z.ZodOptional<z.ZodString>>,
  )
  .strict();
const InvoiceDetail = z
  .object({
    number: z.string().min(1).max(40),
    total: z.number(),
    currency: z.string().length(3),
    date_of_issue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    products: z
      .array(
        z
          .object({
            code: z.string().min(1).max(255),
            description: z.string().min(1),
            hs_code: z.string().min(1).max(255),
            value: z.number(),
            quantity: z.number().int(),
            country_of_origin: z.string().regex(/^[A-Za-z]{2}$/),
          })
          .strict(),
      )
      .optional(),
    fees: z
      .array(
        z
          .object({
            type: z.enum(["shipping", "other", "discount"]),
            description: z.string(),
            value: z.number(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/** POST /order */
export const FhbOrderCreate = z
  .object({
    id: z.string().min(1),
    /** Required, unique, digits only, max 10. */
    variable_symbol: z.string().regex(/^\d{1,10}$/),
    parcel_service: z.string().min(1).optional(),
    delivery_point: z.string().min(1).max(255).optional(),
    delivery_point_parameters: z.record(z.string(), z.unknown()).nullable().optional(),
    /** Local currency of the destination country, always. */
    cod: z.number().nonnegative().optional(),
    /** Insurance value, local currency. */
    value: z.number().nonnegative().optional(),
    sender: z.string().min(1).optional(),
    validate: z.boolean().optional(),
    recipient: z.object({ address: OrderAddress, contact: OrderContact }).strict(),
    items: z.array(OrderItem).min(1),
    notification: Notification.optional(),
    invoice: z.string().max(255).optional(),
    invoice_number: z.string().max(255).optional(),
    invoice_date: z.string().optional(),
    note: z.string().max(FHB_NOTE_MAX).optional(),
    print_delivery_note: z.boolean().optional(),
    print_sscc: z.boolean().optional(),
    invoice_detail: InvoiceDetail.optional(),
  })
  .strict();
export type FhbOrderCreate = z.infer<typeof FhbOrderCreate>;

/** PUT /order?id= — the spec's body list for PUT has no id, validate or invoice_number. Only while `pending`. */
export const FhbOrderUpdate = FhbOrderCreate.omit({ id: true, validate: true, invoice_number: true })
  .extend({
    variable_symbol: z
      .string()
      .regex(/^\d{1,10}$/)
      .optional(),
  })
  .strict();
export type FhbOrderUpdate = z.infer<typeof FhbOrderUpdate>;

export const FhbOrderView = z.looseObject({
  id: Id,
  uid: str,
  variable_symbol: Id.nullish(),
  status: str,
  created_at: str,
  shipped_at: str,
  delivered_at: str,
  returned_at: str,
  return_type: str,
  parcel_service: str,
  delivery_point: str,
  cod: num,
  value: num,
  invoice: str,
  invoice_number: str,
  invoice_date: str,
  note: str,
  print_delivery_note: bool,
  print_sscc: bool,
  sscc: str,
  packing_packages: z.array(z.looseObject({ number: num, sscc: str })).nullish(),
  sender: str,
  recipient: objOrEmpty(
    z.looseObject({
      address: objOrEmpty(
        z.looseObject({ name: str, street: str, city: str, zip: str, province: str, country: str }),
      ),
      contact: objOrEmpty(z.looseObject({ email: str, phone: str })),
    }),
  ),
  notification: objOrEmpty(z.record(z.string(), z.string().nullable())),
  tracking_numbers: z.array(z.string()).nullish(),
  tracking_links: z.array(z.string()).nullish(),
  items: z
    .array(z.looseObject({ id: Id, quantity: z.number(), serial_numbers: z.array(z.string()).nullish() }))
    .nullish(),
  packages: z
    .array(
      z.looseObject({
        tracking_number: str,
        weight: num,
        package_dimension: objOrEmpty(
          z.looseObject({ length: num, width: num, height: num, volumetric_weight: num }),
        ),
      }),
    )
    .nullish(),
  attributes: z.array(z.looseObject({ key: z.string(), value: z.string().nullable() })).nullish(),
  tracking_events: z
    .array(z.looseObject({ date: str, message: str, event_code: str, carrier_event_code: str }))
    .nullish(),
  package_returns: z.array(z.looseObject({ tracking: str, return_tracking: str })).nullish(),
  proof_of_delivery: objOrEmpty(z.looseObject({ recipient: str, date: str })),
  invoice_detail: objOrEmpty(z.looseObject({})),
});
export type FhbOrderView = z.infer<typeof FhbOrderView>;

/** GET /order/history (100 per page). */
export const FhbOrderPage = z.looseObject({
  page: z.number(),
  total: z.number(),
  orders: z.array(FhbOrderView),
});
export type FhbOrderPage = z.infer<typeof FhbOrderPage>;

// ───────────── carriers ─────────────

export const FhbParcelServices = z.array(z.looseObject({ code: z.string(), name: str }));
export type FhbParcelServices = z.infer<typeof FhbParcelServices>;

export const FhbDeliveryPoints = z.array(
  z.looseObject({ id: Id, external_code: str, name: str, street: str, city: str, zip: str, country: str }),
);
export type FhbDeliveryPoints = z.infer<typeof FhbDeliveryPoints>;

// ───────────── stock levels and movements ─────────────

/** GET /stock/all (array, no paging) and GET /stock/history/{date}: physical `quantity` only. */
export const FhbStockLevel = z.looseObject({ id: Id, ean: str, name: str, quantity: num });
export const FhbStockLevels = z.array(FhbStockLevel);
export type FhbStockLevel = z.infer<typeof FhbStockLevel>;

/** GET /stock/movements (500 per page). `type` in|out is kept as a plain string (unknown values stay raw). */
export const FhbStockMovement = z.looseObject({
  id: Id,
  product: str,
  type: str,
  change: num,
  quantity: num,
  date: str,
  reason: str,
  order: str,
  stock_receipt: str,
});
export type FhbStockMovement = z.infer<typeof FhbStockMovement>;
export const FhbStockMovementPage = z.looseObject({
  page: z.number(),
  total: z.number(),
  movements: z.array(FhbStockMovement),
});
export type FhbStockMovementPage = z.infer<typeof FhbStockMovementPage>;

// ───────────── returns from the carrier (RMA) and local returns ─────────────

/** GET /rma/list (100 per page): items have the order structure with `returned_at` / `return_type`. */
export const FhbRmaPage = z.looseObject({
  page: z.number(),
  total: z.number(),
  items: z.array(FhbOrderView),
});
export type FhbRmaPage = z.infer<typeof FhbRmaPage>;

/** One local return (GET /return/list item and GET /return/{uid}). `type` basic|complex kept raw. */
export const FhbReturn = z.looseObject({
  id: Id.nullish(),
  uid: z.string().min(1),
  depot_id: Id.nullish(),
  type: str,
  status: str,
  weight: num,
  created_at: str,
  barcodes: z.array(z.string()).nullish(),
  items: z
    .array(
      z.looseObject({
        id: Id.nullish(),
        barcode: str,
        description: str,
        condition: str,
        quantity: num,
        action: str,
      }),
    )
    .nullish(),
  photos: z.array(z.looseObject({ id: Id, type: str })).nullish(),
});
export type FhbReturn = z.infer<typeof FhbReturn>;
export const FhbReturnPage = z.looseObject({
  page: z.number(),
  total: z.number(),
  items: z.array(FhbReturn),
});
export type FhbReturnPage = z.infer<typeof FhbReturnPage>;

// ───────────── cash on delivery ─────────────

/** Documented COD statuses; anything else is stored raw and alerted. */
export const FHB_COD_STATUSES = ["waiting", "received", "paid"] as const;

/** GET /cod?id= and GET /cod/list items. `cod` is in the destination's local currency. */
export const FhbCod = z.looseObject({
  id: Id,
  uid: str,
  variable_symbol: Id.nullish(),
  parcel_service: str,
  cod: num,
  status: str,
  received_at: str,
  paid_at: str,
  created_at: str,
});
export type FhbCod = z.infer<typeof FhbCod>;
export const FhbCodPage = z.looseObject({
  page: z.number(),
  total: z.number(),
  items: z.array(FhbCod),
});
export type FhbCodPage = z.infer<typeof FhbCodPage>;

// ───────────── stock receipts (inbound) ─────────────

const ReceiptItem = z.object({ id: z.string().min(1), quantity: z.number().int().min(1) }).strict();

/** POST /stock-receipt */
export const FhbStockReceiptCreate = z
  .object({
    id: z.string().min(1).max(255),
    name: z.string().min(1).max(50),
    delivery_service: z.string().min(1).optional(),
    tracking_code: z.string().min(1).max(255).optional(),
    expected_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    is_bianco: z.boolean().optional(),
    items: z.array(ReceiptItem).min(1),
  })
  .strict();
export type FhbStockReceiptCreate = z.infer<typeof FhbStockReceiptCreate>;

/** PUT /stock-receipt?id= — only while status is `created`. */
export const FhbStockReceiptUpdate = FhbStockReceiptCreate.omit({ id: true }).strict();
export type FhbStockReceiptUpdate = z.infer<typeof FhbStockReceiptUpdate>;

export const FhbStockReceiptView = z.looseObject({
  id: Id,
  status: str,
  name: str,
  delivery_service: str,
  tracking_code: str,
  expected_date: str,
  is_bianco: bool,
  created_date: str,
  items: z.array(z.looseObject({ id: Id, quantity: z.number(), received: num })).nullish(),
});
export type FhbStockReceiptView = z.infer<typeof FhbStockReceiptView>;

// ───────────── push notifications ─────────────

const loose = z.union([z.string(), z.number()]).nullish();
/**
 * Stock level notification body (POST to the product's notify_url): {id, type in|out, qty, stockQuantity,
 * reason 1..5, serialNumbers[]}. Only a HINT: no signature exists, numbers are re-read via GET /product.
 */
export const FhbStockNotification = z.looseObject({
  id: Id,
  type: str,
  qty: loose,
  stockQuantity: loose,
  reason: loose,
  serialNumbers: z.array(z.unknown()).nullish(),
});
export type FhbStockNotification = z.infer<typeof FhbStockNotification>;

/** Reason codes of the stock notification. */
export const FHB_STOCK_REASONS: Record<string, string> = {
  "1": "manual",
  "2": "sent_order",
  "3": "receipt",
  "4": "returned_order",
  "5": "cancelled_order",
};
