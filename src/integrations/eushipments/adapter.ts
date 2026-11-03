import { z } from "zod";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import type { OutboundCall, OutboundTransport, ReadBackResult, SendResult } from "@/server/outbox/transport";
import { classifyHistoryItem, historyItemFor, type EuShipmentsClient } from "./client";
import { EuShipmentsError } from "./errors";
import { CreateOrderBody, type HistoryItem } from "./schemas";
import { normaliseStatusText } from "./status-map";
import { sofiaToday } from "./validators";

/**
 * euShipments write side behind the outbox (P3-05). The outbox decides WHETHER to send (liveMode gate);
 * this transport decides HOW, and what an answer means:
 *  - `send` throws only when the outcome is unknown (timeout / 5xx / unreadable) — the outbox then reads back;
 *  - every real create-order first asks orders-history for our referenceNumber (the vendor does not enforce its
 *    uniqueness): found → recovered without sending; deleted there → rejected; unreadable → unknown outcome;
 *  - create-order moves a waybillAvailableDate that is already in the past up to today (Sofia) at send time;
 *  - `readBack` answers "does it exist at the vendor?" per operation:
 *      create-order  → orders-history by our referenceNumber (only the documented 404 item = not created);
 *      create-product → get-products by refNumber (refNumber is unique per company at the vendor);
 *      delete-order  → orders-history: Deleted/Cancelled (or gone) = done;
 *      create-transfer → resend with the same externalRef (409 returns the existing protocol, never a second);
 *      attach-pdf, booking request → NO read-back: thrown, so the outbox marks UNCERTAIN + operator task and
 *      never retries (a booking request has no idempotency at the vendor).
 *  - validate-only DRY_RUN sends (`testMode: true`) exist for create-order and create-transfer only
 *    (INTEGRATION_NOTES §6); every other operation is only recorded in DRY_RUN.
 * Domain effects (store orderId, queue the invoice PDF, operator tasks) run through `EuEffects`, never for
 * test-mode calls, and an effect failure never changes the vendor outcome reported to the outbox.
 */

export const EU_OPS = {
  createProduct: "eushipments.createProduct",
  createOrder: "eushipments.createOrder",
  deleteOrder: "eushipments.deleteOrder",
  attachPdf: "eushipments.attachPdf",
  createRequest: "eushipments.createRequest",
  createTransfer: "eushipments.createTransfer",
} as const;
export type EuOp = (typeof EU_OPS)[keyof typeof EU_OPS];

const TEST_MODE_OPS = new Set<string>([EU_OPS.createOrder, EU_OPS.createTransfer]);

/** What is stored in OutboundRequest.payload: the exact vendor body (minus testMode) + our ids. */
export const Envelope = z.object({
  body: z.record(z.string(), z.unknown()),
  ctx: z.record(z.string(), z.unknown()).default({}),
});
export type Envelope = z.infer<typeof Envelope>;

export const isBarcodeCollision = (error: string) => /barcode is not unique/i.test(error);
const isRefNumberExists = (error: string) => /reference number.*already exists/i.test(error);

export interface EuEffects {
  orderCreated(ctx: Envelope["ctx"], r: { orderId: string | null; recovered: boolean }): Promise<void>;
  orderRejected(ctx: Envelope["ctx"], error: string): Promise<void>;
  orderDeleted(ctx: Envelope["ctx"]): Promise<void>;
  /** euShipments definitely refused a delete-order (e.g. no longer deletable): the shipment stays. */
  orderDeleteRejected(ctx: Envelope["ctx"], error: string): Promise<void>;
  productCreated(
    ctx: Envelope["ctx"],
    r: { vendorProductId: string | null; refNumber: string; alreadyExisted: boolean },
  ): Promise<void>;
  productRejected(ctx: Envelope["ctx"], error: string, barcodeCollision: boolean): Promise<void>;
  requestCreated(ctx: Envelope["ctx"], r: { requestId: string }): Promise<void>;
  requestUncertain(ctx: Envelope["ctx"]): Promise<void>;
  requestRejected(ctx: Envelope["ctx"], error: string): Promise<void>;
  transferCreated(ctx: Envelope["ctx"], r: { protocolId: string | null; duplicate: boolean }): Promise<void>;
  transferRejected(ctx: Envelope["ctx"], error: string): Promise<void>;
  pdfAttached(ctx: Envelope["ctx"], r: { pdfId: string | null }): Promise<void>;
}

