import { createHash } from "node:crypto";
import { z } from "zod";
import { logger } from "@/lib/logger";
import type { OutboundCall, OutboundTransport, ReadBackResult, SendResult } from "@/server/outbox/transport";
import { FhbError, type FhbClient } from "./client";
import {
  FhbOrderCreate,
  FhbOrderUpdate,
  FhbProductCreate,
  FhbProductUpdate,
  FhbStockReceiptCreate,
  FhbStockReceiptUpdate,
  type FhbOrderView,
  type FhbProductView,
  type FhbStockReceiptView,
} from "./schemas";

/**
 * FHB v3 as an outbox transport (INTEGRATION_NOTES §1, §2). The outbox decides WHETHER to send (liveMode gate);
 * this decides HOW, and how to find out afterwards whether an unknown outcome took effect:
 *  - creates read back by the deterministic id (GET /order?id=, /product?id=, /stock-receipt?id=);
 *  - updates read back and compare what we sent (a PUT of the same body is idempotent, so "not applied" may be
 *    sent again);
 *  - deletes read back and count "gone" as done.
 * FHB has no test flag in production, so `supportsTestMode` is false: DRY_RUN only records the payload.
 * `send` throws only when the outcome is unknown (timeout, 5xx); a definite refusal is `rejected`.
 */

export const FHB_OPERATIONS = [
  "fhb.product.create",
  "fhb.product.update",
  "fhb.order.create",
  "fhb.order.update",
  "fhb.order.delete",
  "fhb.stockReceipt.create",
  "fhb.stockReceipt.update",
  "fhb.stockReceipt.delete",
] as const;
export type FhbOperation = (typeof FHB_OPERATIONS)[number];

/** CRM-only context stored next to the vendor body in the outbox row (never sent). */
const Meta = z.record(z.string(), z.string()).optional();

/** Outbox payload envelope: `id` is the FHB id the call addresses (query `?id=` or body id), `body` what is sent. */
const Envelopes = {
  "fhb.product.create": z.object({ id: z.string().min(1), body: FhbProductCreate, meta: Meta }),
  "fhb.product.update": z.object({ id: z.string().min(1), body: FhbProductUpdate, meta: Meta }),
  "fhb.order.create": z.object({ id: z.string().min(1), body: FhbOrderCreate, meta: Meta }),
  "fhb.order.update": z.object({ id: z.string().min(1), body: FhbOrderUpdate, meta: Meta }),
  "fhb.order.delete": z.object({ id: z.string().min(1), meta: Meta }),
  "fhb.stockReceipt.create": z.object({ id: z.string().min(1), body: FhbStockReceiptCreate, meta: Meta }),
  "fhb.stockReceipt.update": z.object({ id: z.string().min(1), body: FhbStockReceiptUpdate, meta: Meta }),
  "fhb.stockReceipt.delete": z.object({ id: z.string().min(1), meta: Meta }),
} satisfies Record<FhbOperation, z.ZodTypeAny>;

export type FhbEnvelope<O extends FhbOperation> = z.infer<(typeof Envelopes)[O]>;

export const isFhbOperation = (op: string): op is FhbOperation =>
  (FHB_OPERATIONS as readonly string[]).includes(op);

export function parseFhbEnvelope<O extends FhbOperation>(op: O, payload: unknown): FhbEnvelope<O> {
  return Envelopes[op].parse(payload) as FhbEnvelope<O>;
}

/** Short stable hash of a payload: idempotency keys of updates (same change twice = one request). */
export function payloadHash(v: unknown): string {
  const canon = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(canon)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x as object)
              .sort()
              .map((k) => [k, canon((x as Record<string, unknown>)[k])]),
          )
        : x;
  return createHash("sha256")
    .update(JSON.stringify(canon(v)))
    .digest("hex")
    .slice(0, 16);
}

/** What the server layer learns after a call (to update Fulfillment / VendorProduct / InboundShipment). */
export type FhbResultEvent =
  | {
      kind: "order";
      operation: FhbOperation;
      envelope: { id: string; meta?: Record<string, string> };
      view: FhbOrderView;
    }
  | {
      kind: "order_deleted";
      operation: FhbOperation;
      envelope: { id: string; meta?: Record<string, string> };
    }
  | {
      kind: "product";
      operation: FhbOperation;
      envelope: { id: string; meta?: Record<string, string> };
      view: FhbProductView;
    }
  | {
      kind: "receipt";
      operation: FhbOperation;
      envelope: { id: string; meta?: Record<string, string> };
      view: FhbStockReceiptView;
    }
  | {
      kind: "receipt_deleted";
      operation: FhbOperation;
      envelope: { id: string; meta?: Record<string, string> };
    }
  | {
      kind: "rejected";
      operation: FhbOperation;
      envelope: { id: string; meta?: Record<string, string> };
      error: { code: string; message: string; violations: Record<string, string[]> };
    };

