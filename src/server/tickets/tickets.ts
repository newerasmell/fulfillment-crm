import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { companyFilter } from "@/server/companies";
import { accountDb, isUniqueViolation, systemDb, withAccountTransaction } from "@/server/db/client";
import type { BoardCtx } from "@/server/returns/board";
import type { ScopedActor } from "@/server/stores";

/**
 * Тикети от склада (P10-02). FHB's API only sends ticket NOTIFICATIONS for an order — the order notification
 * URLs ticket_created / ticket_updated / ticket_closed (INTEGRATION_NOTES §2.2) — with no documented body, so
 * there is no ticket id, subject, text or reply here: those stay in ZOE (DESIGN.md "Stays in the vendor panel").
 * What the CRM keeps is one record per shipment: state of the latest event, first/last event time, event count,
 * and the operator's "прегледан" mark with a note (audited). euShipments has no ticket API at all.
 */

export const TICKET_EVENTS = ["ticket_created", "ticket_updated", "ticket_closed"] as const;
export type TicketEvent = (typeof TICKET_EVENTS)[number];
export const TICKET_STATES = ["OPEN", "UPDATED", "CLOSED"] as const;
export type TicketState = (typeof TICKET_STATES)[number];
export const TICKET_ALERT_KIND = "fhb_ticket_created";

const STATE_OF: Record<TicketEvent, TicketState> = {
  ticket_created: "OPEN",
  ticket_updated: "UPDATED",
  ticket_closed: "CLOSED",
};

export const isTicketEvent = (v: string): v is TicketEvent =>
  (TICKET_EVENTS as readonly string[]).includes(v);

/**
 * Stores one ticket notification (worker, from processFhbCallback). Idempotent per stored callback: a retried
 * job finds its FhbTicketEvent and changes nothing. Events can arrive out of order: the state follows the
 * latest event by time received. ticket_created raises one alert per shipment (while one is open);
 * ticket_closed resolves it.
 */
