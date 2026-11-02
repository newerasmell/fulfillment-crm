import type { z } from "zod";
import { logger } from "@/lib/logger";
import { scrubText } from "@/lib/scrub";
import { EUSHIPMENTS_BASE_URL, EUSHIPMENTS_TIMEOUT_MS, ORDERS_HISTORY_BATCH } from "./config";
import { EuShipmentsError } from "./errors";
import {
  AttachPdfBody,
  AttachPdfResponse,
  CreateOrderBody,
  CreateOrderResponse,
  CreateProductBody,
  CreateProductResponse,
  CreateRequestBody,
  CreateRequestResponse,
  CreateTransferBody,
  CreateTransferResponse,
  DeleteOrderResponse,
  ErrorBody,
  GetProductsResponse,
  OrdersHistoryResponse,
  BookingStatusResponse,
  CitiesResponse,
  CodInfo,
  CountriesResponse,
  CouriersResponse,
  OfficesPageResponse,
  ProdAvailsResponse,
  RequestStatusResponse,
  UserCompaniesResponse,
  WarehousesResponse,
  type HistoryItem,
} from "./schemas";

/** Path ids must be positive integers (never a free-form string in a URL). */
function positive(n: number) {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`expected a positive integer id, got ${n}`);
  return n;
}

/**
 * euShipments HTTP client (static `Authorization: Bearer <token>`).
 *
 * Writes are never retried here — retries belong to the outbox, which reads back first. A write returns
 * `{ ok: true }` / `{ ok: false }` only when the vendor's answer is DEFINITE (2xx parsed, or a 4xx); anything
 * else (timeout, network error, 5xx, unreadable 2xx) throws `EuShipmentsError("unknown_outcome")`, because the
 * vendor may have acted. Every write takes `testMode` as an explicit argument and always sends it.
 *
 * Reads retry a few times on network errors / 429 / 5xx and throw on anything they cannot parse.
 * The token is never logged; error texts go through `scrubText` (they can echo customer data).
 */

interface ReadOptions {
  /** HTTP statuses the spec documents as "no data": parsed as `empty` instead of throwing. */
  emptyOn?: number[];
  empty?: unknown;
  /** Returned for a 2xx with an empty body (COD "nothing found" is HTTP 200 with a null body). */
  emptyBody?: null;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type WriteResult<T> =
  { ok: true; status: number; data: T } | { ok: false; status: number; error: string; body: unknown };

export interface EuShipmentsClientOptions {
  fetchImpl?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  readRetries?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A human-readable reason from a vendor error body (`{error, message, messages, itemErrors}` or text). */
export function errorText(body: unknown, status: number): string {
  if (typeof body === "string") return scrubText(body || `HTTP ${status}`);
  const parsed = ErrorBody.safeParse(body);
  if (parsed.success) {
    const b = parsed.data;
    const parts = [
      typeof b.error === "string" ? b.error : null,
      Array.isArray(b.message) ? b.message.join("; ") : b.message,
      b.messages?.join("; "),
    ].filter((p): p is string => !!p);
    const itemErrors = (body as { itemErrors?: unknown }).itemErrors;
    if (Array.isArray(itemErrors) && itemErrors.length)
      parts.push(`itemErrors: ${JSON.stringify(itemErrors).slice(0, 300)}`);
    if (parts.length) return scrubText(parts.join(" — "));
  }
  if (Array.isArray(body)) {
    const first = body.map((i) => ErrorBody.safeParse(i)).find((p) => p.success && p.data.error);
    if (first?.success && typeof first.data.error === "string") return scrubText(first.data.error);
  }
  return `HTTP ${status}`;
}

export class EuShipmentsClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly readRetries: number;

  constructor(
    private readonly token: string,
    opts: EuShipmentsClientOptions = {},
  ) {
    if (!token) throw new EuShipmentsError("auth_failed", "missing API token");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? EUSHIPMENTS_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? EUSHIPMENTS_TIMEOUT_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.readRetries = opts.readRetries ?? 3;
  }

  private async http(method: string, path: string, body?: unknown) {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      // JSON.stringify keeps null as JSON null: the vendor rejects the string "null" (INTEGRATION_NOTES §1.6).
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { status: res.status, json, text };
  }

  /** One write call: definite answers are returned, everything else throws `unknown_outcome`. */
  private async write<S extends z.ZodTypeAny>(
    op: string,
    method: string,
    path: string,
    body: unknown,
    schema: S,
    opts: { acceptStatuses?: number[] } = {},
  ): Promise<WriteResult<z.infer<S>>> {
    let r;
    try {
      r = await this.http(method, path, body);
    } catch (err) {
      throw new EuShipmentsError("unknown_outcome", `${op}: ${scrubText((err as Error).message)}`);
    }
    if (r.status >= 500 || r.status === 429)
      throw new EuShipmentsError("unknown_outcome", `${op}: HTTP ${r.status}`, r.status);
    const accepted = (r.status >= 200 && r.status < 300) || opts.acceptStatuses?.includes(r.status);
    if (accepted) {
      const parsed = schema.safeParse(r.json);
      if (!parsed.success) {
        logger.error(
          { op, status: r.status, issues: parsed.error.issues.slice(0, 5) },
          "eushipments response failed schema",
        );
        throw new EuShipmentsError(
          "unknown_outcome",
          `${op}: unreadable answer (HTTP ${r.status})`,
          r.status,
        );
      }
      return { ok: true, status: r.status, data: parsed.data };
    }
    if (r.status === 401) return { ok: false, status: 401, error: "unauthenticated", body: null };
    return {
      ok: false,
      status: r.status,
      error: errorText(r.json ?? r.text, r.status),
      body: r.json ?? null,
    };
  }

