/**
 * Returns board (P6-01): pure part. Turns what the warehouse mirrors know into return cases — one per CRM
 * shipment when the CRM can link it, otherwise one per vendor record. No I/O here; the sweep loads the rows.
 *
 * Sources (SPEC §6.5, INTEGRATION_NOTES §2.5 / §4.5):
 *   FHB_RMA     FhbOrderMirror seen in rma/list (or with returned_at): back at the warehouse from the carrier.
 *               FHB shipments with CRM status RETURN_RECEIVED (callback / order read) count the same way.
 *   FHB_LOCAL   FhbReturnMirror (return/list): a return package scanned at a depot; linked to a shipment when
 *               one of its package barcodes is the shipment's tracking or return tracking number.
 *   EUSHIPMENTS euShipments shipments in RETURNING (Returning 17 / Returned 4) or RETURN_RECEIVED (34/42/36).
 */

export const RETURN_SOURCES = ["FHB_RMA", "FHB_LOCAL", "EUSHIPMENTS"] as const;
export type ReturnSource = (typeof RETURN_SOURCES)[number];
export type ReturnState = "RETURNING" | "RECEIVED";

export interface ReturnItem {
  title: string;
  sku?: string | null;
  quantity: number;
  condition?: string | null;
  action?: string | null;
}

export interface ConnectionIn {
  id: string;
  type: string;
  companyId: string | null;
}

export interface FulfillmentIn {
  id: string;
  connectionId: string;
  externalId: string;
  status: string;
  rawStatus: string | null;
  trackingNumbers: string[];
  returnInfo: unknown;
  order: { id: string; number: string; companyId: string | null };
  /** Lines this shipment carries (or the order's lines when the shipment has none recorded). */
  items: ReturnItem[];
  /** Earliest FulfillmentEvent into RETURNING / RETURN_RECEIVED. */
  returningEventAt: Date | null;
  receivedEventAt: Date | null;
}

export interface RmaIn {
  connectionId: string;
  externalId: string;
  rawStatus: string | null;
  returnedAt: Date | null;
  returnType: string | null;
  trackingNumbers: string[];
  raw: unknown;
}

export interface LocalReturnIn {
  connectionId: string;
  uid: string;
  type: string | null;
  status: string | null;
  barcodes: string[];
  items: unknown;
  photos: unknown;
  vendorCreatedAt: Date | null;
}

export interface CaseDraft {
  caseKey: string;
  connectionId: string;
  fulfillmentId: string | null;
  orderId: string | null;
  companyId: string | null;
  sources: ReturnSource[];
  state: ReturnState;
  rawStatus: string | null;
  returnType: string | null;
  reference: string;
  trackingNumbers: string[];
  returnTracking: string[];
  items: ReturnItem[];
  photos: { id: string; type: string | null }[];
  localReturnUid: string | null;
  returningSince: Date | null;
  receivedAt: Date | null;
}

