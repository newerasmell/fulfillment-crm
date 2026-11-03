import type { CompanyScope } from "@/server/companies";
import { accountDb } from "@/server/db/client";
import { countSuspicious } from "@/server/products/suspicious";
import { lineMembers } from "./lines";

/**
 * Coverage report of a line (P5-00): share of warehouse products (non-archived, of the line's FHB/euShipments
 * connections) and store variants (of the line's stores) linked to a master product. Target ≥ 99% before a
 * connection goes LIVE.
 */
export const COVERAGE_TARGET = 0.99;

export interface CoveragePart {
  id: string;
  name: string;
  kind: "warehouse" | "store";
  type: string;
  total: number;
  linked: number;
}

export interface LineCoverage {
  lineId: string;
  warehouses: { total: number; linked: number };
  stores: { total: number; linked: number };
  parts: CoveragePart[];
  /** 0..1 over everything; 1 when there is nothing to link. */
  ratio: number;
  meetsTarget: boolean;
  /** Flagged "Съмнителни връзки" of the line's warehouses and stores (names disagree, not confirmed). */
  suspicious: number;
}

export const ratioOf = (linked: number, total: number) => (total ? linked / total : 1);

/** `scope`: a restricted member's companies — coverage then counts only their warehouses and stores. */
export async function lineCoverage(
  accountId: string,
  lineId: string,
  scope: CompanyScope = null,
): Promise<LineCoverage> {
  const db = accountDb(accountId);
  const m = await lineMembers(accountId, lineId, scope);
  const connIds = m.connections.map((c) => c.id);
  const storeIds = m.stores.map((s) => s.id);
  const [vpAll, vpLinked, vlAll, vlLinked, suspicious] = await Promise.all([
    connIds.length
      ? db.vendorProduct.groupBy({
          by: ["connectionId"],
          where: { connectionId: { in: connIds }, archived: false },
          _count: { _all: true },
        })
      : [],
    connIds.length
      ? db.vendorProduct.groupBy({
          by: ["connectionId"],
          where: { connectionId: { in: connIds }, archived: false, productId: { not: null } },
          _count: { _all: true },
        })
      : [],
    storeIds.length
      ? db.storeVariantLink.groupBy({
          by: ["storeId"],
          where: { storeId: { in: storeIds } },
          _count: { _all: true },
        })
      : [],
    storeIds.length
      ? db.storeVariantLink.groupBy({
          by: ["storeId"],
          where: { storeId: { in: storeIds }, productId: { not: null } },
          _count: { _all: true },
        })
      : [],
    countSuspicious(accountId, [...connIds, ...storeIds], lineId),
  ]);
  const count = <K extends string>(rows: ({ _count: { _all: number } } & Record<K, string>)[], key: K) =>
    new Map(rows.map((r) => [r[key], r._count._all]));
  const vpA = count(vpAll, "connectionId");
  const vpL = count(vpLinked, "connectionId");
  const vlA = count(vlAll, "storeId");
  const vlL = count(vlLinked, "storeId");
  const parts: CoveragePart[] = [
    ...m.connections.map((c) => ({
      id: c.id,
      name: c.name,
      kind: "warehouse" as const,
      type: c.type,
      total: vpA.get(c.id) ?? 0,
      linked: vpL.get(c.id) ?? 0,
    })),
    ...m.stores.map((s) => ({
      id: s.id,
      name: s.name,
      kind: "store" as const,
      type: "STORE",
      total: vlA.get(s.id) ?? 0,
      linked: vlL.get(s.id) ?? 0,
    })),
  ];
  const sum = (kind: CoveragePart["kind"]) =>
    parts
      .filter((p) => p.kind === kind)
      .reduce((a, p) => ({ total: a.total + p.total, linked: a.linked + p.linked }), { total: 0, linked: 0 });
  const warehouses = sum("warehouse");
  const stores = sum("store");
  const ratio = ratioOf(warehouses.linked + stores.linked, warehouses.total + stores.total);
  return { lineId, warehouses, stores, parts, ratio, meetsTarget: ratio >= COVERAGE_TARGET, suspicious };
}
