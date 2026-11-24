import type { Prisma } from "@/generated/prisma/client";
import type { FhbOrderView } from "@/integrations/fhb-v3/schemas";
import { scrubText } from "@/lib/scrub";
import { accountDb } from "@/server/db/client";

/**
 * The carrier's own events of an FHB shipment (owner report 2026-11-23): FHB returns them with every order read
 * (`tracking_events`: date, message, event_code, carrier_event_code — the codes are not documented). FHB's order
 * status stays "sent" while the carrier already returns the parcel ("Return to sender"), so without these the CRM
 * only saw "stuck in SHIPPED for 240 h". Each event is stored once as a FulfillmentEvent (source `fhb:courier`), the
 * order page shows the latest, and a return to the sender opens a task. The CRM status is not changed by them: FHB's
 * own "returned" (or `returned_at`) still decides that.
 */

type Tx = Prisma.TransactionClient;
export const COURIER_SOURCE = "fhb:courier";
export const RETURNING_TASK = "parcel_returning";

export interface CourierEvent {
  key: string;
  at: Date | null;
  message: string;
  code: string | null;
  carrierCode: string | null;
}

/** Pure: the view's carrier events, oldest first, each with a stable key. */
export function courierEvents(view: Pick<FhbOrderView, "tracking_events">): CourierEvent[] {
  return (view.tracking_events ?? [])
    .map((e) => {
      const message = (e.message ?? "").trim();
      const at = e.date ? new Date(e.date.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : null;
      return {
        key: [e.date ?? "", e.event_code ?? "", e.carrier_event_code ?? "", message].join("|").slice(0, 300),
        at: at && !Number.isNaN(at.getTime()) ? at : null,
        message,
        code: e.event_code ?? null,
        carrierCode: e.carrier_event_code ?? null,
      };
    })
    .filter((e) => e.message || e.code)
    .sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
}

/**
 * Pure: does the carrier say the parcel IS going back to the sender? Carriers write it in their own language; the
 * text is compared without accents (Czech "Vrácení odesílateli" → "vraceni odesilateli"). Tested phrases: EN
 * "Return(ed/ing) to sender/shipper", HR/SI "Povrat pošiljatelju", "Vrnjeno pošiljatelju", CZ "Vráceno/Vrácení
 * odesílateli", SK "Vrátenie odosielateľovi", HU "Visszaküldés a feladónak", PL "Zwrot do nadawcy", DE "Rücksendung an
 * den Absender", RO "Retur la expeditor", BG "Връщане към подателя". A notice that it WILL be returned if not
 * collected, or a cancelled return, is not it.
 */
export function isReturnToSender(message: string): boolean {
  const m = message.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (/\b(if|unless|will be|cancel\w*|storn\w*|wenn|falls|ha nem|pokud|ak nie|jesli|daca)\b|ако не/.test(m))
    return false;
  return (
    /return(ed|ing)?\s+to\s+(the\s+)?(sender|shipper)|back\s+to\s+(the\s+)?sender/.test(m) ||
    /povrat\w*\s+(posiljatelj|posiljaoc)|vrnjen\w*\s+posiljatelj|vrac\w*\s+(posiljatelj|odesilatel)/.test(
      m,
    ) ||
    /vrat\w*\s+odosielatel|vissza\w*\s+(a\s+)?feladonak|zwrot\w*\s+do\s+nadawcy/.test(m) ||
    /rucksendung\s+an\s+(den\s+)?absender|zuruck\s+an\s+(den\s+)?absender|retur\w*\s+(la|catre)\s+expeditor/.test(
      m,
    ) ||
    /retour\s+(a\s+l.expediteur|afzender)|(връщане|върнат\w*|връща\s+се)\s+(към|на)\s+подател/.test(m)
  );
}

/**
 * Pure: does the carrier say the parcel was handed to the recipient (owner report 2026-11-24: GLS "Podpísané na
 * papieri", FHB still "sent")? Compared without accents, in the carriers' languages: EN "Delivered", SK "Podpísané" /
 * "Doručené", CZ "Doručeno", HU "Kézbesítve", HR/SI "Dostavljeno" / "Uručeno" / "Vročeno", PL "Doręczona", DE
 * "Zugestellt", RO "Livrat", BG "Доставена", EL "Παραδόθηκε". Not: a parcel left at a pick-up point / box / office (the
 * customer has not taken it), an attempt, or a negation.
 */
export function isDeliveredToRecipient(message: string): boolean {
  const m = message.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  // Not done yet (future, in progress, an attempt) or negated.
  if (
    /\b(not|unable|failed|attempt\w*|undeliver\w*|could|will|expected|scheduled|out for|to be|nie|nem|ne|nebol\w*|nebyl\w*|nicht|pokus\w*|kiserlet\w*|nije|neuspe\w*|nu|bude|budu|wird|va fi)\b/.test(
      m,
    ) ||
    /ще |не е|не бе|na dorucen|k doruc|v doruc|folyamatban|kiadva|kezbesitesre|tijeku|w doreczeniu|in zustellung|in curs/.test(
      m,
    )
  )
    return false;
  // At a pick-up point / box / office (the customer has not taken it), or back to the sender.
  if (
    /pick-?up|parcel ?shop|parcel ?box|locker|point|depot|office|branch|vyda?jn|vydejn|odbern|box|automat|paczkomat|packstation|paketshop|filiale|punct|punkt|pont|posta|postu|ured|easybox|ofis|офис|автомат/.test(
      m,
    ) ||
    /sender|shipper|odosielatel|odesilatel|feladonak|feladohoz|absender|nadawc|expeditor|posiljatelj|подател/.test(
      m,
    ) ||
    isReturnToSender(message)
  )
    return false;
  // Completed forms only (a noun like "doručení" / "kézbesítés" / "uručenje" is not a delivery).
  return (
    /\b(has been |was |been )?delivered\b|\bpodpisane\b|\bpodpisan[aeoy]\b|\bdorucen[aeoy]\b|\bdoruceno\b|\bkezbesitve\b/.test(
      m,
    ) ||
    /\bdostavljen[aeo]?\b|\burucen[aeo]\b|\bvrocen[aeo]?\b|\bdoreczon[aey]\b|\bzugestellt\b|\blivrat[aă]?\b|доставен[ао]?\b|доставена|παραδοθηκε/.test(
      m,
    )
  );
}

/** Orders (of these) whose live shipment's latest carrier word is a delivery to the recipient — one read per chunk. */
export async function deliveredByCarrier(
  db: { fulfillmentEvent: { findMany: (args: never) => Promise<unknown[]> } },
  orderIds: string[],
) {
  const out = new Set<string>();
  for (let i = 0; i < orderIds.length; i += 1000) {
    const rows = (await db.fulfillmentEvent.findMany({
      where: {
        OR: [{ source: COURIER_SOURCE }, { source: "eushipments" }],
        fulfillment: {
          orderId: { in: orderIds.slice(i, i + 1000) },
          status: { notIn: ["CANCELLED", "SUBMIT_FAILED"] },
        },
      },
      select: {
        fulfillmentId: true,
        occurredAt: true,
        payload: true,
        fulfillment: { select: { orderId: true } },
      },
      orderBy: { occurredAt: "desc" },
    } as never)) as {
      fulfillmentId: string;
      payload: unknown;
      fulfillment: { orderId: string };
    }[];
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const p = (r.payload ?? {}) as { message?: string; comment?: string | null };
      // The carrier's own words only (an euShipments status row without a carrier comment says nothing here).
      if (!p.message && !p.comment) continue;
      if (!latest.has(r.fulfillmentId)) latest.set(r.fulfillmentId, r);
    }
    for (const r of latest.values()) {
      const p = (r.payload ?? {}) as { message?: string; comment?: string | null };
      if (isDeliveredToRecipient(p.message ?? p.comment ?? "")) out.add(r.fulfillment.orderId);
    }
  }
  return out;
}