const uniq = (xs: (string | null | undefined)[]) => [
  ...new Set(xs.filter((x): x is string => !!x && !!x.trim()).map((x) => x.trim())),
];
const minDate = (...ds: (Date | null | undefined)[]) => {
  const t = ds.filter((d): d is Date => !!d && !Number.isNaN(d.getTime())).map((d) => d.getTime());
  return t.length ? new Date(Math.min(...t)) : null;
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const parseDate = (v: unknown) => {
  if (typeof v !== "string" || !v) return null;
  // FHB sends "2026-04-20T10:15:00+0200"; Date wants "+02:00".
  const d = new Date(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Return tracking numbers a shipment carries: euShipments newReturnNumber, FHB package_returns. */
export function returnTrackingOf(returnInfo: unknown): string[] {
  const r = obj(returnInfo);
  return uniq([s(r.returnAwb), ...arr(r.packageReturns).flatMap((p) => [s(obj(p).return_tracking)])]);
}

/** Outbound tracking numbers FHB lists under package_returns (the parcel the return belongs to). */
function returnedPackagesOf(returnInfo: unknown): string[] {
  return uniq(arr(obj(returnInfo).packageReturns).map((p) => s(obj(p).tracking)));
}

/** Items of a FHB local return (only `complex` returns list them): description, barcode, condition, action. */
export function localItems(items: unknown): ReturnItem[] {
  return arr(items).flatMap((raw) => {
    const i = obj(raw);
    const title = s(i.description) ?? s(i.barcode);
    if (!title) return [];
    const q = typeof i.quantity === "number" && i.quantity > 0 ? Math.trunc(i.quantity) : 1;
    return [{ title, sku: s(i.barcode), quantity: q, condition: s(i.condition), action: s(i.action) }];
  });
}

export function localPhotos(photos: unknown): { id: string; type: string | null }[] {
  return arr(photos).flatMap((raw) => {
    const p = obj(raw);
    const id = typeof p.id === "number" || typeof p.id === "string" ? String(p.id) : null;
    return id && /^[A-Za-z0-9_-]{1,40}$/.test(id) ? [{ id, type: s(p.type) }] : [];
  });
}

/** Items of an FHB order view (product id + quantity) for returns the CRM has no order for. */
function rmaItems(raw: unknown): ReturnItem[] {
  return arr(obj(raw).items).flatMap((x) => {
    const i = obj(x);
    const id = typeof i.id === "string" || typeof i.id === "number" ? String(i.id) : null;
    if (!id) return [];
    const q = typeof i.quantity === "number" && i.quantity > 0 ? Math.trunc(i.quantity) : 1;
    return [{ title: id, sku: id, quantity: q }];
  });
}

const RETURN_STATUSES = new Set(["RETURNING", "RETURN_RECEIVED"]);

export function buildCases(input: {
  connections: ConnectionIn[];
  fulfillments: FulfillmentIn[];
  rma: RmaIn[];
  local: LocalReturnIn[];
}): CaseDraft[] {
  const conn = new Map(input.connections.map((c) => [c.id, c]));
  const fById = new Map(input.fulfillments.map((f) => [`${f.connectionId}:${f.externalId}`, f]));
  const out = new Map<string, CaseDraft>();

  const draftFor = (f: FulfillmentIn): CaseDraft => {
    const key = `fulfillment:${f.id}`;
    let d = out.get(key);
    if (!d) {
      d = {
        caseKey: key,
        connectionId: f.connectionId,
        fulfillmentId: f.id,
        orderId: f.order.id,
        companyId: f.order.companyId ?? conn.get(f.connectionId)?.companyId ?? null,
        sources: [],
        state: "RETURNING",
        rawStatus: f.rawStatus,
        returnType: null,
        reference: f.order.number,
        trackingNumbers: uniq(f.trackingNumbers),
        returnTracking: returnTrackingOf(f.returnInfo),
        items: f.items,
        photos: [],
        localReturnUid: null,
        returningSince: f.returningEventAt,
        receivedAt: null,
      };
      out.set(key, d);
    }
    return d;
  };
  const addSource = (d: CaseDraft, src: ReturnSource) => {
    if (!d.sources.includes(src)) d.sources.push(src);
  };
  const receive = (d: CaseDraft, at: Date | null) => {
    d.state = "RECEIVED";
    d.receivedAt = minDate(d.receivedAt, at);
  };

  // 1. CRM shipments in a return status (euShipments RETURNING / RETURN_RECEIVED, FHB RETURN_RECEIVED).
  for (const f of input.fulfillments) {
    const type = conn.get(f.connectionId)?.type;
    if (!type) continue;
    const fhbReturnInfo = type === "FHB_V3" && !!obj(f.returnInfo).returnedAt;
    if (!RETURN_STATUSES.has(f.status) && !fhbReturnInfo) continue;
    const d = draftFor(f);
    addSource(d, type === "EUSHIPMENTS" ? "EUSHIPMENTS" : "FHB_RMA");
    if (f.status === "RETURN_RECEIVED" || fhbReturnInfo) {
      receive(d, minDate(f.receivedEventAt, parseDate(obj(f.returnInfo).returnedAt)));
      d.returnType = s(obj(f.returnInfo).returnType) ?? d.returnType;
    }
  }

  // 2. FHB rma/list: back at the warehouse.
  const rmaUnlinked = new Map<string, CaseDraft>();
  for (const r of input.rma) {
    if (conn.get(r.connectionId)?.type !== "FHB_V3") continue;
    const f = fById.get(`${r.connectionId}:${r.externalId}`);
    let d: CaseDraft;
    if (f) {
      d = draftFor(f);
      d.trackingNumbers = uniq([...d.trackingNumbers, ...r.trackingNumbers]);
      d.returnTracking = uniq([
        ...d.returnTracking,
        ...returnTrackingOf({ packageReturns: obj(r.raw).package_returns }),
      ]);
    } else {
      const key = `fhb-rma:${r.connectionId}:${r.externalId}`;
      d = {
        caseKey: key,
        connectionId: r.connectionId,
        fulfillmentId: null,
        orderId: null,
        companyId: conn.get(r.connectionId)?.companyId ?? null,
        sources: [],
        state: "RECEIVED",
        rawStatus: r.rawStatus,
        returnType: null,
        reference: r.externalId,
        trackingNumbers: uniq(r.trackingNumbers),
        returnTracking: returnTrackingOf({ packageReturns: obj(r.raw).package_returns }),
        items: rmaItems(r.raw),
        photos: [],
        localReturnUid: null,
        returningSince: null,
        receivedAt: null,
      };
      out.set(key, d);
      rmaUnlinked.set(key, d);
    }
    addSource(d, "FHB_RMA");
    d.rawStatus = r.rawStatus ?? d.rawStatus;
    d.returnType = r.returnType ?? d.returnType;
    receive(d, r.returnedAt);
  }

  // 3. FHB local returns: link by package barcode to a shipment's tracking / return tracking.
  const byBarcode = new Map<string, CaseDraft | FulfillmentIn>();
  for (const f of input.fulfillments) {
    if (conn.get(f.connectionId)?.type !== "FHB_V3") continue;
    for (const t of [
      ...f.trackingNumbers,
      ...returnTrackingOf(f.returnInfo),
      ...returnedPackagesOf(f.returnInfo),
    ])
      byBarcode.set(`${f.connectionId}:${t.trim()}`, f);
  }
  for (const d of rmaUnlinked.values())
    for (const t of [...d.trackingNumbers, ...d.returnTracking]) byBarcode.set(`${d.connectionId}:${t}`, d);

  for (const l of input.local) {
    if (conn.get(l.connectionId)?.type !== "FHB_V3") continue;
    const barcodes = uniq(l.barcodes);
    const hit = barcodes.map((b) => byBarcode.get(`${l.connectionId}:${b}`)).find(Boolean);
    let d: CaseDraft;
    if (hit && "caseKey" in hit) d = hit;
    else if (hit) d = draftFor(hit);
    else {
      const key = `fhb-return:${l.connectionId}:${l.uid}`;
      d = {
        caseKey: key,
        connectionId: l.connectionId,
        fulfillmentId: null,
        orderId: null,
        companyId: conn.get(l.connectionId)?.companyId ?? null,
        sources: [],
        state: "RECEIVED",
        rawStatus: null,
        returnType: null,
        reference: l.uid,
        trackingNumbers: [],
        returnTracking: [],
        items: [],
        photos: [],
        localReturnUid: null,
        returningSince: null,
        receivedAt: null,
      };
      out.set(key, d);
    }
    addSource(d, "FHB_LOCAL");
    d.localReturnUid = d.localReturnUid ?? l.uid;
    d.rawStatus = l.status ?? d.rawStatus;
    d.returnType = d.returnType ?? l.type;
    d.returnTracking = uniq([...d.returnTracking, ...barcodes.filter((b) => !d.trackingNumbers.includes(b))]);
    const items = localItems(l.items);
    // The depot's item list (with condition) is more precise than our order lines.
    if (items.length) d.items = items;
    const photos = localPhotos(l.photos);
    if (photos.length && d.localReturnUid === l.uid) d.photos = photos;
    receive(d, l.vendorCreatedAt);
  }

  for (const d of out.values()) d.sources.sort();
  return [...out.values()];
}

/** Days between two instants (floor, never negative). */
export const daysBetween = (from: Date, to: Date) =>
  Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));

/** "Returning but not received after N days". */
export function isOverdue(
  c: { state: string; processedAt: Date | null; returningSince: Date | null; firstSeenAt: Date },
  days: number,
  now: Date,
) {
  if (c.state !== "RETURNING" || c.processedAt) return false;
  return daysBetween(c.returningSince ?? c.firstSeenAt, now) >= days;
}
