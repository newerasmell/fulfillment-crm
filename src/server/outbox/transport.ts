/**
 * What the outbox sender needs from a vendor adapter for one write. Adapters (phase 2+) implement it;
 * tests use fakes. `send` must throw (or reject) only when the outcome is UNKNOWN (timeout, 5xx, network):
 * a definite vendor rejection is returned as `{ outcome: "rejected" }`.
 */
export interface OutboundCall {
  operation: string;
  idempotencyKey: string;
  payload: unknown;
  /** true only in DRY_RUN for operations with a vendor validate-only mode. */
  testMode: boolean;
  /**
   * The vendor already answered this call with success (a reroute confirming a delete that was SENT): the read-back
   * only confirms the effect, it does not decide an unknown outcome.
   */
  vendorAnswered?: boolean;
}

/**
 * Thrown by a transport when the call certainly did NOT leave (e.g. the duplicate pre-check before a create failed):
 * the outbox retries later with backoff, no read-back, no "unknown result" task.
 */
export class NotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSentError";
  }
}

export interface SendResult {
  outcome: "accepted" | "rejected";
  response: unknown;
  error?: string;
}

export interface ReadBackResult {
  found: boolean;
  response?: unknown;
}

export interface OutboundTransport {
  send(call: OutboundCall): Promise<SendResult>;
  /** Looks the request up at the vendor by its deterministic id. Absent = no read-back possible. */
  readBack?(call: OutboundCall): Promise<ReadBackResult>;
  supportsTestMode?(operation: string): boolean;
}

export type TransportResolver = (connection: { id: string; type: string }) => OutboundTransport | undefined;
