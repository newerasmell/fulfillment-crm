import { z } from "zod";
import { HistoryItem } from "./schemas";

/**
 * Zod schemas for the euShipments courier AWB services (INTEGRATION_NOTES §4.7), field by field from
 * docs/integrations/eushipments.md: Shipment_Creation_Web_Service_v1.5 (createAWB), Pre_AWB_Creation_Web_Service
 * v1.0 (preAWB), Shipment_Price_Web_Service_v1.1 (shipment-price), PDF_Web_Service_v1.2 (print/{awb}),
 * Merged_Print_Web_Service-v1.0 (merged/print), AWB_Deletion_Web_Service-v1.0 (delete/{awb}) and
 * Waybills_History_Web_Service-v1.0 (fulfilment/waybills-history). Nothing here is invented.
 *
 * Not modelled (not needed for manual parcels yet): pallet and NON-EU createAWB variants (awb.document,
 * customs_declaration), pickup AWB, courierRequest, returnLabel, INOUT label pre-AWBs. Request bodies are
 * defined WITHOUT `testMode` (the client adds it explicitly on every call). Responses are lenient.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
const vendorId = z.union([z.number(), z.string()]);

export const AWB_LIMITS = {
  nameMax: 100,
  cityMax: 100,
  zipMax: 15,
  streetMax: 200,
  /** preAWB: streetName max 100 and ALWAYS required. */
  preStreetMax: 100,
  addressTextMax: 100,
  phoneMax: 100,
  observationsMax: 100,
  productsMax: 1000,
  productsInfoMax: 2000,
  referenceMax: 100,
  totalWeightMin: 0.01,
  /** preAWB minimum total weight (higher than createAWB). */
  preTotalWeightMin: 0.5,
  mergedPrintMax: 50,
  waybillsHistoryMax: 100,
} as const;

const PackageDims = z
  .object({
    dimensions: z
      .object({
        width: z.number().min(0.1).optional(),
        height: z.number().min(0.1).optional(),
        length: z.number().min(0.1).optional(),
      })
      .strict()
      .optional(),
    weight: z.number().min(0.001).optional(),
  })
  .strict();

// ───────────────────────── createAWB ─────────────────────────

export const AwbRecipient = z
  .object({
    name: z.string().min(1).max(AWB_LIMITS.nameMax),
    cityId: z.number().int().positive().optional(),
    countryIsoCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    cityName: z.string().min(1).max(AWB_LIMITS.cityMax).optional(),
    zipCode: z.string().min(1).max(AWB_LIMITS.zipMax).optional(),
    region: z.string().min(1).max(100).optional(),
    officeId: z.number().int().positive().optional(),
    officeCode: z.string().min(1).optional(),
    streetName: z.string().min(1).max(AWB_LIMITS.streetMax).optional(),
    buildingNumber: z.string().min(1).max(100).optional(),
    addressText: z.string().max(AWB_LIMITS.addressTextMax).optional(),
    contactPerson: z.string().max(100).optional(),
    phoneNumber: z.string().min(1).max(AWB_LIMITS.phoneMax),
    email: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.officeId == null && !r.officeCode && !r.streetName)
      ctx.addIssue({ code: "custom", path: ["streetName"], message: "required unless officeId/officeCode" });
    if (r.cityId == null) {
      if (!r.countryIsoCode)
        ctx.addIssue({ code: "custom", path: ["countryIsoCode"], message: "required without cityId" });
      if (!r.cityName)
        ctx.addIssue({ code: "custom", path: ["cityName"], message: "required without cityId" });
      if (!r.zipCode && !r.region)
        ctx.addIssue({ code: "custom", path: ["zipCode"], message: "zipCode or region" });
    }
    if (r.countryIsoCode === "RO" && r.cityId == null && !r.region)
      ctx.addIssue({ code: "custom", path: ["region"], message: "region is required for Romania" });
  });