export interface EffectFailure {
  effect: keyof EuEffects;
  operation: string;
  idempotencyKey: string;
  ctx: Envelope["ctx"];
  error: string;
}

export interface EuTransportDeps {
  /** Lazily built client for the connection (token from the vault) + its euShipments companyId. */
  connect(): Promise<{ client: EuShipmentsClient; companyId: number }>;
  effects?: Partial<EuEffects>;
  /** Called when a domain effect throws after a definite vendor answer (raises an operator task). */
  onEffectFailed?(failure: EffectFailure): Promise<void>;
  /** Clock for the waybillAvailableDate check (tests). */
  now?(): Date;
}

const str = (v: unknown) => (v === null || v === undefined || v === false ? null : String(v));

export class EuShipmentsTransport implements OutboundTransport {
  constructor(private readonly deps: EuTransportDeps) {}

  supportsTestMode(operation: string) {
    return TEST_MODE_OPS.has(operation);
  }

  /** Runs a domain effect; a failure is logged and never turns a vendor answer into a different outcome. */
  private async effect<K extends keyof EuEffects>(
    call: OutboundCall,
    name: K,
    ...args: Parameters<EuEffects[K]>
  ) {
    const fn = this.deps.effects?.[name] as ((...a: unknown[]) => Promise<void>) | undefined;
    if (!fn) return;
    try {
      await fn(...args);
    } catch (err) {
      const error = scrubText(String((err as Error)?.message ?? err));
      logger.error({ effect: name, err: error }, "eushipments effect failed");
      // The vendor answer stands; our records did not follow it. Never silent: an operator task.
      try {
        await this.deps.onEffectFailed?.({
          effect: name,
          operation: call.operation,
          idempotencyKey: call.idempotencyKey,
          ctx: (args[0] ?? {}) as Envelope["ctx"],
          error,
        });
      } catch (alertErr) {
        logger.error(
          { effect: name, err: scrubText(String((alertErr as Error)?.message ?? alertErr)) },
          "eushipments effect-failure alert failed",
        );
      }
    }
  }

  /**
   * waybillAvailableDate "cannot be in the past" (reference): a request may wait (CANARY confirmation, daily
   * cap, kill switch) past the day it was queued, so the stored date is moved up to today at send time.
   * It only ever moves forward, so it stays inside the today … +9 window checked when it was queued.
   */
  private withCurrentWaybillDate(body: Envelope["body"]): Envelope["body"] {
    const today = sofiaToday(this.deps.now?.() ?? new Date());
    const stored = typeof body.waybillAvailableDate === "string" ? body.waybillAvailableDate : null;
    if (stored && stored >= today) return body;
    return { ...body, waybillAvailableDate: today };
  }

