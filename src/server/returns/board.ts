import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { companyFilter, type CompanyScope } from "@/server/companies";
import { accountDb, systemDb, withAccountTransaction } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import { daysBetween, isOverdue, RETURN_SOURCES, type ReturnItem, type ReturnSource } from "./build";
import { getReturnsCodSettings } from "./settings";
import { OVERDUE_KIND } from "./sweep";

/**
 * Връщания (P6-01): one list of every return — FHB rma/list, FHB local returns, euShipments returns — with
 * company / product-line / warehouse filters, "processed" with a note, support notification and photos.
 * Every query is scoped by account (accountDb) and by the member's companies (companyFilter).
 */

export const RETURN_TABS = ["todo", "returning", "overdue", "processed", "all"] as const;
export type ReturnTab = (typeof RETURN_TABS)[number];

export type BoardCtx = ScopedActor & {
  activeCompanyId?: string | null;
  lineCompanyIds?: string[] | null;
};

export interface ReturnFilter {
  tab?: ReturnTab;
  source?: ReturnSource;
  /** Connection types of the header warehouse scope (all / FHB / euShipments). */
  connectionTypes?: readonly string[];
  q?: string;
  caseId?: string;
}

const scopeWhere = (ctx: BoardCtx): Prisma.ReturnCaseWhereInput =>
  companyFilter({
    companyScope: ctx.companyScope ?? null,
    activeCompanyId: ctx.activeCompanyId ?? null,
    lineCompanyIds: ctx.lineCompanyIds ?? null,
  });

function tabWhere(tab: ReturnTab, overdueBefore: Date): Prisma.ReturnCaseWhereInput {
  switch (tab) {
    case "todo":
      return { state: "RECEIVED", processedAt: null };
    case "returning":
      return { state: "RETURNING", processedAt: null };
    case "overdue":
      return {
        state: "RETURNING",
        processedAt: null,
        OR: [
          { returningSince: { lte: overdueBefore } },
          { returningSince: null, firstSeenAt: { lte: overdueBefore } },
        ],
      };
    case "processed":
      return { processedAt: { not: null } };
    default:
      return {};
  }
}