export const AwbBlock = z
  .object({
    shipmentType: z.enum(["pack", "pallet"]).optional(),
    parcels: z.number().int().min(0),
    envelopes: z.number().int().min(0),
    totalWeight: z.number().min(AWB_LIMITS.totalWeightMin),
    declaredValue: z.number().min(0).optional(),
    bankRepayment: z.number().min(0).optional(),
    observations: z.string().max(AWB_LIMITS.observationsMax).optional(),
    openPackage: z.boolean().optional(),
    /** Present in the reference example ("Always sender"). */
    shipmentPayer: z.enum(["sender", "recipient"]).optional(),
    referenceNumber: z.string().min(1).max(AWB_LIMITS.referenceMax),
    products: z.string().max(AWB_LIMITS.productsMax).optional(),
    fragile: z.boolean().optional(),
    productsInfo: z.string().max(AWB_LIMITS.productsInfoMax).optional(),
    piecesInPack: z.number().int().min(0).optional(),
    /** Keyed "1", "2", … as in the reference example. */
    packages: z.record(z.string().regex(/^\d+$/), PackageDims).optional(),
  })
  .strict();

export const CreateAwbBody = z
  .object({
    senderId: z.number().int().positive(),
    courierId: z.number().int().positive().optional(),
    serviceName: z.string().min(1).optional(),
    waybillAvailableDate: isoDate,
    responseData: z.object({ id: z.boolean() }).strict().optional(),
    recipient: AwbRecipient,
    awb: AwbBlock,
    products: z
      .array(
        z
          .object({
            refNumber: z.string().min(1),
            qty: z.number().int().min(1),
            price: z.number().min(0).optional(),
            priceWithoutVat: z.number().min(0).optional(),
          })
          .strict(),
      )
      .optional(),
    sender: z
      .object({
        name: z.string().max(255).optional(),
        phoneNumber: z.string().max(20).optional(),
        email: z.string().email().optional(),
      })
      .strict()
      .optional(),
    invoice: z
      .object({ number: z.string().max(30).optional(), issueDate: isoDate.optional() })
      .strict()
      .optional(),
  })
  .strict();
export type CreateAwbBody = z.infer<typeof CreateAwbBody>;

/** 200: `{awb, barcode, returnLabelNumber, packagesBarcodes, id?}`; an error body is `{error}`. */
export const CreateAwbResponse = z
  .object({
    awb: vendorId.nullish(),
    id: vendorId.nullish(),
    barcode: z.string().nullish(),
    returnLabelNumber: z.union([z.string(), z.number()]).nullish(),
    packagesBarcodes: z.array(z.string()).nullish(),
    error: z.union([z.string(), z.boolean(), z.null()]).optional(),
  })
  .passthrough();
export type CreateAwbResponse = z.infer<typeof CreateAwbResponse>;

// ───────────────────────── preAWB ─────────────────────────

export const PreAwbBody = z
  .object({
    senderId: z.number().int().positive(),
    courierId: z.number().int().positive().optional(),
    serviceName: z.string().min(1).optional(),
    waybillAvailableDate: isoDate,
    recipient: z
      .object({
        name: z.string().min(1).max(AWB_LIMITS.nameMax),
        countryIsoCode: z.string().regex(/^[A-Z]{2}$/),
        cityId: z.number().int().positive().optional(),
        cityName: z.string().min(1).max(AWB_LIMITS.cityMax).optional(),
        zipCode: z.string().min(1).max(AWB_LIMITS.zipMax).optional(),
        region: z.string().min(1).max(100).optional(),
        officeId: z.number().int().positive().optional(),
        officeCode: z.string().min(1).optional(),
        streetName: z.string().min(1).max(AWB_LIMITS.preStreetMax),
        buildingNumber: z.number().int().optional(),
        addressText: z.string().max(AWB_LIMITS.addressTextMax).optional(),
        contactPerson: z.string().max(100).optional(),
        phoneNumber: z.string().min(1).max(AWB_LIMITS.phoneMax),
        email: z.string().email().optional(),
      })
      .strict()
      .superRefine((r, ctx) => {
        if (r.cityId == null && !(r.cityName && r.zipCode))
          ctx.addIssue({ code: "custom", path: ["cityName"], message: "cityId, or cityName AND zipCode" });
        if (!r.zipCode && !r.region)
          ctx.addIssue({ code: "custom", path: ["zipCode"], message: "zipCode or region, always" });
      }),
    awb: z
      .object({
        parcels: z.number().int().min(0),
        envelopes: z.number().int().min(0),
        totalWeight: z.number().min(AWB_LIMITS.preTotalWeightMin),
        declaredValue: z.number().min(0).optional(),
        bankRepayment: z.number().min(0).optional(),
        observations: z.string().max(AWB_LIMITS.observationsMax).optional(),
        openPackage: z.boolean().optional(),
        referenceNumber: z.string().min(1).max(AWB_LIMITS.referenceMax),
        products: z.string().max(AWB_LIMITS.productsMax).optional(),
        fragile: z.boolean().optional(),
        productsInfo: z.string().max(AWB_LIMITS.productsInfoMax).optional(),
        packages: z.array(PackageDims).optional(),
      })
      .strict(),
  })
  .strict();
