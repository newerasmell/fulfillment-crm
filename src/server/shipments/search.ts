import { assertCan } from "@/server/auth/rbac";
import { companyFilter } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import type { BoardCtx } from "@/server/returns/board";
import { searchWhere } from "./board";

/**
 * Header search (Ctrl/Cmd K): orders by number / customer / phone / e-mail and shipments by tracking number,
 * shipment id or vendor id. Same company / line scope as every list; a handful of hits per kind.
 */
export async function globalSearch(ctx: BoardCtx, raw: string, take = 6) {
  assertCan(ctx.role, "account.read");
  const q = raw.trim().slice(0, 80);
  if (q.length < 2) return { orders: [], shipments: [] };
  const scope = companyFilter({
    companyScope: ctx.companyScope ?? null,
    activeCompanyId: ctx.activeCompanyId ?? null,
    lineCompanyIds: ctx.lineCompanyIds ?? null,
  });
  const db = accountDb(ctx.accountId);
  const phone = q.replace(/[\s()/-]/g, "").replace(/^\+/, "");
  const [orders, shipments] = await Promise.all([
    db.order.findMany({
      where: {
        AND: [
          scope,
          {
            OR: [
              { number: { contains: q, mode: "insensitive" } },
              { customerName: { contains: q, mode: "insensitive" } },
              { email: { equals: q, mode: "insensitive" } },
              ...(/^\d{5,}$/.test(phone) ? [{ phone: { contains: phone } }] : []),
            ],
          },
        ],
      },
      orderBy: { placedAt: "desc" },
      take,
      select: { id: true, number: true, customerName: true, status: true },
    }),
    db.fulfillment.findMany({
      where: { AND: [{ order: scope }, searchWhere(q)] },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        externalId: true,
        status: true,
        trackingNumbers: true,
        connection: { select: { name: true, type: true } },
        order: { select: { number: true } },
      },
    }),
  ]);
  return { orders, shipments };
}
