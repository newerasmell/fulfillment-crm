import { z } from "zod";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import type { OutboundCall, OutboundTransport, ReadBackResult, SendResult } from "@/server/outbox/transport";
import type { EuAwbClient } from "./awb-client";
import { waybillFor } from "./awb-client";
import { CreateAwbBody, PreAwbBody } from "./awb-schemas";
import { EuShipmentsError } from "./errors";
import { normaliseStatusText } from "./status-map";
import { sofiaToday } from "./validators";

/**
 * euShipments courier AWBs behind the outbox (INTEGRATION_NOTES §4.7, §6). The outbox decides WHETHER (liveMode
 * gate); this decides HOW and what an answer means:
 *  - createAWB / preAWB have a validate-only mode (`testMode: true`, "applies only to the production
 *    environment"), so DRY_RUN sends them with testMode and nothing is created; delete has no test flag and is
 *    only recorded in DRY_RUN;
 *  - createAWB / preAWB have NO read-back: a reference lookup exists only for fulfilment orders, and
 *    waybills-history is strictly by AWB number, which we do not have after a timeout. So an unknown outcome is
 *    never retried: `readBack` throws, the outbox marks the request UNCERTAIN and opens an operator task
 *    (CLAUDE.md). The referenceNumber is not unique at euShipments either — our DB constraint is the guarantee;
 *  - delete reads back via waybills-history (gone / Deleted = done).
 * Domain effects (store the AWB, queue the label print, statuses) never run for test-mode calls, and an effect
 * failure never changes the vendor outcome reported to the outbox.
 */

export const AWB_OPS = {
  create: "eushipments.awb.create",
  preAwb: "eushipments.awb.preAwb",
  delete: "eushipments.awb.delete",
} as const;
export const isAwbOperation = (op: string) => op.startsWith("eushipments.awb.");
const TEST_MODE_OPS = new Set<string>([AWB_OPS.create, AWB_OPS.preAwb]);

const Ctx = z.record(z.string(), z.unknown()).default({});
export const AwbEnvelopes = {
  [AWB_OPS.create]: z.object({ body: CreateAwbBody, ctx: Ctx }),
  [AWB_OPS.preAwb]: z.object({ body: PreAwbBody, ctx: Ctx }),
  [AWB_OPS.delete]: z.object({ awb: z.string().min(1), ctx: Ctx }),
};

export type AwbResultEvent =
  | {
      kind: "created";
      ctx: Record<string, unknown>;
      awb: string;
      barcode: string | null;
      packagesBarcodes: string[];
      vendorId: string | null;
    }
  | { kind: "pre_created"; ctx: Record<string, unknown>; orderId: string }
  | { kind: "create_rejected"; ctx: Record<string, unknown>; error: string }
  | { kind: "uncertain"; ctx: Record<string, unknown> }
  | { kind: "deleted"; ctx: Record<string, unknown>; awb: string }
  | { kind: "delete_refused"; ctx: Record<string, unknown>; awb: string; error: string };

export interface AwbTransportDeps {
  connect(): Promise<{ client: EuAwbClient; companyId: number }>;
  onResult?(event: AwbResultEvent): Promise<void>;
  onEffectFailed?(event: AwbResultEvent, error: string): Promise<void>;
  /** Clock for the dispatch-date check (tests). */
  now?(): Date;
}

const str = (v: unknown) => (v === null || v === undefined || v === false || v === "" ? null : String(v));
const DELETED = new Set(["deleted", "cancelled", "canceled/deleted"]);

export class AwbTransport implements OutboundTransport {
  constructor(private readonly deps: AwbTransportDeps) {}

  supportsTestMode(operation: string) {
    return TEST_MODE_OPS.has(operation);
  }

  private async emit(event: AwbResultEvent) {
    try {
      await this.deps.onResult?.(event);
    } catch (err) {
      const error = scrubText(String((err as Error)?.message ?? err));
      logger.error({ kind: event.kind, err: error }, "awb effect failed");
      try {
        await this.deps.onEffectFailed?.(event, error);
      } catch (alertErr) {
        logger.error(
          { err: scrubText(String((alertErr as Error)?.message ?? alertErr)) },
          "awb effect alert failed",
        );
      }
    }
  }

  /**
   * waybillAvailableDate cannot be in the past: a request may wait (CANARY click, daily cap, kill switch) past the
   * day it was queued, so a past date moves up to today (Sofia) at send time — forward only, inside the window.
   */
  private currentDate<T extends { waybillAvailableDate: string }>(body: T): T {
    const today = sofiaToday(this.deps.now?.() ?? new Date());
    return body.waybillAvailableDate >= today ? body : { ...body, waybillAvailableDate: today };
  }

