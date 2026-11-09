import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { EU_OPS } from "@/integrations/eushipments/adapter";
import { DomainError } from "@/server/accounts";
import { assertCan, ForbiddenError } from "@/server/auth/rbac";
import { companyFilter, type CompanyScope } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import { queueEuProduct } from "@/server/eushipments/write";
import { queueFhbProduct } from "@/server/fhb/products";
import { FhbPreflightError } from "@/server/fhb/orders";
import { lineProductWhere } from "@/server/lines/lines";
import type { ScopedActor } from "@/server/stores";

/**
 * "Създаване в склада" (owner request 2026-11-09): master products of a warehouse's product line that the warehouse
 * does not have yet, created there from the CRM. Nothing is sent from here: each product goes through the existing
 * per-warehouse writers (euShipments create-product / FHB product create), i.e. the outbox and the connection's
 * live mode (READ_ONLY refuses, DRY_RUN records the exact payload, CANARY / LIVE send). OWNER / ADMIN.
 */

export const TO_WAREHOUSE_TYPES = ["EUSHIPMENTS", "FHB_V3"] as const;
const CREATE_OPS = [EU_OPS.createProduct, "fhb.product.create"];
export const TO_WAREHOUSE_PAGE = 50;
export const TO_WAREHOUSE_MAX = 200;

type Ctx = {
  accountId: string;
  companyScope: CompanyScope;
  activeCompanyId: string | null;
  lineCompanyIds?: string[] | null;
};

/** Warehouses a product can be created in (the member's scope and sidebar line). */
export function warehouseCreateTargets(ctx: Ctx) {
  return accountDb(ctx.accountId).fulfillmentConnection.findMany({
    where: { type: { in: [...TO_WAREHOUSE_TYPES] }, enabled: true, ...companyFilter(ctx) },
    select: {
      id: true,
      name: true,
      type: true,
      liveMode: true,
      skuPrefixRule: true,
      company: { select: { lineId: true } },
    },
    orderBy: { name: "asc" },
  });
}

export interface MissingRow {
  id: string;
  sku: string;
  name: string;
  ean: string | null;
  /** Fields the warehouse needs that the master lacks (euShipments: barcode and size / weight). */
  missing: string[];
  /** The latest create request for this product at this warehouse (status), if any. */
  request: { status: string; lastError: string | null } | null;
}

/** Masters of the warehouse's line that the warehouse does not have (no live link), page by page. */
export async function productsMissingAt(
  ctx: Ctx,
  connectionId: string,
  opts: { q?: string; page?: number; onlyReady?: boolean } = {},
) {
  const db = accountDb(ctx.accountId);
  const conn = await db.fulfillmentConnection.findFirst({
    where: { id: connectionId, type: { in: [...TO_WAREHOUSE_TYPES] }, ...companyFilter(ctx) },
    select: { id: true, type: true, company: { select: { lineId: true } } },
  });
  if (!conn) throw new DomainError("not_found");
  const q = opts.q?.trim();
  const eu = conn.type === "EUSHIPMENTS";
  const where: Prisma.ProductWhereInput = {
    AND: [
      { archived: false },
      lineProductWhere(conn.company?.lineId),
      { vendorProducts: { none: { connectionId, archived: false } } },
      q
        ? {
            OR: [
              { sku: { contains: q, mode: "insensitive" } },
              { name: { contains: q, mode: "insensitive" } },
            ],
          }
        : {},
      opts.onlyReady && eu
        ? {
            weightGrams: { gt: 0 },
            lengthMm: { gt: 0 },
            widthMm: { gt: 0 },
            heightMm: { gt: 0 },
            eans: { some: {} },
          }
        : {},
    ],
  };
  const page = Math.max(1, opts.page ?? 1);
  const [total, products] = await Promise.all([
    db.product.count({ where }),
    db.product.findMany({
      where,
      orderBy: { sku: "asc" },
      skip: (page - 1) * TO_WAREHOUSE_PAGE,
      take: TO_WAREHOUSE_PAGE,
      select: {
        id: true,
        sku: true,
        name: true,
        weightGrams: true,
        lengthMm: true,
        widthMm: true,
        heightMm: true,
        eans: { orderBy: { createdAt: "asc" }, take: 1, select: { ean: true } },
      },
    }),
  ]);
  const requests = await latestCreateRequests(
    ctx.accountId,
    connectionId,
    products.map((p) => p.id),
  );
  const rows: MissingRow[] = products.map((p) => {
    const missing: string[] = [];
    if (eu) {
      if (!p.eans[0]) missing.push("barcode");
      if (!(p.weightGrams && p.weightGrams > 0)) missing.push("weight");
      if (!(p.lengthMm && p.widthMm && p.heightMm)) missing.push("size");
    }
    if (!p.name.trim()) missing.push("name");
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      ean: p.eans[0]?.ean ?? null,
      missing,
      request: requests.get(p.id) ?? null,
    };
  });
  return { rows, total, page, pages: Math.max(1, Math.ceil(total / TO_WAREHOUSE_PAGE)), type: conn.type };
}