/** Stores the events not stored yet; returns the newly stored ones. */
export async function recordCourierEvents(
  tx: Tx,
  input: { accountId: string; fulfillmentId: string; events: CourierEvent[]; now: Date },
) {
  if (!input.events.length) return [];
  const stored = await tx.fulfillmentEvent.findMany({
    where: { accountId: input.accountId, fulfillmentId: input.fulfillmentId, source: COURIER_SOURCE },
    select: { payload: true },
  });
  const seen = new Set(stored.map((s) => (s.payload as { key?: string } | null)?.key).filter(Boolean));
  // Not stored yet, each key once (a view may repeat an event).
  const fresh = [...new Map(input.events.filter((e) => !seen.has(e.key)).map((e) => [e.key, e])).values()];
  for (const e of fresh)
    await tx.fulfillmentEvent.create({
      data: {
        accountId: input.accountId,
        fulfillmentId: input.fulfillmentId,
        occurredAt: e.at ?? input.now,
        source: COURIER_SOURCE,
        rawStatus: e.message.slice(0, 200) || e.code,
        // seenAt: when the CRM first learnt it (a task closed after that is not opened again for it).
        payload: {
          key: e.key,
          message: e.message,
          code: e.code,
          carrierCode: e.carrierCode,
          seenAt: input.now.toISOString(),
        },
      },
    });
  return fresh;
}

