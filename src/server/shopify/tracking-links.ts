import { z } from "zod";
import { carrierKey } from "@/integrations/shopify/fulfillments";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import { NOCARRIER_PREFIX, shopifyCompanyFor } from "./carrier-company";

/**
 * "Линкове за проследяване" (owner request 2026-11-09): Shopify's tracking link pointed at the warehouse's page
 * (e.g. FHB's zoe2 tracker) instead of the courier's. Per courier name a link template with {tracking} for the
 * number; the Shopify write-back sends it for every new tracking number of that courier. Without a template the
 * warehouse's link is sent, as before.
 */

export const TRACKING_PLACEHOLDER = "{tracking}";
const MAX_TEMPLATE = 500;

/** The link for one number: the template with the number URL-encoded in place of {tracking}. */
export function applyTrackingTemplate(template: string, number: string) {
  return template.split(TRACKING_PLACEHOLDER).join(encodeURIComponent(number.trim()));
}

export const TrackingTemplate = z
  .string()
  .trim()
  .max(MAX_TEMPLATE)
  .refine((t) => t.includes(TRACKING_PLACEHOLDER), "missing_placeholder")
  .refine((t) => {
    try {
      const u = new URL(applyTrackingTemplate(t, "TEST123"));
      return u.protocol === "https:" && !!u.hostname && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "invalid_url");

type AliasAndLinkReader = Parameters<typeof shopifyCompanyFor>[0] & {
  carrierTrackingLink: {
    findUnique(args: {
      where: { accountId_carrierKey: { accountId: string; carrierKey: string } };
      select: { urlTemplate: true };
    }): Promise<{ urlTemplate: string } | null>;
  };
};

/** The courier's tracking link for this number, or null when no template is set for that courier. */
export async function trackingUrlFor(
  db: AliasAndLinkReader,
  accountId: string,
  carrier: string | null | undefined,
  number: string,
): Promise<string | null> {
  const c = carrier?.trim();
  if (!c || !number.trim()) return null;
  const row = await db.carrierTrackingLink.findUnique({
    where: { accountId_carrierKey: { accountId, carrierKey: carrierKey(c) } },
    select: { urlTemplate: true },
  });
  return row ? applyTrackingTemplate(row.urlTemplate, number) : null;
}

export interface CarrierLinkRow {
  carrierKey: string;
  carrierName: string;
  shipments: number;
  shopifyCompany: string | null;
  urlTemplate: string | null;
  /** A recent tracking number of this courier and the link the warehouse gave for it (to compare). */
  sampleNumber: string | null;
  sampleWarehouseUrl: string | null;
}

/** Every courier name the warehouses reported (and every saved template), with a recent number to test with. */
export async function listCarrierTrackingLinks(accountId: string): Promise<CarrierLinkRow[]> {
  const db = accountDb(accountId);
  const [groups, saved] = await Promise.all([
    db.fulfillment.groupBy({ by: ["carrier"], where: { carrier: { not: null } }, _count: { _all: true } }),
    db.carrierTrackingLink.findMany({ select: { carrierKey: true, carrierName: true, urlTemplate: true } }),
  ]);
  const rows = new Map<string, CarrierLinkRow>();
  for (const g of groups) {
    const name = g.carrier!.trim();
    if (!name) continue;
    const key = carrierKey(name);
    const prev = rows.get(key);
    if (prev) prev.shipments += g._count._all;
    else
      rows.set(key, {
        carrierKey: key,
        carrierName: name,
        shipments: g._count._all,
        shopifyCompany: null,
        urlTemplate: null,
        sampleNumber: null,
        sampleWarehouseUrl: null,
      });
  }
  for (const s of saved) {
    const r = rows.get(s.carrierKey);
    if (r) r.urlTemplate = s.urlTemplate;
    else
      rows.set(s.carrierKey, {
        carrierKey: s.carrierKey,
        carrierName: s.carrierName,
        shipments: 0,
        shopifyCompany: null,
        urlTemplate: s.urlTemplate,
        sampleNumber: null,
        sampleWarehouseUrl: null,
      });
  }
  for (const r of rows.values()) {
    const [company, sample] = await Promise.all([
      shopifyCompanyFor(db, accountId, r.carrierName),
      db.fulfillment.findFirst({
        where: {
          carrier: { equals: r.carrierName, mode: "insensitive" },
          trackingNumbers: { isEmpty: false },
        },
        orderBy: { createdAt: "desc" },
        select: { trackingNumbers: true, trackingUrls: true },
      }),
    ]);
    r.shopifyCompany = company;
    r.sampleNumber = sample?.trackingNumbers[0] ?? null;
    r.sampleWarehouseUrl = sample?.trackingUrls[0] ?? null;
  }
  return [...rows.values()].sort(
    (a, b) => b.shipments - a.shipments || a.carrierName.localeCompare(b.carrierName),
  );
}

export const SaveTrackingLinkInput = z.object({
  carrierName: z.string().trim().min(1).max(200),
  /** Empty = remove (the warehouse's link is sent again). */
  urlTemplate: z.string().trim().max(MAX_TEMPLATE).nullish(),
});

/** Saves (or removes) one courier's link template. OWNER / ADMIN; audited. */
export async function saveCarrierTrackingLink(
  actor: ScopedActor,
  raw: z.input<typeof SaveTrackingLinkInput>,
) {
  assertCan(actor.role, "stores.manage");
  const input = SaveTrackingLinkInput.parse(raw);
  const key = carrierKey(input.carrierName);
  const db = accountDb(actor.accountId);
  const where = { accountId_carrierKey: { accountId: actor.accountId, carrierKey: key } };
  const before = await db.carrierTrackingLink.findUnique({ where, select: { urlTemplate: true } });
  const template = input.urlTemplate ? TrackingTemplate.parse(input.urlTemplate) : null;
  if (template)
    await db.carrierTrackingLink.upsert({
      where,
      create: {
        accountId: actor.accountId,
        carrierKey: key,
        carrierName: input.carrierName,
        urlTemplate: template,
        updatedById: actor.userId,
      },
      update: { urlTemplate: template, carrierName: input.carrierName, updatedById: actor.userId },
    });
  else await db.carrierTrackingLink.deleteMany({ where: { carrierKey: key } });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "carrier.tracking_link",
    entityType: "CarrierTrackingLink",
    entityId: key,
    before: { urlTemplate: before?.urlTemplate ?? null },
    after: { carrierName: input.carrierName, urlTemplate: template },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { urlTemplate: template };
}

export interface NoCarrierRuleRow {
  carrierKey: string;
  company: string;
  connectionName: string | null;
  countryCode: string | null;
  companyName: string | null;
  updatedAt: Date;
}

/**
 * The couriers remembered for shipments a warehouse sends without one (per warehouse + country + company; owner
 * request 2026-11-11), so a wrong pick can be seen and removed.
 */
export async function listNoCarrierRules(view: {
  accountId: string;
  /** A company-scoped person sees only their companies' rules. */
  companyScope: readonly string[] | null;
}): Promise<NoCarrierRuleRow[]> {
  const { accountId, companyScope } = view;
  const db = accountDb(accountId);
  const rules = await db.shopifyCarrierAlias.findMany({
    where: { carrierKey: { startsWith: NOCARRIER_PREFIX } },
    select: { carrierKey: true, company: true, updatedAt: true },
  });
  const parts = rules
    .map((r) => {
      const [connectionId = "", country = "-", companyId = "-"] = r.carrierKey
        .slice(NOCARRIER_PREFIX.length)
        .split(":");
      return { ...r, connectionId, country, companyId };
    })
    .filter((p) => !companyScope || companyScope.includes(p.companyId));
  const [connections, companies] = await Promise.all([
    db.fulfillmentConnection.findMany({
      where: { id: { in: parts.map((p) => p.connectionId) } },
      select: { id: true, name: true },
    }),
    db.company.findMany({
      where: { id: { in: parts.map((p) => p.companyId) } },
      select: { id: true, name: true },
    }),
  ]);
  const conn = new Map(connections.map((c) => [c.id, c.name]));
  const comp = new Map(companies.map((c) => [c.id, c.name]));
  return parts
    .map((p) => ({
      carrierKey: p.carrierKey,
      company: p.company,
      connectionName: conn.get(p.connectionId) ?? null,
      countryCode: p.country === "-" ? null : p.country,
      companyName: comp.get(p.companyId) ?? null,
      updatedAt: p.updatedAt,
    }))
    .sort(
      (a, b) =>
        (a.connectionName ?? "").localeCompare(b.connectionName ?? "") ||
        (a.countryCode ?? "").localeCompare(b.countryCode ?? ""),
    );
}

/** Forgets one remembered courier: the next shipment without one from there waits for a person again. Audited. */
export async function deleteNoCarrierRule(actor: ScopedActor, rawKey: string) {
  assertCan(actor.role, "stores.manage");
  const key = z.string().min(1).max(300).startsWith(NOCARRIER_PREFIX).parse(rawKey);
  const before = await withAccountTransaction(actor.accountId, async (tx) => {
    const where = { accountId_carrierKey: { accountId: actor.accountId, carrierKey: key } };
    const row = await tx.shopifyCarrierAlias.findUnique({ where, select: { company: true } });
    if (!row) return null;
    const gone = await tx.shopifyCarrierAlias.deleteMany({
      where: { accountId: actor.accountId, carrierKey: key },
    });
    return gone.count === 1 ? row : null;
  });
  if (!before) return { deleted: false };
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "carrier.nocarrier_rule_deleted",
    entityType: "ShopifyCarrierAlias",
    entityId: key,
    before: { company: before.company },
    after: null,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { deleted: true };
}
