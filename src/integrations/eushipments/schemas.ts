import { z } from "zod";

/**
 * Zod schemas for the euShipments fulfilment endpoints we use, taken field by field from
 * docs/integrations/eushipments.md (Order_Creation v1.2, Attach_PDF_Files v1.0, Orders_History v1.0,
 * Product_Creation v1.1, Booking_Request_Creation v1.1, Order_Deletion v1.0, Product_List v1.0,
 * Transfer_Creation v1.0). Nothing here is invented: a field that is not in the reference is not here.
 *
 * Request bodies are defined WITHOUT `testMode`: the transport adds it explicitly on every call (true only for a
 * DRY_RUN validate-only send), so a stored outbox payload can never carry a stale test flag.
 *
 * Response schemas are lenient (`passthrough`, ids as number-or-string): the vendor's examples mix types
 * (e.g. "LENGTH_ITEM": "20.50"), and an unexpected extra field must never break parsing.
 */

// ───────────────────────── shared ─────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
/** Printable ASCII (space to `~`) — the booking-request rule for clientReference / ref1–3. */
const printableAscii = z.string().regex(/^[\x20-\x7E]*$/, "printable ASCII only");
const vendorId = z.union([z.number(), z.string()]);
/** `error` is `false` on success, otherwise a text (sometimes null in read responses). */
const vendorError = z.union([z.literal(false), z.string(), z.null()]).optional();

export const SERVICE_NAMES = [
  "crossborder",
  "eushipmentsairexpress",
  "eushipmentsglobal economy",
  "eushipmentsglobal premium",
] as const;

// ───────────────────────── create-order ─────────────────────────

export const Recipient = z
  .object({
    name: z.string().min(1).max(100),
    cityId: z.number().int().positive().nullable().optional(),
    countryIsoCode: z
      .string()
      .regex(/^[A-Z]{2}$/, "uppercase ISO 3166-1 alpha-2")
      .nullable()
      .optional(),
    cityName: z.string().max(100).nullable().optional(),
    zipCode: z.string().max(15).nullable().optional(),
    region: z.string().max(100).nullable().optional(),
    officeId: z.number().int().positive().nullable().optional(),
    officeCode: z.string().nullable().optional(),
    streetName: z.string().max(200).nullable().optional(),
    buildingNumber: z.string().max(100).nullable().optional(),
    addressText: z.string().max(300).nullable().optional(),
    contactPerson: z.string().max(100).nullable().optional(),
    phoneNumber: z.string().min(1).max(100),
    email: z.string().nullable().optional(),
  })
  .superRefine((r, ctx) => {
    const toOffice = r.officeId != null || !!r.officeCode;
    if (!toOffice && !r.streetName)
      ctx.addIssue({ code: "custom", path: ["streetName"], message: "required unless officeId/officeCode" });
    if (r.cityId == null) {
      if (!r.countryIsoCode)
        ctx.addIssue({ code: "custom", path: ["countryIsoCode"], message: "required without cityId" });
      if (!r.cityName)
        ctx.addIssue({ code: "custom", path: ["cityName"], message: "required without cityId" });
      if (!r.zipCode && !r.region)
        ctx.addIssue({ code: "custom", path: ["zipCode"], message: "zipCode or region required" });
    }
    if (r.countryIsoCode === "RO" && !r.region)
      ctx.addIssue({ code: "custom", path: ["region"], message: "region is required for Romania" });
  });

export const Awb = z.object({
  parcels: z.number().int().min(0),
  envelopes: z.number().int().min(0),
  totalWeight: z.number().min(0.01),
  declaredValue: z.number().min(0).optional(),
  bankRepayment: z.number().min(0).optional(),
  otherRepayment: z.string().max(100).nullable().optional(),
  observations: z.string().max(300).nullable().optional(),
  openPackage: z.boolean().optional(),
  shipmentPayer: z.enum(["sender", "recipient"]).optional(),
  saturdayDelivery: z.boolean().optional(),
  referenceNumber: z.string().min(1).max(100),
  referenceNumberDate: isoDate.optional(),
  products: z.string().max(1000).optional(),
  fragile: z.boolean().optional(),
  productsInfo: z.string().max(2000).optional(),
  piecesInPack: z.number().int().min(0).optional(),
});