/**
 * The latest word of the carrier on each live shipment of an order, for the order page: FHB's carrier events, or the
 * carrier text euShipments passes with its statuses (the cabinet's "Courier status" column, stored as `comment`).
 */
export async function latestCourierStatus(accountId: string, orderId: string) {
  const db = accountDb(accountId);
  const shipments = await db.fulfillment.findMany({
    where: { orderId, status: { notIn: ["CANCELLED", "SUBMIT_FAILED"] } },
    select: {
      id: true,
      carrier: true,
      trackingNumbers: true,
      events: {
        where: { OR: [{ source: COURIER_SOURCE }, { source: "eushipments" }] },
        orderBy: { occurredAt: "desc" },
        take: 20,
        select: { source: true, occurredAt: true, payload: true },
      },
    },
  });
  return shipments.flatMap((s) => {
    const e = s.events.find((x) => {
      const p = (x.payload ?? {}) as { message?: string; comment?: string | null };
      return x.source === COURIER_SOURCE ? !!p.message : !!p.comment;
    });
    if (!e) return [];
    const p = (e.payload ?? {}) as { message?: string; comment?: string | null };
    const message = (e.source === COURIER_SOURCE ? p.message : p.comment) ?? "";
    return [
      {
        fulfillmentId: s.id,
        carrier: s.carrier,
        tracking: s.trackingNumbers[0] ?? null,
        message,
        at: e.occurredAt,
        returning: isReturnToSender(message),
        delivered: isDeliveredToRecipient(message),
      },
    ];
  });
}

/** Returns older than this when first seen (a backfill of old orders) open no task. */
export const RETURNING_TASK_WINDOW_MS = 14 * 86_400_000;

/**
 * Decided from what is stored, in the same transaction as the events (never lost to a later failure): the shipment
 * is "sent" at FHB, its latest return-to-sender event is recent, and no task of this kind was opened for the order
 * since that event (a task a person closed stays closed).
 */
export async function openReturningTask(
  tx: Tx,
  input: { accountId: string; orderId: string; fulfillmentId: string; carrier: string | null; now: Date },
) {
  const stored = await tx.fulfillmentEvent.findMany({
    where: { accountId: input.accountId, fulfillmentId: input.fulfillmentId, source: COURIER_SOURCE },
    orderBy: { occurredAt: "desc" },
    select: { occurredAt: true, payload: true },
  });
  const since = input.now.getTime() - RETURNING_TASK_WINDOW_MS;
  // The return scans of the window (a carrier often reports one return several times, newest first).
  const returns = stored.filter(
    (e) =>
      e.occurredAt.getTime() >= since &&
      isReturnToSender((e.payload as { message?: string } | null)?.message ?? ""),
  );
  const ev = returns[0];
  if (!ev) return null;
  // When the CRM first learnt of this return (its earliest scan): a task of any state since then covers it.
  const firstSeen = new Date(
    Math.min(
      ...returns.map((e) =>
        new Date((e.payload as { seenAt?: string } | null)?.seenAt ?? e.occurredAt).getTime(),
      ),
    ),
  );
  const already = await tx.alert.findFirst({
    where: {
      accountId: input.accountId,
      kind: RETURNING_TASK,
      entityType: "Order",
      entityId: input.orderId,
      OR: [{ status: { not: "RESOLVED" } }, { createdAt: { gte: firstSeen } }],
    },
    select: { id: true },
  });
  if (already) return null;
  const order = await tx.order.findFirst({
    where: { accountId: input.accountId, id: input.orderId },
    select: { number: true },
  });
  const message = scrubText((ev.payload as { message?: string } | null)?.message ?? "", 120);
  const when = ev.occurredAt.toISOString().slice(0, 10);
  return tx.alert.create({
    data: {
      accountId: input.accountId,
      kind: RETURNING_TASK,
      severity: "WARNING",
      isTask: true,
      title:
        `Поръчка ${order?.number ?? ""}: куриерът връща пратката към подателя (${input.carrier ? `${input.carrier}: ` : ""}` +
        `${message} · ${when}) — пишете на клиента или изпратете замяна`,
      body:
        "The carrier reports a return to the sender while FHB still has the order as sent. Contact the customer " +
        "(wrong address, not collected?) or send a replacement; the order becomes Returning once FHB records it.",
      entityType: "Order",
      entityId: input.orderId,
    },
    select: { id: true },
  });
}