  async send(call: OutboundCall): Promise<SendResult> {
    const env = Envelope.safeParse(call.payload);
    if (!env.success) return { outcome: "rejected", response: null, error: "invalid outbox payload" };
    const { body, ctx } = env.data;
    let client: EuShipmentsClient;
    try {
      ({ client } = await this.deps.connect());
    } catch (err) {
      // Nothing left our side (missing token / companyId): a definite failure, re-queued by an operator.
      return {
        outcome: "rejected",
        response: null,
        error: scrubText(`connection not usable: ${(err as Error).message}`),
      };
    }
    const live = !call.testMode;
    try {
      switch (call.operation) {
        case EU_OPS.createOrder: {
          const orderBody = this.withCurrentWaybillDate(body);
          // Nothing leaves for an invalid stored body (not even the orders-history check).
          const valid = CreateOrderBody.safeParse(orderBody);
          if (!valid.success)
            return {
              outcome: "rejected",
              response: null,
              error: scrubText(`invalid payload: ${valid.error.issues[0]?.message ?? "create-order body"}`),
            };
          if (live) {
            // referenceNumber is not unique at euShipments: ask orders-history before EVERY real (re)submit
            // (INTEGRATION_NOTES §4.3). Only the documented 404 item means "safe to send".
            const ref = String((body as { awb?: { referenceNumber?: unknown } }).awb?.referenceNumber ?? "");
            let pre;
            try {
              pre = classifyHistoryItem(historyItemFor(await client.ordersHistory([ref]), ref));
            } catch (err) {
              throw new EuShipmentsError(
                "unknown_outcome",
                scrubText(`orders-history before create-order failed: ${(err as Error).message}`),
              );
            }
            if (pre.kind === "error")
              throw new EuShipmentsError(
                "unknown_outcome",
                `orders-history before create-order: ${pre.error}`,
              );
            if (pre.kind === "found") {
              if (isDeleted(pre.item)) {
                const error = `reference ${ref} is already used by a deleted/cancelled shipment at euShipments`;
                await this.effect(call, "orderRejected", ctx, error);
                return { outcome: "rejected", response: { precheck: "orders-history" }, error };
              }
              await this.effect(call, "orderCreated", ctx, { orderId: null, recovered: true });
              return {
                outcome: "accepted",
                response: { recoveredBy: "orders-history before send", awb: pre.item.awb ?? null },
              };
            }
          }
          const res = await client.createOrder(orderBody as never, call.testMode);
          if (!res.ok) {
            if (live) await this.effect(call, "orderRejected", ctx, res.error);
            return { outcome: "rejected", response: res.body, error: res.error };
          }
          const orderId = str(res.data.orderId);
          if (orderId) {
            if (live) await this.effect(call, "orderCreated", ctx, { orderId, recovered: false });
            return { outcome: "accepted", response: res.data };
          }
          if (call.testMode) {
            // Validate-only: a 2xx without an error text is a pass; an error text is the validation result.
            if (res.data.error)
              return { outcome: "rejected", response: res.data, error: scrubText(String(res.data.error)) };
            return { outcome: "accepted", response: res.data };
          }
          // 2xx without an orderId: we cannot tell whether it was created — let the read-back decide.
          throw new EuShipmentsError("unknown_outcome", "create-order: 2xx without orderId");
        }
        case EU_OPS.createProduct: {
          const res = await client.createProduct(body as never, call.testMode);
          const refNumber = String((body as { product?: { refNumber?: unknown } }).product?.refNumber ?? "");
          if (res.ok && str(res.data.productId)) {
            if (live)
              await this.effect(call, "productCreated", ctx, {
                vendorProductId: str(res.data.productId),
                refNumber,
                alreadyExisted: false,
              });
            return { outcome: "accepted", response: res.data };
          }
          const error = res.ok ? scrubText(String(res.data.error || "no productId")) : res.error;
          if (!res.ok && isRefNumberExists(error)) {
            // refNumber is unique per company: the product is already there (an earlier send or the cabinet).
            if (live)
              await this.effect(call, "productCreated", ctx, {
                vendorProductId: null,
                refNumber,
                alreadyExisted: true,
              });
            return { outcome: "accepted", response: { alreadyExisted: true, vendor: res.body } };
          }
          if (res.ok) throw new EuShipmentsError("unknown_outcome", `create-product: ${error}`);
          if (live) await this.effect(call, "productRejected", ctx, error, isBarcodeCollision(error));
          return { outcome: "rejected", response: res.body, error };
        }
        case EU_OPS.attachPdf: {
          const res = await client.attachPdf(body as never, call.testMode);
          if (!res.ok) return { outcome: "rejected", response: res.body, error: res.error };
          const failed = res.data.find((i) => i.error);
          if (failed || res.data.length === 0) {
            const error = failed ? scrubText(String(failed.error)) : "empty answer";
            return { outcome: "rejected", response: res.data, error };
          }
          if (live) await this.effect(call, "pdfAttached", ctx, { pdfId: str(res.data[0]?.pdfId) });
          return { outcome: "accepted", response: res.data };
        }
        case EU_OPS.deleteOrder: {
          const ref = String(ctx.referenceNumber ?? "");
          const res = await client.deleteOrderByRef(ref);
          if (!res.ok) {
            if (live) await this.effect(call, "orderDeleteRejected", ctx, res.error);
            return { outcome: "rejected", response: res.body, error: res.error };
          }
          if (res.data.error) {
            const error = scrubText(String(res.data.error));
            if (live) await this.effect(call, "orderDeleteRejected", ctx, error);
            return { outcome: "rejected", response: res.data, error };
          }
          if (live) await this.effect(call, "orderDeleted", ctx);
          return { outcome: "accepted", response: res.data };
        }
        case EU_OPS.createRequest: {
          const res = await client.createRequest(body as never, call.testMode);
          if (!res.ok) {
            if (live) await this.effect(call, "requestRejected", ctx, res.error);
            return { outcome: "rejected", response: res.body, error: res.error };
          }
          const requestId = str(res.data.requestId);
          if (!requestId)
            throw new EuShipmentsError("unknown_outcome", "create-request: 2xx without requestId");
          if (live) await this.effect(call, "requestCreated", ctx, { requestId });
          return { outcome: "accepted", response: res.data };
        }
        case EU_OPS.createTransfer: {
          const res = await client.createTransfer(body as never, call.testMode);
          if (!res.ok) {
            if (live) await this.effect(call, "transferRejected", ctx, res.error);
            return { outcome: "rejected", response: res.body, error: res.error };
          }
          const duplicate = res.status === 409;
          if (!duplicate && res.data.error) {
            const error = scrubText(String(res.data.error));
            if (live) await this.effect(call, "transferRejected", ctx, error);
            return { outcome: "rejected", response: res.data, error };
          }
          if (live)
            await this.effect(call, "transferCreated", ctx, {
              protocolId: str(res.data.protocolId),
              duplicate,
            });
          return { outcome: "accepted", response: res.data };
        }
        default:
          return { outcome: "rejected", response: null, error: `unsupported operation ${call.operation}` };
      }
    } catch (err) {
      if (err instanceof EuShipmentsError) throw err; // unknown outcome → the outbox reads back
      // Anything else happened before the request left (e.g. the body failed its schema): nothing was sent.
      return {
        outcome: "rejected",
        response: null,
        error: scrubText(`invalid payload: ${(err as Error).message}`),
      };
    }
  }