  private async read<S extends z.ZodTypeAny>(
    op: string,
    method: string,
    path: string,
    body: unknown,
    schema: S,
    opts: ReadOptions = {},
  ): Promise<z.infer<S>> {
    let attempt = 0;
    for (;;) {
      let r;
      try {
        r = await this.http(method, path, body);
      } catch (err) {
        if (attempt++ >= this.readRetries)
          throw new EuShipmentsError("http_error", `${op}: ${scrubText((err as Error).message)}`);
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      if (r.status === 429 || r.status >= 500) {
        if (attempt++ >= this.readRetries)
          throw new EuShipmentsError("http_error", `${op}: HTTP ${r.status}`, r.status);
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      if (r.status === 401) throw new EuShipmentsError("auth_failed", `${op}: unauthenticated`, 401);
      // Documented "nothing there" answers (e.g. 404 "You do not have access to countries!") are an empty result.
      if (opts.emptyOn?.includes(r.status)) return schema.parse(opts.empty);
      if (
        r.status >= 200 &&
        r.status < 300 &&
        r.json === undefined &&
        opts.emptyBody !== undefined &&
        !r.text.trim()
      )
        return opts.emptyBody as z.infer<S>;
      if (r.status < 200 || r.status >= 300)
        throw new EuShipmentsError("http_error", `${op}: ${errorText(r.json ?? r.text, r.status)}`, r.status);
      const parsed = schema.safeParse(r.json);
      if (!parsed.success) {
        logger.error({ op, issues: parsed.error.issues.slice(0, 5) }, "eushipments response failed schema");
        throw new EuShipmentsError("invalid_response", `${op}: response does not match the expected shape`);
      }
      return parsed.data;
    }
  }

  // ───────────── writes (explicit testMode, never retried here) ─────────────

  async createOrder(body: CreateOrderBody, testMode: boolean) {
    return this.write(
      "create-order",
      "POST",
      "/fulfilment/create-order",
      { testMode, ...CreateOrderBody.parse(body) },
      CreateOrderResponse,
    );
  }

  async createProduct(body: CreateProductBody, testMode: boolean) {
    return this.write(
      "create-product",
      "POST",
      "/fulfilment/create-product",
      { testMode, ...CreateProductBody.parse(body) },
      CreateProductResponse,
    );
  }

  /** One PDF per request (spec); only before the AWB exists. Per-file errors come inside the array. */
  async attachPdf(body: AttachPdfBody, testMode: boolean) {
    return this.write(
      "attach-pdf-files",
      "POST",
      "/fulfilment/attach-pdf-files",
      { testMode, ...AttachPdfBody.parse(body) },
      AttachPdfResponse,
    );
  }

  /** Booking request. No idempotency at the vendor: callers must never retry an unknown outcome. */
  async createRequest(body: CreateRequestBody, testMode: boolean) {
    return this.write(
      "create-request",
      "POST",
      "/fulfilment/create-request",
      { testMode, ...CreateRequestBody.parse(body) },
      CreateRequestResponse,
    );
  }

  /** 409 DUPLICATE_EXTERNAL_REF returns the existing protocol — it is a definite, successful answer. */
  async createTransfer(body: CreateTransferBody, testMode: boolean) {
    return this.write(
      "create-transfer",
      "POST",
      "/fulfilment/create-transfer",
      { testMode, ...CreateTransferBody.parse(body) },
      CreateTransferResponse,
      { acceptStatuses: [409] },
    );
  }

  /** DELETE /orders-delete/{refNumber} — the spec defines no testMode for deletion. */
  async deleteOrderByRef(referenceNumber: string) {
    if (!referenceNumber) throw new Error("referenceNumber is required");
    return this.write(
      "orders-delete",
      "DELETE",
      `/orders-delete/${encodeURIComponent(referenceNumber)}`,
      undefined,
      DeleteOrderResponse,
    );
  }

  // ───────────── reads ─────────────

  /** One call for 1–100 references. Inspect every item: "not found" and other errors come inside HTTP 200. */
  async ordersHistory(refNums: string[], testMode = false): Promise<HistoryItem[]> {
    if (refNums.length < 1 || refNums.length > ORDERS_HISTORY_BATCH)
      throw new Error(`orders-history takes 1–${ORDERS_HISTORY_BATCH} references`);
    return this.read(
      "orders-history",
      "POST",
      "/fulfilment/orders-history",
      { testMode, orders: refNums.map((refNum) => ({ refNum })) },
      OrdersHistoryResponse,
    );
  }

  /** Companies (client accounts) the token can see — `ID` is the companyId / senderId. */
  async getUserCompanies() {
    return this.read("get-user-companies", "GET", "/get-user-companies", undefined, UserCompaniesResponse);
  }

  /** Couriers activated for the company; an empty array means none are activated yet. */
  async getCouriers(companyId: number) {
    return this.read("couriers", "GET", `/couriers/${positive(companyId)}`, undefined, CouriersResponse);
  }

  /** Warehouses assigned to the company (POST, but a read). */
  async getWarehouses(companyId: number) {
    const res = await this.read(
      "fulfilment/warehouses",
      "POST",
      "/fulfilment/warehouses",
      { companyId: positive(companyId) },
      WarehousesResponse,
    );
    return res.data;
  }

  /** Countries covered by the token's couriers. 404 = no couriers activated (documented) → empty. */
  async getCountries() {
    return this.read("get-countries", "GET", "/get-countries", undefined, CountriesResponse, {
      emptyOn: [404],
      empty: [],
    });
  }

  /** One page of cities (`paging=1`, `first` records after `skip`). Not available for Great Britain (23). */
  async getCities(countryId: number, first: number, skip: number) {
    const q = new URLSearchParams({ paging: "1", first: String(first), skip: String(skip) });
    return this.read(
      "get-cities",
      "GET",
      `/get-cities/${positive(countryId)}?${q}`,
      undefined,
      CitiesResponse,
    );
  }

  /** One page of a courier's offices (paginated mode). 404 = the courier has no offices → empty page. */
  async getOfficesPage(courierId: number, page: number, perPage: number) {
    const q = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    return this.read(
      "offices-by-courier",
      "GET",
      `/offices-by-courier/${positive(courierId)}?${q}`,
      undefined,
      OfficesPageResponse,
      { emptyOn: [404], empty: { offices: [], pagination: { current_page: page, last_page: page } } },
    );
  }

  /** Stock per product per warehouse for every company of the token (no parameters). */
  async getProdAvails() {
    return this.read("get-prod-avails", "GET", "/fulfilment/get-prod-avails", undefined, ProdAvailsResponse);
  }

  async getRequestStatus(requestId: number) {
    return this.read(
      "get-request-status",
      "GET",
      `/fulfilment/get-request-status/${positive(requestId)}`,
      undefined,
      RequestStatusResponse,
    );
  }

  /** Lifecycle + booked vs accepted per product. 404 = booking request not found. */
  async bookingRequestStatus(companyId: number, bookingId: number) {
    return this.read(
      "booking-request-status",
      "POST",
      "/fulfilment/booking-request-status",
      { companyId: positive(companyId), bookingId: positive(bookingId) },
      BookingStatusResponse,
    );
  }

  /**
   * COD by our referenceNumber. "Nothing found" is HTTP 200 with an empty (null) body → null.
   * testMode is required by the spec and always sent explicitly.
   */
  async checkCodByOrder(referenceNumber: string, testMode = false): Promise<CodInfo | null> {
    if (!referenceNumber) throw new Error("referenceNumber is required");
    const res = await this.read(
      "check-cod-by-order",
      "GET",
      `/check-cod-by-order/${encodeURIComponent(referenceNumber)}?testMode=${testMode ? 1 : 0}`,
      undefined,
      CodInfo.nullable(),
      { emptyBody: null },
    );
    if (!res) return null;
    const empty = res.awbNumber == null && res.COD == null && res.referenceNumber == null;
    return empty ? null : res;
  }

  async getProducts(companyId: number) {
    return this.read(
      "get-products",
      "GET",
      `/fulfilment/get-products?companyId=${encodeURIComponent(String(companyId))}`,
      undefined,
      GetProductsResponse,
    );
  }
}

export type HistoryLookup =
  { kind: "found"; item: HistoryItem } | { kind: "not_found" } | { kind: "error"; error: string };

/**
 * Per-item outcome of orders-history. ONLY the documented "not found" item (errorCode 404 + "Not found order…")
 * means the order does not exist — that is the single answer that makes a resend safe (INTEGRATION_NOTES §4.3).
 */
export function classifyHistoryItem(item: HistoryItem | undefined): HistoryLookup {
  if (!item) return { kind: "error", error: "reference missing from the answer" };
  if (item.error) {
    const notFound = Number(item.errorCode) === 404 && /not found order/i.test(String(item.error));
    return notFound ? { kind: "not_found" } : { kind: "error", error: scrubText(String(item.error)) };
  }
  return { kind: "found", item };
}

/** Finds the answer for one reference in an orders-history response (refNum may come back as a number). */
export function historyItemFor(items: HistoryItem[], refNum: string) {
  return items.find((i) => i.refNum != null && String(i.refNum) === refNum);
}
