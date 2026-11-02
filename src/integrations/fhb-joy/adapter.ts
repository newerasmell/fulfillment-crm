import { z } from "zod";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import type { OutboundCall, OutboundTransport, ReadBackResult, SendResult } from "@/server/outbox/transport";
import { JoyError, type JoyClient } from "./client";
import { trackingFromLabel } from "./mapper";
import { JoyShipmentCreate, type JoyShipmentInfo } from "./schemas";

/**
 * FHB Joy as an outbox transport (INTEGRATION_NOTES §3, §6). The outbox decides WHETHER to send (liveMode gate);
 * this decides HOW and what an answer means. Every Joy label is real and billable, so:
 *  - there is no test mode (`supportsTestMode` false): DRY_RUN only records the payload, READ_ONLY refuses;
 *    labels leave only in CANARY (operator click + daily cap) or LIVE;
 *  - every real create first asks GET /shipment?id= for our deterministic id: found → recovered, the label is
 *    fetched again by GET /shipments?id= (reprint), nothing is created twice;
 *  - a 409 on create ("Resource already exists") is never retried with another id: it is read back;
 *  - `send` throws only when the outcome is unknown (timeout, 5xx, unreadable 2xx); the outbox then calls
 *    `readBack`, which looks the id up again — so a timed-out create never becomes a second label.
 * The base64 label never goes into the outbox row (it would bloat every list): `onResult` stores it, the
 * stored response keeps tracking numbers and the label size only.
 */

export const JOY_OPS = {
  createShipment: "joy.shipment.create",
  rejectShipment: "joy.shipment.reject",
} as const;
export type JoyOp = (typeof JOY_OPS)[keyof typeof JOY_OPS];
export const isJoyOperation = (op: string): op is JoyOp => (Object.values(JOY_OPS) as string[]).includes(op);

const Ctx = z.record(z.string(), z.unknown()).default({});
export const JoyEnvelopes = {
  [JOY_OPS.createShipment]: z.object({ id: z.string().min(1), body: JoyShipmentCreate, ctx: Ctx }),
  [JOY_OPS.rejectShipment]: z.object({ id: z.string().min(1), ctx: Ctx }),
};

export type JoyResultEvent =
  | {
      kind: "created";
      id: string;
      ctx: Record<string, unknown>;
      tracking: string[];
      /** base64 PDF; null when the label could not be fetched again after a recovery (reprint refused). */
      labelBase64: string | null;
      recovered: boolean;
    }
  | {
      kind: "create_rejected";
      id: string;
      ctx: Record<string, unknown>;
      error: string;
      field: string | null;
      /** The id is taken by a DIFFERENT shipment at Joy: a CRITICAL operator task, not a plain refusal. */
      idConflict?: boolean;
    }
  | { kind: "voided"; id: string; ctx: Record<string, unknown> }
  | { kind: "void_refused"; id: string; ctx: Record<string, unknown>; error: string };

export interface JoyTransportDeps {
  client(): Promise<JoyClient>;
  onResult?(event: JoyResultEvent): Promise<void>;
  /** A domain effect failed after a definite vendor answer: an operator task, never a different outcome. */
  onEffectFailed?(event: JoyResultEvent, error: string): Promise<void>;
}

const norm = (v: string | null | undefined) =>
  (v ?? "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
const normZip = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, "").toUpperCase();

/**
 * Is the shipment found under our id the one we meant to create? The Joy id namespace belongs to the Joy
 * account, not to the CRM group: another group / company using the same Joy login, a re-created account or an
 * id used in ZOE can hold the same `M-M<n>`. Claiming it would print someone else's label. Compared on what
 * GET /shipment returns (reference): variableSymbol, zip, name and COD; a field Joy leaves out is not compared.
 */
export function sameJoyShipment(found: JoyShipmentInfo, body: JoyShipmentCreate): boolean {
  if (found.variableSymbol != null && String(found.variableSymbol).trim() !== body.variableSymbol.trim())
    return false;
  if (found.zip != null && normZip(found.zip) !== normZip(body.zip)) return false;
  if (found.name != null && norm(found.name) !== norm(body.name)) return false;
  if (found.cod != null && Math.abs(found.cod - (body.cod ?? 0)) > 0.005) return false;
  return true;
}

export const JOY_ID_CONFLICT = "joy id already used by another shipment";

const pdfBytes = (b64: string | null | undefined) => (b64 ? Math.floor((b64.length * 3) / 4) : 0);

export class JoyTransport implements OutboundTransport {
  constructor(private readonly deps: JoyTransportDeps) {}

  supportsTestMode() {
    return false;
  }

  private async emit(event: JoyResultEvent) {
    try {
      await this.deps.onResult?.(event);
    } catch (err) {
      const error = scrubText(String((err as Error)?.message ?? err));
      logger.error({ kind: event.kind, err: error }, "joy effect failed");
      try {
        await this.deps.onEffectFailed?.(event, error);
      } catch (alertErr) {
        logger.error(
          { err: scrubText(String((alertErr as Error)?.message ?? alertErr)) },
          "joy effect alert failed",
        );
      }
    }
  }

  /** Already at Joy: the label again (reprint, ≤ 5 days) and the "created" effect. */
  private async recover(client: JoyClient, id: string, ctx: Record<string, unknown>, how: string) {
    let label: Awaited<ReturnType<JoyClient["reprintShipment"]>> = null;
    try {
      label = await client.reprintShipment(id);
    } catch (err) {
      // Reprint is refused after 5 days or when printing is unavailable: the shipment still exists.
      logger.warn(
        { id, err: scrubText(String((err as Error).message)) },
        "joy reprint after recovery failed",
      );
    }
    const tracking = label ? trackingFromLabel(label) : [];
    await this.emit({
      kind: "created",
      id,
      ctx,
      tracking,
      labelBase64: label?.label ?? null,
      recovered: true,
    });
    return { recoveredBy: how, tracking, labelBytes: pdfBytes(label?.label) };
  }