export async function listReturns(ctx: BoardCtx, f: ReturnFilter = {}, now = new Date()) {
  assertCan(ctx.role, "account.read");
  const db = accountDb(ctx.accountId);
  const settings = await getReturnsCodSettings(ctx.accountId);
  const overdueBefore = new Date(now.getTime() - settings.returnOverdueDays * 86_400_000);
  const q = f.q?.trim().slice(0, 80);
  const base: Prisma.ReturnCaseWhereInput = {
    ...scopeWhere(ctx),
    ...(f.connectionTypes ? { connection: { type: { in: f.connectionTypes as never } } } : {}),
    ...(f.source ? { sources: { has: f.source } } : {}),
    ...(q
      ? {
          OR: [
            { reference: { contains: q, mode: "insensitive" } },
            { trackingNumbers: { has: q } },
            { returnTracking: { has: q } },
            { localReturnUid: { equals: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const tab = f.tab ?? "todo";
  const [rows, ...counts] = await Promise.all([
    db.returnCase.findMany({
      where: {
        AND: [base, f.caseId ? { id: f.caseId } : tabWhere(tab, overdueBefore)],
      },
      orderBy: [{ receivedAt: { sort: "desc", nulls: "last" } }, { firstSeenAt: "desc" }],
      take: 300,
      include: {
        connection: { select: { id: true, name: true, type: true } },
        notifications: { select: { channel: true, status: true, sentAt: true } },
        photoFiles: { select: { id: true, photoId: true, type: true, status: true } },
      },
    }),
    ...RETURN_TABS.map((t) => db.returnCase.count({ where: { AND: [base, tabWhere(t, overdueBefore)] } })),
  ]);
  const userIds = [...new Set(rows.map((r) => r.processedById).filter((x): x is string => !!x))];
  const companyIds = [...new Set(rows.map((r) => r.companyId).filter((x): x is string => !!x))];
  const [users, companies] = await Promise.all([
    userIds.length
      ? systemDb().user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : [],
    db.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } }),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  return {
    settings,
    counts: Object.fromEntries(RETURN_TABS.map((t, i) => [t, counts[i] ?? 0])) as Record<ReturnTab, number>,
    rows: rows.map((r) => ({
      id: r.id,
      sources: r.sources.filter((s): s is ReturnSource => (RETURN_SOURCES as readonly string[]).includes(s)),
      state: r.state as "RETURNING" | "RECEIVED",
      overdue: isOverdue(r, settings.returnOverdueDays, now),
      daysOnTheWay: r.state === "RETURNING" ? daysBetween(r.returningSince ?? r.firstSeenAt, now) : null,
      rawStatus: r.rawStatus,
      returnType: r.returnType,
      reference: r.reference,
      orderId: r.orderId,
      fulfillmentId: r.fulfillmentId,
      company: r.companyId ? (companyName.get(r.companyId) ?? null) : null,
      connection: r.connection,
      trackingNumbers: r.trackingNumbers,
      returnTracking: r.returnTracking,
      items: (Array.isArray(r.items) ? r.items : []) as unknown as ReturnItem[],
      photos: (Array.isArray(r.photos) ? r.photos : []) as unknown as { id: string; type: string | null }[],
      photoFiles: r.photoFiles,
      localReturnUid: r.localReturnUid,
      returningSince: r.returningSince ?? (r.state === "RETURNING" ? r.firstSeenAt : null),
      receivedAt: r.receivedAt,
      processedAt: r.processedAt,
      processedBy: r.processedById ? (userName.get(r.processedById) ?? null) : null,
      processedNote: r.processedNote,
      supportNotifiedAt: r.supportNotifiedAt,
      supportNotifyRequested: !!r.supportNotifyRequestedAt,
      notifications: r.notifications,
    })),
  };
}

/** The case, if the member may see its company (restricted members never see cases of other companies). */
async function loadCase(ctx: ScopedActor & { companyScope?: CompanyScope }, caseId: string) {
  const c = await accountDb(ctx.accountId).returnCase.findUnique({ where: { id: caseId } });
  if (!c) throw new DomainError("not_found");
  const scope = ctx.companyScope ?? null;
  if (scope && (!c.companyId || !scope.includes(c.companyId))) throw new DomainError("not_found");
  return c;
}

const Note = z.string().trim().min(2).max(1000);
const Id = z.string().min(1).max(64);

export async function markReturnProcessed(ctx: ScopedActor, caseId: string, rawNote: string) {
  assertCan(ctx.role, "returns.manage");
  const id = Id.parse(caseId);
  const note = Note.parse(rawNote);
  const c = await loadCase(ctx, id);
  const now = new Date();
  await withAccountTransaction(ctx.accountId, async (tx) => {
    const r = await tx.returnCase.updateMany({
      where: { id, processedAt: null },
      data: { processedAt: now, processedById: ctx.userId, processedNote: note },
    });
    if (r.count !== 1) throw new DomainError("already_processed");
    // The case's own tasks are done: "still returning" and euShipments' "return received — notify support".
    if (c.fulfillmentId) {
      const open = await tx.alert.findMany({
        where: {
          entityType: "Fulfillment",
          entityId: c.fulfillmentId,
          kind: { in: [OVERDUE_KIND, "eushipments_return_received"] },
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
            note: `return processed: ${note}`.slice(0, 1000),
          },
        });
      }
    }
  });
  await recordAudit({
    accountId: ctx.accountId,
    userId: ctx.userId,
    action: "return.processed",
    entityType: "ReturnCase",
    entityId: id,
    after: { note, reference: c.reference },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

export async function reopenReturn(ctx: ScopedActor, caseId: string) {
  assertCan(ctx.role, "returns.manage");
  const id = Id.parse(caseId);
  const c = await loadCase(ctx, id);
  if (!c.processedAt) throw new DomainError("not_processed");
  await accountDb(ctx.accountId).returnCase.update({
    where: { id },
    data: { processedAt: null, processedById: null, processedNote: null },
  });
  await recordAudit({
    accountId: ctx.accountId,
    userId: ctx.userId,
    action: "return.reopened",
    entityType: "ReturnCase",
    entityId: id,
    before: { note: c.processedNote, processedAt: c.processedAt },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

/** "Уведоми поддръжката": the worker sends it on its next sweep (channels configured on the worker). */
export async function requestSupportNotify(ctx: ScopedActor, caseId: string) {
  assertCan(ctx.role, "returns.manage");
  const id = Id.parse(caseId);
  const c = await loadCase(ctx, id);
  if (c.state !== "RECEIVED") throw new DomainError("not_received");
  if (c.processedAt) throw new DomainError("already_processed");
  await accountDb(ctx.accountId).returnCase.update({
    where: { id },
    data: { supportNotifyRequestedAt: new Date() },
  });
  await recordAudit({
    accountId: ctx.accountId,
    userId: ctx.userId,
    action: "return.notify_support",
    entityType: "ReturnCase",
    entityId: id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

/** Queue the FHB local return photos of a case for download (worker, GET only). Returns how many are queued. */
export async function requestReturnPhotos(
  ctx: ScopedActor,
  caseId: string,
  enqueue: (d: { accountId: string; caseId: string }) => Promise<unknown>,
) {
  assertCan(ctx.role, "returns.manage");
  const id = Id.parse(caseId);
  const c = await loadCase(ctx, id);
  const photos = (Array.isArray(c.photos) ? c.photos : []) as { id?: string; type?: string | null }[];
  if (!c.localReturnUid || photos.length === 0) throw new DomainError("no_photos");
  const db = accountDb(ctx.accountId);
  await db.returnPhoto.createMany({
    data: photos
      .filter((p) => typeof p.id === "string")
      .map((p) => ({ accountId: ctx.accountId, returnCaseId: id, photoId: p.id!, type: p.type ?? null })),
    skipDuplicates: true,
  });
  await db.returnPhoto.updateMany({
    where: { returnCaseId: id, status: "FAILED" },
    data: { status: "PENDING", error: null },
  });
  const pending = await db.returnPhoto.count({ where: { returnCaseId: id, status: "PENDING" } });
  if (pending) await enqueue({ accountId: ctx.accountId, caseId: id });
  return pending;
}

/** One stored photo for the image route (same scope rules as the board). */
export async function readReturnPhoto(ctx: ScopedActor, photoFileId: string) {
  assertCan(ctx.role, "account.read");
  const p = await accountDb(ctx.accountId).returnPhoto.findUnique({
    where: { id: Id.parse(photoFileId) },
    select: { returnCaseId: true, status: true, contentType: true, bytes: true },
  });
  if (!p || p.status !== "READY" || !p.bytes || !p.contentType) throw new DomainError("not_found");
  await loadCase(ctx, p.returnCaseId);
  return { contentType: p.contentType, bytes: p.bytes };
}

/** Начало → "Върнати за възстановяване": received at the warehouse, not processed yet (same scope as the board). */
export async function countReturnsToProcess(ctx: BoardCtx, f: { connectionTypes?: readonly string[] } = {}) {
  assertCan(ctx.role, "account.read");
  return accountDb(ctx.accountId).returnCase.count({
    where: {
      AND: [
        scopeWhere(ctx),
        { state: "RECEIVED", processedAt: null },
        ...(f.connectionTypes ? [{ connection: { type: { in: f.connectionTypes as never } } }] : []),
      ],
    },
  });
}