export interface FhbTransportOptions {
  /** Resolved lazily so credentials are read from the vault only when something is actually sent. */
  client: () => Promise<FhbClient>;
  /** Applies results to the CRM. Its failure never turns a sent request into an unknown one. */
  onResult?: (event: FhbResultEvent) => Promise<void>;
}

const sortedItems = (items: { id: string; quantity: number }[] | null | undefined) =>
  [...(items ?? [])]
    .map((i) => `${i.id}×${i.quantity}`)
    .sort()
    .join(",");

export class FhbV3Transport implements OutboundTransport {
  constructor(private readonly opts: FhbTransportOptions) {}

  supportsTestMode() {
    return false;
  }

  private async emit(event: FhbResultEvent) {
    if (!this.opts.onResult) return;
    try {
      await this.opts.onResult(event);
    } catch (err) {
      // The vendor call is done; the next read (callback / history sweep) repairs the CRM side.
      logger.error(
        { operation: event.operation, id: event.envelope.id, err: (err as Error).message },
        "fhb apply failed",
      );
    }
  }

  async send(call: OutboundCall): Promise<SendResult> {
    if (!isFhbOperation(call.operation))
      return { outcome: "rejected", response: null, error: "unknown_operation" };
    const op = call.operation;
    let env;
    try {
      env = parseFhbEnvelope(op, call.payload);
    } catch {
      return { outcome: "rejected", response: null, error: "invalid_payload" };
    }
    let client: FhbClient;
    try {
      client = await this.opts.client();
    } catch (err) {
      // Nothing left the building (no credentials / vault error): a definite, visible refusal.
      return { outcome: "rejected", response: null, error: `no_client: ${(err as Error).message}` };
    }
    try {
      switch (op) {
        case "fhb.order.create": {
          const e = env as FhbEnvelope<"fhb.order.create">;
          const view = await client.createOrder(e.body);
          await this.emit({ kind: "order", operation: op, envelope: e, view });
          return { outcome: "accepted", response: { id: view.id, uid: view.uid, status: view.status } };
        }
        case "fhb.order.update": {
          const e = env as FhbEnvelope<"fhb.order.update">;
          const view = await client.updateOrder(e.id, e.body);
          await this.emit({ kind: "order", operation: op, envelope: e, view });
          return { outcome: "accepted", response: { id: view.id, status: view.status } };
        }
        case "fhb.order.delete":
          await client.deleteOrder(env.id);
          await this.emit({ kind: "order_deleted", operation: op, envelope: env });
          return { outcome: "accepted", response: { id: env.id, deleted: true } };
        case "fhb.product.create": {
          const e = env as FhbEnvelope<"fhb.product.create">;
          const view = await client.createProduct(e.body);
          await this.emit({ kind: "product", operation: op, envelope: e, view });
          return { outcome: "accepted", response: { id: view.id, internal_code: view.internal_code } };
        }
        case "fhb.product.update": {
          const e = env as FhbEnvelope<"fhb.product.update">;
          const view = await client.updateProduct(e.id, e.body);
          await this.emit({ kind: "product", operation: op, envelope: e, view });
          return { outcome: "accepted", response: { id: view.id, internal_code: view.internal_code } };
        }
        case "fhb.stockReceipt.create": {
          const e = env as FhbEnvelope<"fhb.stockReceipt.create">;
          const view = await client.createStockReceipt(e.body);
          await this.emit({ kind: "receipt", operation: op, envelope: e, view });
          return { outcome: "accepted", response: { id: view.id, status: view.status } };
        }
        case "fhb.stockReceipt.update": {
          const e = env as FhbEnvelope<"fhb.stockReceipt.update">;
          const view = await client.updateStockReceipt(e.id, e.body);
          await this.emit({ kind: "receipt", operation: op, envelope: e, view });
          return { outcome: "accepted", response: { id: view.id, status: view.status } };
        }
        case "fhb.stockReceipt.delete":
          await client.deleteStockReceipt(env.id);
          await this.emit({ kind: "receipt_deleted", operation: op, envelope: env });
          return { outcome: "accepted", response: { id: env.id, deleted: true } };
      }
    } catch (err) {
      if (err instanceof FhbError && !err.outcomeUnknown) {
        const error = { code: err.code, message: err.message, violations: err.violationCodes() };
        await this.emit({ kind: "rejected", operation: op, envelope: env, error });
        const fields = Object.entries(error.violations)
          .map(([f, c]) => `${f}: ${c.join("/")}`)
          .join("; ");
        return {
          outcome: "rejected",
          response: { status: err.status ?? null, message: err.message, violations: error.violations },
          error: `${err.code}${fields ? ` — ${fields}` : `: ${err.message}`}`,
        };
      }
      throw err; // unknown outcome: the outbox reads back before anything else happens
    }
  }