export type PreAwbBody = z.infer<typeof PreAwbBody>;

/** 201 `{orderId, error: false, code: 201}`; business error `{orderId: null, error: "…", code: 422}`. */
export const PreAwbResponse = z
  .object({
    orderId: vendorId.nullish(),
    error: z.union([z.string(), z.boolean(), z.null()]).optional(),
    code: z.union([z.number(), z.string()]).nullish(),
    inoutLabelNum: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

// ───────────────────────── shipment-price ─────────────────────────

export const ShipmentPriceBody = z
  .object({
    courierId: z.number().int().positive(),
    companyId: z.number().int().positive(),
    weight: z.number().positive(),
    codAmount: z.number().min(0),
    openPackage: z.boolean(),
    /** Insurance in BGN (reference). */
    insuranceAmount: z.number().min(0),
    returnDocs: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    saturdayDelivery: z.boolean().optional(),
    toOffice: z.boolean(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    serviceId: z.number().int().positive().optional(),
    length: z.number().min(0).max(999).optional(),
    width: z.number().min(0).max(999).optional(),
    height: z.number().min(0).max(999).optional(),
  })
  .strict();
export type ShipmentPriceBody = z.infer<typeof ShipmentPriceBody>;

const price = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v == null ? null : String(v)));
/** All prices in EUR without VAT. An all-zero answer means "no price available", never a real quote. */
export const ShipmentPriceResponse = z
  .object({
    price,
    pr_weight: price,
    pr_cod: price,
    pr_ins: price,
    pr_check: price,
    pr_ret: price,
    pr_fulfill: price,
    pr_sat_del: price,
    pr_sms: price,
  })
  .passthrough();
export type ShipmentPriceResponse = z.infer<typeof ShipmentPriceResponse>;

export function isNoPrice(r: ShipmentPriceResponse) {
  const vals = [
    r.price,
    r.pr_weight,
    r.pr_cod,
    r.pr_ins,
    r.pr_check,
    r.pr_ret,
    r.pr_fulfill,
    r.pr_sat_del,
    r.pr_sms,
  ];
  return vals.every((v) => v === null || Number(v) === 0);
}

// ───────────────────────── print / merged print / delete / history ─────────────────────────

export const PrintResponse = z.object({ type: z.string(), awb_print: z.string().min(1) }).passthrough();

export const MergedPrintResponse = z
  .object({
    success: z.boolean(),
    message: z.string().nullish(),
    errorPrinting: z
      .union([z.record(z.string(), z.string()), z.array(z.unknown()).max(0)])
      .nullish()
      .transform((v) => (v && !Array.isArray(v) ? v : {})),
    base64_pdf: z.string().nullish(),
  })
  .passthrough();

export const DeleteAwbResponse = z
  .object({
    success: z.boolean(),
    awb: z.union([z.string(), z.number()]).nullish(),
    error: z.string().nullish(),
  })
  .passthrough();

/** Same item shape as orders-history (+ courier), looked up strictly by AWB number. */
export const WaybillHistoryItem = HistoryItem.extend({
  courierId: vendorId.nullish(),
  courierName: z.string().nullish(),
});
export const WaybillsHistoryResponse = z.array(WaybillHistoryItem);
export type WaybillHistoryItem = z.infer<typeof WaybillHistoryItem>;
