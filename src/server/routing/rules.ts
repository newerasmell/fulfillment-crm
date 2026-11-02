import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb, withAccountTransaction } from "@/server/db/client";
import type { ScopedActor } from "@/server/stores";
import { RuleMatch, STOCK_CONNECTION_TYPES } from "./engine";

/**
 * Routing rules administration (Настройки → Правила за маршрут; OWNER/ADMIN, every change audited).
 * A member limited to some companies manages only rules whose warehouse and stores are inside that scope.
 */

const opt = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable()
    .optional();

export const RoutingRuleInput = z.object({
  name: z.string().trim().min(1).max(120),
  connectionId: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  match: RuleMatch.default({}),
  parcelService: opt(100),
  courierId: opt(50),
  serviceName: opt(100),
  deliveryPointPolicy: opt(100),
});
export type RoutingRuleInput = z.input<typeof RoutingRuleInput>;

const PRIORITY_STEP = 10;

const inScope = (actor: ScopedActor, companyId: string | null | undefined) =>
  !actor.companyScope || (!!companyId && actor.companyScope.includes(companyId));

const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? {})) as Prisma.InputJsonValue;

/** Clean match: empty lists dropped, so "no condition" is stored as absent (and shown as such). */
function cleanMatch(m: RuleMatch): RuleMatch {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (Array.isArray(v) ? v.length : v !== undefined && v !== false)
      out[k] = Array.isArray(v) ? [...new Set(v)] : v;
  }
  return out as RuleMatch;
}

async function checkReferences(actor: ScopedActor, input: z.output<typeof RoutingRuleInput>) {
  const db = accountDb(actor.accountId);
  const connection = await db.fulfillmentConnection.findUnique({
    where: { id: input.connectionId },
    select: { id: true, type: true, companyId: true },
  });
  if (!connection || !inScope(actor, connection.companyId)) throw new DomainError("not_found");
  if (!STOCK_CONNECTION_TYPES.includes(connection.type)) throw new DomainError("routing_connection_type");
  const storeIds = input.match.storeIds ?? [];
  if (storeIds.length) {
    const stores = await db.store.findMany({ where: { id: { in: storeIds } }, select: { companyId: true } });
    if (stores.length !== new Set(storeIds).size || stores.some((s) => !inScope(actor, s.companyId)))
      throw new DomainError("routing_unknown_store");
  }
  const productIds = input.match.productIds ?? [];
  if (productIds.length) {
    const n = await db.product.count({ where: { id: { in: productIds } } });
    if (n !== new Set(productIds).size) throw new DomainError("routing_unknown_product");
  }
}

/** Store ids a rule's stored match names (none = the rule matches every store). */
const ruleStoreIds = (match: unknown) => RuleMatch.safeParse(match ?? {}).data?.storeIds ?? [];

/**
 * Store → company for the account (one read, for scope checks on many rules). Only needed for restricted
 * actors; null otherwise.
 */
async function storeCompanies(actor: ScopedActor) {
  if (!actor.companyScope) return null;
  const stores = await accountDb(actor.accountId).store.findMany({ select: { id: true, companyId: true } });
  return new Map(stores.map((s) => [s.id, s.companyId]));
}

/**
 * A rule is in a restricted actor's scope when its warehouse AND every store it names belong to their
 * companies (a rule routing another company's store to their warehouse is not theirs to change).
 */
function ruleInScope(
  actor: ScopedActor,
  rule: { match: unknown; connection: { companyId: string | null } },
  stores: Map<string, string | null> | null,
) {
  if (!actor.companyScope) return true;
  if (!inScope(actor, rule.connection.companyId)) return false;
  return ruleStoreIds(rule.match).every((id) => inScope(actor, stores?.get(id) ?? null));
}

async function loadInScope(actor: ScopedActor, ruleId: string) {
  const rule = await accountDb(actor.accountId).routingRule.findUnique({
    where: { id: ruleId },
    include: { connection: { select: { companyId: true } } },
  });
  if (!rule || !ruleInScope(actor, rule, await storeCompanies(actor))) throw new DomainError("not_found");
  const { connection: _c, ...plain } = rule;
  return plain;
}

/** Rules in evaluation order with their 1-based number (the number the explanations use). */
export async function listRoutingRules(actor: ScopedActor) {
  assertCan(actor.role, "routing.manage");
  const rules = await accountDb(actor.accountId).routingRule.findMany({
    orderBy: [{ priority: "asc" }, { id: "asc" }],
    include: { connection: { select: { id: true, name: true, type: true, companyId: true, enabled: true } } },
  });
  const stores = await storeCompanies(actor);
  return rules
    .map((r, i) => ({ ...r, number: i + 1, matchParsed: RuleMatch.safeParse(r.match ?? {}).data ?? null }))
    .filter((r) => ruleInScope(actor, r, stores));
}