  /** Our id is held by a different shipment at Joy: never claimed, never retried with another id. */
  private async idConflict(id: string, ctx: Record<string, unknown>): Promise<SendResult> {
    const error = `${JOY_ID_CONFLICT} (${id})`;
    await this.emit({ kind: "create_rejected", id, ctx, error, field: "id", idConflict: true });
    return { outcome: "rejected", response: { idConflict: true }, error };
  }

  async send(call: OutboundCall): Promise<SendResult> {
    if (call.testMode) return { outcome: "rejected", response: null, error: "joy has no test mode" };
    let client: JoyClient;
    try {
      client = await this.deps.client();
    } catch (err) {
      return {
        outcome: "rejected",
        response: null,
        error: scrubText(`connection not usable: ${(err as Error).message}`),
      };
    }
    try {
      switch (call.operation) {
        case JOY_OPS.createShipment: {
          const env = JoyEnvelopes[JOY_OPS.createShipment].safeParse(call.payload);
          if (!env.success) return { outcome: "rejected", response: null, error: "invalid outbox payload" };
          const { id, body, ctx } = env.data;
          // Never a second label: look our id up before EVERY real create.
          let existing;
          try {
            existing = await client.getShipment(id);
          } catch (err) {
            throw new JoyError(
              "network",
              scrubText(`GET /shipment before create failed: ${(err as Error).message}`),
            );
          }
          if (existing && !sameJoyShipment(existing, body)) return this.idConflict(id, ctx);
          if (existing)
            return {
              outcome: "accepted",
              response: await this.recover(client, id, ctx, "shipment before send"),
            };
          try {
            const res = await client.createShipment(body);
            const tracking = trackingFromLabel(res);
            await this.emit({
              kind: "created",
              id,
              ctx,
              tracking,
              labelBase64: res.label ?? null,
              recovered: false,
            });
            return {
              outcome: "accepted",
              response: {
                packages: res.packages ?? [],
                labelBytes: pdfBytes(res.label),
                self: res._links?.self?.href ?? null,
              },
            };
          } catch (err) {
            if (!(err instanceof JoyError) || err.outcomeUnknown) throw err;
            if (err.code === "conflict") {
              // "Resource already exists": read back, never retry with a new id.
              const found = await client.getShipment(id);
              if (found && !sameJoyShipment(found, body)) return this.idConflict(id, ctx);
              if (found)
                return {
                  outcome: "accepted",
                  response: await this.recover(client, id, ctx, "409 on create"),
                };
            }
            const error = scrubText(err.message);
            await this.emit({ kind: "create_rejected", id, ctx, error, field: err.field });
            return { outcome: "rejected", response: { status: err.status ?? null, field: err.field }, error };
          }
        }
        case JOY_OPS.rejectShipment: {
          const env = JoyEnvelopes[JOY_OPS.rejectShipment].safeParse(call.payload);
          if (!env.success) return { outcome: "rejected", response: null, error: "invalid outbox payload" };
          const { id, ctx } = env.data;
          try {
            await client.rejectShipment(id);
          } catch (err) {
            if (!(err instanceof JoyError) || err.outcomeUnknown) throw err;
            const error =
              err.code === "conflict"
                ? "the label is no longer in the printed state"
                : scrubText(err.message);
            await this.emit({ kind: "void_refused", id, ctx, error });
            return { outcome: "rejected", response: { status: err.status ?? null }, error };
          }
          await this.emit({ kind: "voided", id, ctx });
          return { outcome: "accepted", response: { rejected: true } };
        }
        default:
          return { outcome: "rejected", response: null, error: `unsupported operation ${call.operation}` };
      }
    } catch (err) {
      if (err instanceof JoyError && err.outcomeUnknown) throw err;
      if (err instanceof JoyError) {
        // A definite answer before anything was created (e.g. login refused): nothing left our side.
        return {
          outcome: "rejected",
          response: { status: err.status ?? null },
          error: scrubText(err.message),
        };
      }
      return {
        outcome: "rejected",
        response: null,
        error: scrubText(`invalid payload: ${(err as Error).message}`),
      };
    }
  }

  async readBack(call: OutboundCall): Promise<ReadBackResult> {
    const client = await this.deps.client();
    switch (call.operation) {
      case JOY_OPS.createShipment: {
        const { id, body, ctx } = JoyEnvelopes[JOY_OPS.createShipment].parse(call.payload);
        const found = await client.getShipment(id);
        if (!found) return { found: false };
        // Not ours: neither "found" (it would claim a foreign label) nor "not found" (a retry would 409 again).
        // Throwing makes the request UNCERTAIN with an operator task.
        if (!sameJoyShipment(found, body)) throw new Error(`${JOY_ID_CONFLICT} (${id})`);
        return { found: true, response: await this.recover(client, id, ctx, "read-back") };
      }
      case JOY_OPS.rejectShipment: {
        const { id, ctx } = JoyEnvelopes[JOY_OPS.rejectShipment].parse(call.payload);
        const found = await client.getShipment(id);
        if (found && found.status?.trim().toLowerCase() !== "rejected") return { found: false };
        await this.emit({ kind: "voided", id, ctx });
        return { found: true, response: { recoveredBy: "read-back", status: found?.status ?? null } };
      }
      default:
        throw new Error(`no read-back for ${call.operation}`);
    }
  }
}