/** The newest create-product request per product at this warehouse (ids from the stored payload). */
async function latestCreateRequests(accountId: string, connectionId: string, productIds: string[]) {
  const out = new Map<string, { status: string; lastError: string | null }>();
  if (!productIds.length) return out;
  const want = new Set(productIds);
  const reqs = await accountDb(accountId).outboundRequest.findMany({
    where: { connectionId, operation: { in: CREATE_OPS } },
    orderBy: { createdAt: "desc" },
    take: 2000,
    select: { status: true, lastError: true, payload: true },
  });
  for (const r of reqs) {
    const p = r.payload as { ctx?: { productId?: string }; meta?: { productId?: string } } | null;
    const id = p?.ctx?.productId ?? p?.meta?.productId;
    if (id && want.has(id) && !out.has(id)) out.set(id, { status: r.status, lastError: r.lastError });
  }
  return out;
}

export const QueueToWarehouseInput = z.object({
  connectionId: z.string().min(1).max(64),
  productIds: z.array(z.string().min(1).max(64)).min(1).max(TO_WAREHOUSE_MAX),
});

export interface QueueToWarehouseResult {
  queued: number;
  already: number;
  failed: { productId: string; code: string }[];
}

/** Queues the create of each product at the warehouse (one writer call each; a refused one never stops the rest). */
export async function queueProductsToWarehouse(
  actor: ScopedActor,
  raw: z.input<typeof QueueToWarehouseInput>,
): Promise<QueueToWarehouseResult> {
  assertCan(actor.role, "vendorProducts.write");
  const input = QueueToWarehouseInput.parse(raw);
  const conn = await accountDb(actor.accountId).fulfillmentConnection.findFirst({
    where: {
      id: input.connectionId,
      type: { in: [...TO_WAREHOUSE_TYPES] },
      ...(actor.companyScope ? { companyId: { in: actor.companyScope } } : {}),
    },
    select: { id: true, type: true },
  });
  if (!conn) throw new DomainError("not_found");
  const res: QueueToWarehouseResult = { queued: 0, already: 0, failed: [] };
  for (const productId of [...new Set(input.productIds)]) {
    try {
      const r =
        conn.type === "EUSHIPMENTS"
          ? await queueEuProduct(actor, { connectionId: conn.id, productId })
          : await queueFhbProduct(actor, { connectionId: conn.id, productId });
      if ((r as { created?: boolean }).created === false) res.already++;
      else res.queued++;
    } catch (err) {
      if (err instanceof ForbiddenError) throw err;
      const code =
        err instanceof FhbPreflightError
          ? (err.findings.find((f) => f.severity === "hard")?.code ?? err.code)
          : err instanceof DomainError
            ? err.code
            : "unexpected";
      res.failed.push({ productId, code });
    }
  }
  return res;
}