export async function recordFhbTicketEvent(
  accountId: string,
  input: { fulfillmentId: string; webhookEventId: string; event: TicketEvent; receivedAt: Date },
) {
  return withAccountTransaction(accountId, async (tx, { lockKey }) => {
    await lockKey(`fhb-ticket:${input.fulfillmentId}`);
    const seen = await tx.fhbTicketEvent.findUnique({ where: { webhookEventId: input.webhookEventId } });
    if (seen) return { recorded: false as const, ticketId: seen.ticketId };
    const f = await tx.fulfillment.findUnique({
      where: { id: input.fulfillmentId },
      select: { id: true, externalId: true, order: { select: { number: true } } },
    });
    if (!f) throw new DomainError("not_found");
    const state = STATE_OF[input.event];
    const existing = await tx.fhbTicket.findUnique({
      where: { accountId_fulfillmentId: { accountId, fulfillmentId: f.id } },
    });
    const at = input.receivedAt;
    let ticketId: string;
    if (!existing) {
      const created = await tx.fhbTicket.create({
        data: {
          accountId,
          fulfillmentId: f.id,
          state,
          lastEvent: input.event,
          eventCount: 1,
          firstEventAt: at,
          lastEventAt: at,
          closedAt: state === "CLOSED" ? at : null,
        },
        select: { id: true },
      });
      ticketId = created.id;
    } else {
      ticketId = existing.id;
      const newest = at.getTime() >= existing.lastEventAt.getTime();
      await tx.fhbTicket.update({
        where: { id: existing.id },
        data: {
          eventCount: { increment: 1 },
          ...(at < existing.firstEventAt ? { firstEventAt: at } : {}),
          ...(newest
            ? {
                state,
                lastEvent: input.event,
                lastEventAt: at,
                closedAt: state === "CLOSED" ? at : null,
              }
            : {}),
        },
      });
    }
    try {
      await tx.fhbTicketEvent.create({
        data: {
          accountId,
          ticketId,
          webhookEventId: input.webhookEventId,
          event: input.event,
          receivedAt: at,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new DomainError("duplicate_event");
      throw err;
    }
    const open = await tx.alert.findFirst({
      where: {
        kind: TICKET_ALERT_KIND,
        entityType: "Fulfillment",
        entityId: f.id,
        status: { not: "RESOLVED" },
      },
      select: { id: true },
    });
    if (input.event === "ticket_created" && !open) {
      await tx.alert.create({
        data: {
          accountId,
          kind: TICKET_ALERT_KIND,
          severity: "WARNING",
          isTask: true,
          title: `FHB opened a ticket for ${f.order.number} (${f.externalId})`,
          body: "The ticket text and replies are in ZOE (the FHB API only notifies). Read and answer it there.",
          entityType: "Fulfillment",
          entityId: f.id,
        },
      });
    }
    if (input.event === "ticket_closed" && open) {
      const final = await tx.fhbTicket.findUnique({ where: { id: ticketId }, select: { state: true } });
      if (final?.state === "CLOSED") {
        await tx.alert.update({ where: { id: open.id }, data: { status: "RESOLVED", resolvedAt: at } });
        await tx.alertNote.create({
          data: { accountId, alertId: open.id, action: "auto_resolve", note: "ticket closed at FHB" },
        });
      }
    }
    return { recorded: true as const, ticketId };
  });
}

// ───────────────────────── board ─────────────────────────

export const TICKET_TABS = ["open", "unreviewed", "closed", "all"] as const;
export type TicketTab = (typeof TICKET_TABS)[number];

export interface TicketFilter {
  tab?: TicketTab;
  connectionTypes?: readonly string[];
  q?: string;
}

const scopeWhere = (ctx: BoardCtx): Prisma.FhbTicketWhereInput => ({
  fulfillment: {
    order: companyFilter({
      companyScope: ctx.companyScope ?? null,
      activeCompanyId: ctx.activeCompanyId ?? null,
      lineCompanyIds: ctx.lineCompanyIds ?? null,
    }),
  },
});

function tabWhere(tab: TicketTab): Prisma.FhbTicketWhereInput {
  switch (tab) {
    case "open":
      return { state: { in: ["OPEN", "UPDATED"] } };
    case "closed":
      return { state: "CLOSED" };
    case "unreviewed":
      return { reviewedAt: null };
    default:
      return {};
  }
}

const reviewedNow = (t: { reviewedAt: Date | null; lastEventAt: Date }) =>
  !!t.reviewedAt && t.reviewedAt.getTime() >= t.lastEventAt.getTime();

export async function listTickets(ctx: BoardCtx, f: TicketFilter = {}, now = new Date()) {
  assertCan(ctx.role, "account.read");
  const db = accountDb(ctx.accountId);
  const q = f.q?.trim().slice(0, 80);
  const base: Prisma.FhbTicketWhereInput = {
    AND: [
      scopeWhere(ctx),
      ...(f.connectionTypes
        ? [{ fulfillment: { connection: { type: { in: f.connectionTypes as never } } } }]
        : []),
      ...(q
        ? [
            {
              OR: [
                { fulfillment: { externalId: { contains: q, mode: "insensitive" as const } } },
                { fulfillment: { order: { number: { contains: q, mode: "insensitive" as const } } } },
                { fulfillment: { trackingNumbers: { has: q } } },
              ],
            },
          ]
        : []),
    ],
  };
  const tab = f.tab ?? "open";
  const [rows, ...counts] = await Promise.all([
    db.fhbTicket.findMany({
      where: { AND: [base, tabWhere(tab)] },
      // Open first, then the most recent activity.
      orderBy: [{ closedAt: { sort: "desc", nulls: "first" } }, { lastEventAt: "desc" }],
      take: 300,
      include: {
        fulfillment: {
          select: {
            id: true,
            externalId: true,
            status: true,
            rawStatus: true,
            trackingNumbers: true,
            connection: { select: { id: true, name: true, type: true } },
            order: { select: { id: true, number: true, companyId: true } },
          },
        },
      },
    }),
    ...TICKET_TABS.map((t) => db.fhbTicket.count({ where: { AND: [base, tabWhere(t)] } })),
  ]);
  const userIds = [...new Set(rows.map((r) => r.reviewedById).filter((x): x is string => !!x))];
  const companyIds = [
    ...new Set(rows.map((r) => r.fulfillment.order.companyId).filter((x): x is string => !!x)),
  ];
  const [users, companies] = await Promise.all([
    userIds.length
      ? systemDb().user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : [],
    db.company.findMany({
      where: { id: { in: companyIds } },
      select: { id: true, name: true, line: { select: { name: true, color: true } } },
    }),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const companyOf = new Map(companies.map((c) => [c.id, c]));
  return {
    counts: Object.fromEntries(TICKET_TABS.map((t, i) => [t, counts[i] ?? 0])) as Record<TicketTab, number>,
    rows: rows.map((r) => {
      const company = r.fulfillment.order.companyId
        ? companyOf.get(r.fulfillment.order.companyId)
        : undefined;
      const end = r.state === "CLOSED" ? (r.closedAt ?? r.lastEventAt) : now;
      return {
        id: r.id,
        state: r.state as TicketState,
        lastEvent: r.lastEvent,
        eventCount: r.eventCount,
        firstEventAt: r.firstEventAt,
        lastEventAt: r.lastEventAt,
        closedAt: r.closedAt,
        ageDays: Math.max(0, Math.floor((end.getTime() - r.firstEventAt.getTime()) / 86_400_000)),
        reviewed: reviewedNow(r),
        reviewedAt: r.reviewedAt,
        reviewedBy: r.reviewedById ? (userName.get(r.reviewedById) ?? null) : null,
        reviewNote: r.reviewNote,
        shipment: {
          id: r.fulfillment.id,
          externalId: r.fulfillment.externalId,
          status: r.fulfillment.status,
          rawStatus: r.fulfillment.rawStatus,
          trackingNumbers: r.fulfillment.trackingNumbers,
        },
        connection: r.fulfillment.connection,
        order: { id: r.fulfillment.order.id, number: r.fulfillment.order.number },
        company: company ? { name: company.name, line: company.line } : null,
      };
    }),
  };
}

/** Начало → "Тикети": open tickets nobody has reviewed since their latest event (same scope as the board). */
export async function countOpenTickets(ctx: BoardCtx, f: { connectionTypes?: readonly string[] } = {}) {
  assertCan(ctx.role, "account.read");
  const rows = await accountDb(ctx.accountId).fhbTicket.findMany({
    where: {
      AND: [
        scopeWhere(ctx),
        { state: { in: ["OPEN", "UPDATED"] } },
        ...(f.connectionTypes
          ? [{ fulfillment: { connection: { type: { in: f.connectionTypes as never } } } }]
          : []),
      ],
    },
    select: { reviewedAt: true, lastEventAt: true },
    take: 5000,
  });
  return rows.filter((r) => !reviewedNow(r)).length;
}

const Note = z.string().trim().min(2).max(1000);
const Id = z.string().min(1).max(64);

/** "Прегледан" with a note (audited). Resolves the ticket's open alert: the operator has looked at it in ZOE. */
export async function markTicketReviewed(ctx: ScopedActor, ticketId: string, rawNote: string) {
  assertCan(ctx.role, "tickets.review");
  const id = Id.parse(ticketId);
  const note = Note.parse(rawNote);
  const db = accountDb(ctx.accountId);
  const ticket = await db.fhbTicket.findUnique({
    where: { id },
    include: {
      fulfillment: { select: { id: true, externalId: true, order: { select: { companyId: true } } } },
    },
  });
  if (!ticket) throw new DomainError("not_found");
  const scope = ctx.companyScope ?? null;
  const companyId = ticket.fulfillment.order.companyId;
  if (scope && (!companyId || !scope.includes(companyId))) throw new DomainError("not_found");
  const now = new Date();
  await withAccountTransaction(ctx.accountId, async (tx) => {
    await tx.fhbTicket.update({
      where: { id },
      data: { reviewedAt: now, reviewedById: ctx.userId, reviewNote: note },
    });
    const open = await tx.alert.findMany({
      where: {
        kind: TICKET_ALERT_KIND,
        entityType: "Fulfillment",
        entityId: ticket.fulfillmentId,
        status: { not: "RESOLVED" },
      },
      select: { id: true },
    });
    for (const a of open) {
      await tx.alert.update({ where: { id: a.id }, data: { status: "RESOLVED", resolvedAt: now } });
      await tx.alertNote.create({
        data: {
          accountId: ctx.accountId,
          alertId: a.id,
          userId: ctx.userId,
          action: "resolve",
          note: `ticket reviewed: ${note}`.slice(0, 1000),
        },
      });
    }
  });
  await recordAudit({
    accountId: ctx.accountId,
    userId: ctx.userId,
    action: "ticket.reviewed",
    entityType: "FhbTicket",
    entityId: id,
    before: ticket.reviewedAt ? { reviewedAt: ticket.reviewedAt, note: ticket.reviewNote } : undefined,
    after: { note, shipment: ticket.fulfillment.externalId, state: ticket.state },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}
