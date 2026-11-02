export type EuShipmentsErrorCode =
  /** Timeout, network error, 5xx or an unreadable answer to a write: the vendor may or may not have acted. */
  | "unknown_outcome"
  | "auth_failed"
  /** A definite 4xx answer to a read (nothing to retry). */
  | "http_error"
  | "invalid_response";

export class EuShipmentsError extends Error {
  constructor(
    public readonly code: EuShipmentsErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "EuShipmentsError";
  }
}