export async function createRoutingRule(actor: ScopedActor, raw: RoutingRuleInput) {
  assertCan(actor.role, "routing.manage");
  const input = RoutingRuleInput.parse(raw);
  input.match = cleanMatch(input.match);
  await checkReferences(actor, input);
  const db = accountDb(actor.accountId);
  const last = await db.routingRule.aggregate({ _max: { priority: true } });
  const rule = await db.routingRule.create({
    data: {
      accountId: actor.accountId,
      name: input.name,
      connectionId: input.connectionId,
      enabled: input.enabled,
      match: json(input.match),
      parcelService: input.parcelService ?? null,
      courierId: input.courierId ?? null,
      serviceName: input.serviceName ?? null,
      deliveryPointPolicy: input.deliveryPointPolicy ?? null,
      priority: (last._max.priority ?? 0) + PRIORITY_STEP,
    },
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "routing.rule_created",
    entityType: "RoutingRule",
    entityId: rule.id,
    after: rule,
  });
  return rule;
}

export async function updateRoutingRule(actor: ScopedActor, ruleId: string, raw: RoutingRuleInput) {
  assertCan(actor.role, "routing.manage");
  const before = await loadInScope(actor, ruleId);
  const input = RoutingRuleInput.parse(raw);
  input.match = cleanMatch(input.match);
  await checkReferences(actor, input);
  const rule = await accountDb(actor.accountId).routingRule.update({
    where: { id: ruleId },
    data: {
      name: input.name,
      connectionId: input.connectionId,
      enabled: input.enabled,
      match: json(input.match),
      parcelService: input.parcelService ?? null,
      courierId: input.courierId ?? null,
      serviceName: input.serviceName ?? null,
      deliveryPointPolicy: input.deliveryPointPolicy ?? null,
    },
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "routing.rule_updated",
    entityType: "RoutingRule",
    entityId: rule.id,
    before,
    after: rule,
  });
  return rule;
}

export async function deleteRoutingRule(actor: ScopedActor, ruleId: string) {
  assertCan(actor.role, "routing.manage");
  const before = await loadInScope(actor, ruleId);
  await accountDb(actor.accountId).routingRule.delete({ where: { id: ruleId } });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "routing.rule_deleted",
    entityType: "RoutingRule",
    entityId: ruleId,
    before,
  });
}

/**
 * Moves a rule one place up or down (swaps with its neighbour in the full list) and renumbers priorities
 * 10, 20, 30… so the order stays unambiguous. Serialised per group (advisory lock). A member limited to some
 * companies may only swap with a neighbour that is also in their scope: moving past another company's rule
 * would change which warehouse ships that company's orders (routing_out_of_scope).
 */
export async function moveRoutingRule(actor: ScopedActor, ruleId: string, direction: "up" | "down") {
  assertCan(actor.role, "routing.manage");
  await loadInScope(actor, ruleId);
  const result = await withAccountTransaction(actor.accountId, async (tx, { lockKey }) => {
    await lockKey("routing-rules");
    const rules = await tx.routingRule.findMany({
      orderBy: [{ priority: "asc" }, { id: "asc" }],
      select: { id: true, priority: true, match: true, connection: { select: { companyId: true } } },
    });
    const i = rules.findIndex((r) => r.id === ruleId);
    const j = direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= rules.length) return null;
    if (actor.companyScope) {
      const stores = await storeCompanies(actor);
      if (!ruleInScope(actor, rules[i]!, stores) || !ruleInScope(actor, rules[j]!, stores))
        throw new DomainError("routing_out_of_scope");
    }
    const order = rules.map((r) => r.id);
    [order[i], order[j]] = [order[j]!, order[i]!];
    for (const [k, id] of order.entries()) {
      const priority = (k + 1) * PRIORITY_STEP;
      if (rules.find((r) => r.id === id)!.priority !== priority)
        await tx.routingRule.update({ where: { id }, data: { priority } });
    }
    return { from: i + 1, to: j + 1 };
  });
  if (result) {
    await recordAudit({
      accountId: actor.accountId,
      userId: actor.userId,
      action: "routing.rule_moved",
      entityType: "RoutingRule",
      entityId: ruleId,
      before: { number: result.from },
      after: { number: result.to },
    });
  }
  return result;
}

/** Resolves SKUs typed in the admin form to CRM product ids (unknown SKU → routing_unknown_product). */
export async function productIdsForSkus(actor: ScopedActor, skus: string[]) {
  if (!skus.length) return [];
  const rows = await accountDb(actor.accountId).product.findMany({
    where: { sku: { in: skus } },
    select: { id: true, sku: true },
  });
  if (rows.length !== new Set(skus).size) throw new DomainError("routing_unknown_product");
  return rows.map((r) => r.id);
}