export const OrderProduct = z.object({
  refNumber: z.string().min(1),
  qty: z.number().int().min(1),
  price: z.number().min(0).optional(),
  priceWithoutVat: z.number().min(0).optional(),
});

export const CreateOrderBody = z.object({
  senderId: z.number().int().positive(),
  courierId: z.number().int().positive().optional(),
  waybillAvailableDate: isoDate,
  serviceName: z.enum(SERVICE_NAMES).optional(),
  recipient: Recipient,
  awb: Awb,
  products: z.array(OrderProduct).min(1),
  invoice: z.object({ number: z.string().max(30), issueDate: isoDate.optional() }).optional(),
  customsData: z
    .object({ dutyPaymentInfo: z.enum(["DDU", "DDP"]), customsValue: z.number().min(0) })
    .optional(),
});
export type CreateOrderBody = z.infer<typeof CreateOrderBody>;

export const CreateOrderResponse = z
  .object({ orderId: vendorId.nullable().optional(), error: vendorError, code: z.number().optional() })
  .passthrough();
export type CreateOrderResponse = z.infer<typeof CreateOrderResponse>;

// ───────────────────────── attach-pdf-files ─────────────────────────

export const AttachPdfBody = z
  .object({
    orderId: z.number().int().positive().nullable().optional(),
    referenceNumber: z.string().min(1).max(100).nullable().optional(),
    /** Max one file per request (spec). */
    files: z.array(z.object({ base64Attached: z.string().min(1) })).length(1),
  })
  .refine((b) => b.orderId != null || !!b.referenceNumber, "orderId or referenceNumber is required");
export type AttachPdfBody = z.infer<typeof AttachPdfBody>;

export const AttachPdfItem = z
  .object({
    error: vendorError,
    orderId: vendorId.nullable().optional(),
    referenceNumber: z.string().nullable().optional(),
    pdfId: vendorId.nullable().optional(),
    pdfCode: z.string().nullable().optional(),
    code: z.number().optional(),
  })
  .passthrough();
export const AttachPdfResponse = z.array(AttachPdfItem);

// ───────────────────────── orders-history ─────────────────────────

export const StatusRecord = z
  .object({
    /** A record id, NOT a status id (INTEGRATION_NOTES §4.5). */
    ID: vendorId,
    STATUS: z.string(),
    DATE: z.string().nullable().optional(),
    DATE_CREATED: z.string().nullable().optional(),
    COMMENT: z.string().nullable().optional(),
    PARTNER_VOUCHER: z.string().nullable().optional(),
  })
  .passthrough();
export type StatusRecord = z.infer<typeof StatusRecord>;