  async send(call: OutboundCall): Promise<SendResult> {
    let client: EuAwbClient;
    try {
      ({ client } = await this.deps.connect());
    } catch (err) {
      return {
        outcome: "rejected",
        response: null,
        error: scrubText(`connection not usable: ${(err as Error).message}`),
      };
    }
    const live = !call.testMode;
    try {
      switch (call.operation) {
        case AWB_OPS.create: {
          const env = AwbEnvelopes[AWB_OPS.create].safeParse(call.payload);
          if (!env.success) return { outcome: "rejected", response: null, error: "invalid outbox payload" };
          const { body, ctx } = env.data;
          const res = await client.createAwb(this.currentDate(body), call.testMode);
          if (!res.ok) {
            if (live) await this.emit({ kind: "create_rejected", ctx, error: res.error });
            return { outcome: "rejected", response: res.body, error: res.error };
          }
          const awb = str(res.data.awb);
          const errText =
            typeof res.data.error === "string" && res.data.error ? scrubText(res.data.error) : null;
          if (awb && live) {
            await this.emit({
              kind: "created",
              ctx,
              awb,
              barcode: str(res.data.barcode),
              packagesBarcodes: res.data.packagesBarcodes ?? [],
              vendorId: str(res.data.id),
            });
            return { outcome: "accepted", response: res.data };
          }
          if (errText) {
            if (live) await this.emit({ kind: "create_rejected", ctx, error: errText });
            return { outcome: "rejected", response: res.data, error: errText };
          }
          // Validate-only: a 2xx without an error text is a pass.
          if (call.testMode) return { outcome: "accepted", response: res.data };
          throw new EuShipmentsError("unknown_outcome", "createAWB: 2xx without awb");
        }
        case AWB_OPS.preAwb: {
          const env = AwbEnvelopes[AWB_OPS.preAwb].safeParse(call.payload);
          if (!env.success) return { outcome: "rejected", response: null, error: "invalid outbox payload" };
          const { body, ctx } = env.data;
          const res = await client.preAwb(this.currentDate(body), call.testMode);
          if (!res.ok) {
            if (live) await this.emit({ kind: "create_rejected", ctx, error: res.error });
            return { outcome: "rejected", response: res.body, error: res.error };
          }
          const orderId = str(res.data.orderId);
          const errText =
            typeof res.data.error === "string" && res.data.error ? scrubText(res.data.error) : null;
          if (orderId && live) {
            await this.emit({ kind: "pre_created", ctx, orderId });
            return { outcome: "accepted", response: res.data };
          }
          if (errText) {
            if (live) await this.emit({ kind: "create_rejected", ctx, error: errText });
            return { outcome: "rejected", response: res.data, error: errText };
          }
          if (call.testMode) return { outcome: "accepted", response: res.data };
          throw new EuShipmentsError("unknown_outcome", "preAWB: 2xx without orderId");
        }
        case AWB_OPS.delete: {
          const env = AwbEnvelopes[AWB_OPS.delete].safeParse(call.payload);
          if (!env.success) return { outcome: "rejected", response: null, error: "invalid outbox payload" };
          const { awb, ctx } = env.data;
          const res = await client.deleteAwb(awb);
          if (!res.ok || !res.data.success) {
            const error = res.ok ? scrubText(res.data.error ?? "not deleted") : res.error;
            await this.emit({ kind: "delete_refused", ctx, awb, error });
            return { outcome: "rejected", response: res.ok ? res.data : res.body, error };
          }
          await this.emit({ kind: "deleted", ctx, awb });
          return { outcome: "accepted", response: res.data };
        }
        default:
          return { outcome: "rejected", response: null, error: `unsupported operation ${call.operation}` };
      }
    } catch (err) {
      if (err instanceof EuShipmentsError) throw err; // unknown outcome → the outbox decides (read-back / UNCERTAIN)
      return {
        outcome: "rejected",
        response: null,
        error: scrubText(`invalid payload: ${(err as Error).message}`),
      };
    }
  }

  async readBack(call: OutboundCall): Promise<ReadBackResult> {
    switch (call.operation) {
      case AWB_OPS.create:
      case AWB_OPS.preAwb: {
        const env = AwbEnvelopes[call.operation].safeParse(call.payload);
        await this.emit({ kind: "uncertain", ctx: env.success ? env.data.ctx : {} });
        throw new Error(
          "courier AWBs cannot be read back by reference — check the euShipments cabinet before creating it again",
        );
      }
      case AWB_OPS.delete: {
        const { awb, ctx } = AwbEnvelopes[AWB_OPS.delete].parse(call.payload);
        const { client } = await this.deps.connect();
        const item = waybillFor(await client.waybillsHistory([awb]), awb);
        const gone = !item || String(item.errorCode ?? "") === "404";
        const last = (item?.statusesHistory ?? []).at(-1);
        if (!gone && !(last && DELETED.has(normaliseStatusText(last.STATUS)))) return { found: false };
        await this.emit({ kind: "deleted", ctx, awb });
        return { found: true, response: { recoveredBy: "waybills-history" } };
      }
      default:
        throw new Error(`no read-back for ${call.operation}`);
    }
  }
}

/**
 * One transport for an euShipments connection: AWB operations go to the AWB transport, everything else to the
 * fulfilment transport (create-order, products, bookings, transfers). Keeps both adapters independent.
 */
export function withAwbOperations(
  base: OutboundTransport | undefined,
  awb: OutboundTransport,
): OutboundTransport {
  const pick = (op: string) => (isAwbOperation(op) ? awb : base);
  return {
    supportsTestMode: (op) => pick(op)?.supportsTestMode?.(op) ?? false,
    send: (call) => {
      const t = pick(call.operation);
      if (!t)
        return Promise.resolve({
          outcome: "rejected",
          response: null,
          error: `no transport for ${call.operation}`,
        });
      return t.send(call);
    },
    readBack: (call) => {
      const t = pick(call.operation);
      if (!t?.readBack) return Promise.reject(new Error(`no read-back for ${call.operation}`));
      return t.readBack(call);
    },
  };
}