  async readBack(call: OutboundCall): Promise<ReadBackResult> {
    const env = Envelope.parse(call.payload);
    const { body, ctx } = env;
    const { client, companyId } = await this.deps.connect();
    switch (call.operation) {
      case EU_OPS.createOrder: {
        const ref = String((body as { awb?: { referenceNumber?: unknown } }).awb?.referenceNumber ?? "");
        const lookup = classifyHistoryItem(historyItemFor(await client.ordersHistory([ref]), ref));
        if (lookup.kind === "not_found") return { found: false };
        if (lookup.kind === "error") throw new Error(`orders-history: ${lookup.error}`);
        // orders-history carries no orderId; the shipment is tracked by our reference from here on.
        await this.effect(call, "orderCreated", ctx, { orderId: null, recovered: true });
        return { found: true, response: { recoveredBy: "orders-history", awb: lookup.item.awb ?? null } };
      }
      case EU_OPS.createProduct: {
        const refNumber = String((body as { product?: { refNumber?: unknown } }).product?.refNumber ?? "");
        const row = (await client.getProducts(companyId)).find((p) => p.REFERENCE_NUMBER === refNumber);
        if (!row) return { found: false };
        await this.effect(call, "productCreated", ctx, {
          vendorProductId: String(row.ID),
          refNumber,
          alreadyExisted: true,
        });
        return { found: true, response: { recoveredBy: "get-products", ID: row.ID } };
      }
      case EU_OPS.deleteOrder: {
        const ref = String(ctx.referenceNumber ?? "");
        const lookup = classifyHistoryItem(historyItemFor(await client.ordersHistory([ref]), ref));
        if (lookup.kind === "error") throw new Error(`orders-history: ${lookup.error}`);
        if (lookup.kind === "found" && !isDeleted(lookup.item)) return { found: false };
        await this.effect(call, "orderDeleted", ctx);
        return { found: true, response: { recoveredBy: "orders-history" } };
      }
      case EU_OPS.createTransfer: {
        // Same externalRef: 409 returns the existing protocol, 201 means it did not exist and now does.
        const res = await client.createTransfer(body as never, false);
        if (!res.ok) return { found: false };
        await this.effect(call, "transferCreated", ctx, {
          protocolId: str(res.data.protocolId),
          duplicate: res.status === 409,
        });
        return { found: true, response: res.data };
      }
      case EU_OPS.createRequest:
        await this.effect(call, "requestUncertain", ctx);
        throw new Error(
          "booking requests cannot be read back — check the euShipments cabinet before resubmitting",
        );
      case EU_OPS.attachPdf:
        throw new Error("attached PDFs cannot be read back — check the order in the euShipments cabinet");
      default:
        throw new Error(`no read-back for ${call.operation}`);
    }
  }
}

const DELETED = new Set(["deleted", "cancelled", "canceled/deleted"]);
function isDeleted(item: HistoryItem) {
  const last = (item.statusesHistory ?? []).at(-1);
  return !!last && DELETED.has(normaliseStatusText(last.STATUS));
}
