import {
  AWB_LIMITS,
  CreateAwbBody,
  CreateAwbResponse,
  DeleteAwbResponse,
  MergedPrintResponse,
  PreAwbBody,
  PreAwbResponse,
  PrintResponse,
  ShipmentPriceBody,
  ShipmentPriceResponse,
  WaybillsHistoryResponse,
  type WaybillHistoryItem,
} from "./awb-schemas";
import { EuShipmentsClient } from "./client";

/** AWB numbers go into URL paths: digits/letters only, never a free-form string. */
function awbNumber(awb: string) {
  const v = String(awb).trim();
  if (!/^[A-Za-z0-9-]{1,40}$/.test(v)) throw new Error("invalid AWB number");
  return v;
}

/**
 * euShipments courier AWB services (INTEGRATION_NOTES §4.7) on top of the fulfilment client: same Bearer
 * token, same discipline — writes (createAWB, preAWB, delete) are never retried here and return only DEFINITE
 * answers (anything else throws `unknown_outcome`); reads (price, print, merged print, waybills-history)
 * retry and must parse. Every write takes `testMode` explicitly where the reference defines it.
 */
export class EuAwbClient extends EuShipmentsClient {
  /** POST /createAWB — creates a REAL courier shipment unless testMode. referenceNumber is not unique there. */
  async createAwb(body: CreateAwbBody, testMode: boolean) {
    return this.write(
      "createAWB",
      "POST",
      "/createAWB",
      { testMode, ...CreateAwbBody.parse(body) },
      CreateAwbResponse,
    );
  }

  /** POST /preAWB — registers the order without a courier waybill (service must be activated for the sender). */
  async preAwb(body: PreAwbBody, testMode: boolean) {
    return this.write("preAWB", "POST", "/preAWB", { testMode, ...PreAwbBody.parse(body) }, PreAwbResponse);
  }

  /** DELETE /delete/{waybillNum} — removes the AWB (and cancels it at the courier where supported). No testMode. */
  async deleteAwb(awb: string) {
    return this.write(
      "delete-awb",
      "DELETE",
      `/delete/${encodeURIComponent(awbNumber(awb))}`,
      undefined,
      DeleteAwbResponse,
    );
  }

  /** POST /shipment-price — a quote (EUR, without VAT). Changes nothing at the vendor. */
  async shipmentPrice(body: ShipmentPriceBody) {
    return this.read(
      "shipment-price",
      "POST",
      "/shipment-price",
      ShipmentPriceBody.parse(body),
      ShipmentPriceResponse,
    );
  }

  /** GET /print/{awb}?testMode= — label of the MAIN parcel (base64 PDF, or raw ZPL for printFileType 3). */
  async print(awb: string, opts: { testMode?: boolean; printFileType?: 1 | 2 | 3 } = {}) {
    const q = new URLSearchParams({ testMode: opts.testMode ? "1" : "0" });
    if (opts.printFileType) q.set("printFileType", String(opts.printFileType));
    return this.read(
      "print",
      "GET",
      `/print/${encodeURIComponent(awbNumber(awb))}?${q}`,
      undefined,
      PrintResponse,
    );
  }

  /** POST /merged/print — up to 50 AWBs in one PDF; unprintable ones come back in errorPrinting. */
  async mergedPrint(numbers: string[]) {
    if (numbers.length < 1 || numbers.length > AWB_LIMITS.mergedPrintMax)
      throw new Error(`merged print takes 1–${AWB_LIMITS.mergedPrintMax} AWBs`);
    return this.read(
      "merged-print",
      "POST",
      "/merged/print",
      { numbers: numbers.map(awbNumber) },
      MergedPrintResponse,
    );
  }

  /** POST /fulfilment/waybills-history — status history BY AWB NUMBER (≤ 100), one entry per AWB, in order. */
  async waybillsHistory(awbs: string[], testMode = false): Promise<WaybillHistoryItem[]> {
    if (awbs.length < 1 || awbs.length > AWB_LIMITS.waybillsHistoryMax)
      throw new Error(`waybills-history takes 1–${AWB_LIMITS.waybillsHistoryMax} AWBs`);
    return this.read(
      "waybills-history",
      "POST",
      "/fulfilment/waybills-history",
      { testMode, awbs: awbs.map((a) => ({ awb: awbNumber(a) })) },
      WaybillsHistoryResponse,
    );
  }
}

/** The entry of one AWB in a waybills-history answer (matched by number; the order is the request's). */
export function waybillFor(items: WaybillHistoryItem[], awb: string) {
  return items.find((i) => String(i.awb ?? "") === String(awb));
}