  async readBack(call: OutboundCall): Promise<ReadBackResult> {
    if (!isFhbOperation(call.operation)) throw new Error("unknown operation");
    const op = call.operation;
    const env = parseFhbEnvelope(op, call.payload);
    const client = await this.opts.client();
    switch (op) {
      case "fhb.order.create": {
        const view = await client.getOrder(env.id);
        if (!view) return { found: false };
        await this.emit({ kind: "order", operation: op, envelope: env, view });
        return { found: true, response: { id: view.id, uid: view.uid, status: view.status } };
      }
      case "fhb.order.update": {
        const e = env as FhbEnvelope<"fhb.order.update">;
        const view = await client.getOrder(e.id);
        if (!view) throw new Error("order not found at FHB during update read-back");
        const a = e.body.recipient.address;
        const b = view.recipient?.address;
        const applied =
          sortedItems(view.items) === sortedItems(e.body.items) &&
          b?.name === a.name &&
          b?.street === a.street &&
          b?.city === a.city &&
          b?.zip === a.zip &&
          (view.cod ?? 0) === (e.body.cod ?? 0);
        if (applied) await this.emit({ kind: "order", operation: op, envelope: e, view });
        return applied ? { found: true, response: { id: view.id, status: view.status } } : { found: false };
      }
      case "fhb.order.delete": {
        const view = await client.getOrder(env.id);
        if (view) return { found: false };
        await this.emit({ kind: "order_deleted", operation: op, envelope: env });
        return { found: true, response: { id: env.id, deleted: true } };
      }
      case "fhb.product.create": {
        const view = await client.getProduct(env.id);
        if (!view) return { found: false };
        await this.emit({ kind: "product", operation: op, envelope: env, view });
        return { found: true, response: { id: view.id, internal_code: view.internal_code } };
      }
      case "fhb.product.update": {
        const e = env as FhbEnvelope<"fhb.product.update">;
        const view = await client.getProduct(e.body.new_id ?? e.id);
        if (!view) return { found: false };
        const applied =
          view.name === e.body.name &&
          (e.body.notify_url === undefined || view.notify_url === e.body.notify_url) &&
          (e.body.items === undefined || sortedItems(view.items) === sortedItems(e.body.items));
        if (applied) await this.emit({ kind: "product", operation: op, envelope: e, view });
        return applied ? { found: true, response: { id: view.id } } : { found: false };
      }
      case "fhb.stockReceipt.create": {
        const view = await client.getStockReceipt(env.id);
        if (!view) return { found: false };
        await this.emit({ kind: "receipt", operation: op, envelope: env, view });
        return { found: true, response: { id: view.id, status: view.status } };
      }
      case "fhb.stockReceipt.update": {
        const e = env as FhbEnvelope<"fhb.stockReceipt.update">;
        const view = await client.getStockReceipt(e.id);
        if (!view) throw new Error("stock receipt not found at FHB during update read-back");
        const applied = view.name === e.body.name && sortedItems(view.items) === sortedItems(e.body.items);
        if (applied) await this.emit({ kind: "receipt", operation: op, envelope: e, view });
        return applied ? { found: true, response: { id: view.id, status: view.status } } : { found: false };
      }
      case "fhb.stockReceipt.delete": {
        const view = await client.getStockReceipt(env.id);
        if (view) return { found: false };
        await this.emit({ kind: "receipt_deleted", operation: op, envelope: env });
        return { found: true, response: { id: env.id, deleted: true } };
      }
    }
  }
}