export const HistoryItem = z
  .object({
    refNum: z.union([z.string(), z.number()]).nullable().optional(),
    awb: z.string().nullable().optional(),
    newReturnNumber: z.string().nullable().optional(),
    error: vendorError,
    errorCode: z.union([z.number(), z.string()]).nullable().optional(),
    statusesHistory: z.array(StatusRecord).nullable().optional(),
    items: z
      .array(
        z
          .object({
            refNumber: z.string().nullable().optional(),
            sn: z.string().nullable().optional(),
            qty: z.number().optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();
export type HistoryItem = z.infer<typeof HistoryItem>;
export const OrdersHistoryResponse = z.array(HistoryItem);

// ───────────────────────── products ─────────────────────────

const dimension = z.number().min(0.1).max(999);
export const CreateProductBody = z.object({
  companyId: z.number().int().positive(),
  product: z.object({
    name: z.string().min(1).max(200),
    barcode: z.string().min(1).max(50),
    refNumber: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    length: dimension,
    width: dimension,
    height: dimension,
    weight: z.number().min(0.01).max(999),
    hsCode: z.string().optional(),
  }),
});
export type CreateProductBody = z.infer<typeof CreateProductBody>;

export const CreateProductResponse = z
  .object({ productId: vendorId.nullable().optional(), error: vendorError })
  .passthrough();

export const VendorProductRow = z
  .object({
    ID: vendorId,
    NAME: z.string().nullable().optional(),
    DESCRIPTION: z.string().nullable().optional(),
    LENGTH_ITEM: z.union([z.string(), z.number()]).nullable().optional(),
    WIDTH: z.union([z.string(), z.number()]).nullable().optional(),
    HEIGHT: z.union([z.string(), z.number()]).nullable().optional(),
    WEIGHT: z.union([z.string(), z.number()]).nullable().optional(),
    REFERENCE_NUMBER: z.string(),
  })
  .passthrough();
export type VendorProductRow = z.infer<typeof VendorProductRow>;
export const GetProductsResponse = z.array(VendorProductRow);

// ───────────────────────── booking request ─────────────────────────

const ref100 = printableAscii.max(100).nullable().optional();
export const CreateRequestBody = z.object({
  companyId: z.number().int().positive(),
  warehouseId: z.number().int().positive(),
  /** If sent, cannot be empty (spec). */
  courierInc: z.string().min(1).max(50).optional(),
  trackNumb: z.string().min(1).max(50).optional(),
  deliveryDate: isoDate.optional(),
  packagesCount: z.number().int().min(1).optional(),
  clientReference: ref100,
  ref1: ref100,
  ref2: ref100,
  ref3: ref100,
  products: z.array(z.object({ refNumber: z.string().min(1), quantity: z.number().int().min(1) })).min(1),
});
export type CreateRequestBody = z.infer<typeof CreateRequestBody>;

export const CreateRequestResponse = z
  .object({ requestId: vendorId.nullable().optional(), error: vendorError })
  .passthrough();

// ───────────────────────── transfer ─────────────────────────

export const TransferItem = z
  .object({
    refNumber: z.string().min(1).optional(),
    barcode: z.string().min(1).optional(),
    quantity: z.number().int().min(1),
    batchNo: z.string().min(1).optional(),
    batchDate: isoDate.optional(),
  })
  .refine((i) => !!i.refNumber || !!i.barcode, "refNumber or barcode is required")
  .refine((i) => !!i.batchNo === !!i.batchDate, "batchNo and batchDate go together");

export const CreateTransferBody = z
  .object({
    companyId: z.number().int().positive(),
    sourceWarehouseId: z.number().int().positive(),
    destinationWarehouseId: z.number().int().positive().optional(),
    /** 1 = NORMAL, 3 = SCRAP (2 is admin-only). */
    protocolType: z.union([z.literal(1), z.literal(3)]).optional(),
    needCheck: z.boolean().optional(),
    comments: z.string().optional(),
    receiver: z.string().optional(),
    waybill: z.string().optional(),
    instructions: z.string().optional(),
    externalRef: z.string().min(1).max(100),
    items: z.array(TransferItem).min(1),
  })
  .refine(
    (b) => b.destinationWarehouseId === undefined || b.destinationWarehouseId !== b.sourceWarehouseId,
    "destination warehouse must differ from source",
  );
export type CreateTransferBody = z.infer<typeof CreateTransferBody>;

export const CreateTransferResponse = z
  .object({
    protocolId: vendorId.nullable().optional(),
    isConfirmed: z.union([z.number(), z.boolean()]).nullable().optional(),
    protocolType: z.number().nullable().optional(),
    externalRef: z.string().optional(),
    isDeleted: z.boolean().optional(),
    error: vendorError,
  })
  .passthrough();
export type CreateTransferResponse = z.infer<typeof CreateTransferResponse>;

// ───────────────────────── delete ─────────────────────────

export const DeleteOrderResponse = z
  .object({ error: vendorError, message: z.string().nullable().optional(), code: z.number().optional() })
  .passthrough();

/** Generic error body: `{error, code, message?}` (INTEGRATION_NOTES §0), or anything else readable. */
export const ErrorBody = z
  .object({
    error: z.union([z.string(), z.boolean(), z.null()]).optional(),
    message: z
      .union([z.string(), z.array(z.string())])
      .nullable()
      .optional(),
    messages: z.array(z.string()).optional(),
    code: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();
