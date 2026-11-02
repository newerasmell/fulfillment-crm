import { z } from "zod";
import type { ConnectionType, PaymentMethod } from "@/generated/prisma/client";

/**
 * Routing rules engine (P4-02, SPEC §3 RoutingRule, §6.1 CHECKING). Pure: callers load the order, the rules,
 * the connections and the stock (./route.ts does). Rules are evaluated in order (priority ascending), the
 * first rule whose conditions match wins; a rule with `requireStock` is skipped when its warehouse cannot
 * ship every line, and when no rule wins the stock fallback picks a warehouse that can (own company first).
 * Shipping from another company's warehouse is allowed and only recorded in the CRM (SPEC §3).
 * Every decision carries a human-readable explanation, e.g. "Правило 3: BG + COD → FHB Kika; наличност OK".
 */

const Iso2 = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/);
const Tag = z.string().trim().min(1).max(100);

/** Stored in RoutingRule.match. Every condition is optional; an empty match matches every order. */
export const RuleMatch = z
  .object({
    storeIds: z.array(z.string().min(1).max(64)).max(50).optional(),
    countries: z.array(Iso2).max(60).optional(),
    payment: z.enum(["COD", "PREPAID"]).optional(),
    /** The order carries at least one of these tags (case-insensitive). */
    tags: z.array(Tag).max(20).optional(),
    /** The order carries none of these tags. */
    excludeTags: z.array(Tag).max(20).optional(),
    /** At least one line is one of these products (product set). */
    productIds: z.array(z.string().min(1).max(64)).max(200).optional(),
    /** Skip this rule when its warehouse cannot ship every line from stock. */
    requireStock: z.boolean().optional(),
  })
  .strict();
export type RuleMatch = z.infer<typeof RuleMatch>;

export interface RoutingOrder {
  companyId: string | null;
  /** Product line of the selling company (P5-00); null/absent = no line. */
  lineId?: string | null;
  storeId: string | null;
  countryCode: string | null;
  paymentMethod: PaymentMethod;
  tags: string[];
  lines: { productId: string | null; quantity: number; title: string }[];
}

export interface RoutingConnection {
  id: string;
  name: string;
  type: ConnectionType;
  companyId: string | null;
  /** Product line of the connection's company (P5-00); null/absent = no line. */
  lineId?: string | null;
  enabled: boolean;
}

export interface RoutingRuleRow {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  match: unknown;
  connectionId: string;
  parcelService: string | null;
  courierId: string | null;
  serviceName: string | null;
  deliveryPointPolicy: string | null;
}

export type StockStatus = "ok" | "insufficient" | "unknown";

export interface StockCheck {
  status: StockStatus;
  lines: { productId: string | null; title: string; need: number; available: number | null }[];
}

export type StepOutcome =
  "matched" | "no_match" | "no_stock" | "disabled" | "invalid" | "connection_disabled";

export interface RoutingStep {
  ruleId: string;
  number: number;
  name: string;
  outcome: StepOutcome;
  /** Condition that failed (no_match), e.g. "country". */
  failed?: string;
}

export interface RoutingDecision {
  connectionId: string | null;
  connectionName: string | null;
  connectionType: ConnectionType | null;
  via: "rule" | "stock_fallback" | "none";
  ruleId: string | null;
  /** 1-based position of the rule in the ordered list (what the admin page shows). */
  ruleNumber: number | null;
  ruleName: string | null;
  /** The warehouse belongs to another company of the group than the selling company. */
  crossCompany: boolean;
  carrier: {
    parcelService: string | null;
    courierId: string | null;
    serviceName: string | null;
    deliveryPointPolicy: string | null;
  } | null;
  stock: StockCheck | null;
  explanation: { bg: string; en: string };
  steps: RoutingStep[];
}

/** Connection types that hold stock (FHB Joy prints labels only, it is never a routing target). */
export const STOCK_CONNECTION_TYPES: readonly ConnectionType[] = ["FHB_V3", "EUSHIPMENTS"];

const lower = (xs: string[]) => new Set(xs.map((x) => x.trim().toLowerCase()));

/** First failing condition, or null when the order matches. */
export function failedCondition(m: RuleMatch, o: RoutingOrder): string | null {
  if (m.storeIds?.length && (!o.storeId || !m.storeIds.includes(o.storeId))) return "store";
  if (m.countries?.length && (!o.countryCode || !m.countries.includes(o.countryCode.toUpperCase())))
    return "country";
  if (m.payment && m.payment !== o.paymentMethod) return "payment";
  const tags = lower(o.tags);
  if (m.tags?.length && !m.tags.some((t) => tags.has(t.toLowerCase()))) return "tags";
  if (m.excludeTags?.length && m.excludeTags.some((t) => tags.has(t.toLowerCase()))) return "excludeTags";
  if (m.productIds?.length && !o.lines.some((l) => l.productId && m.productIds!.includes(l.productId)))
    return "products";
  return null;
}

/** "BG + COD", "магазин DM + #vip", "всички поръчки" — the rule's conditions in words. */
export function describeMatch(m: RuleMatch, storeCodes: ReadonlyMap<string, string>, lang: "bg" | "en") {
  const parts: string[] = [];
  if (m.storeIds?.length)
    parts.push(
      `${lang === "bg" ? "магазин" : "store"} ${m.storeIds.map((s) => storeCodes.get(s) ?? "?").join("/")}`,
    );
  if (m.countries?.length) parts.push(m.countries.join("/"));
  if (m.payment) parts.push(m.payment === "COD" ? "COD" : lang === "bg" ? "предплатена" : "prepaid");
  if (m.tags?.length) parts.push(m.tags.map((t) => `#${t}`).join("/"));
  if (m.excludeTags?.length)
    parts.push(m.excludeTags.map((t) => `${lang === "bg" ? "без" : "not"} #${t}`).join(" "));
  if (m.productIds?.length)
    parts.push(lang === "bg" ? `${m.productIds.length} продукт(а)` : `${m.productIds.length} product(s)`);
  if (!parts.length) return lang === "bg" ? "всички поръчки" : "all orders";
  return parts.join(" + ");
}

const STOCK_TEXT: Record<StockStatus, { bg: string; en: string }> = {
  ok: { bg: "наличност OK", en: "stock OK" },
  insufficient: { bg: "няма достатъчна наличност", en: "not enough stock" },
  unknown: { bg: "наличността не е известна", en: "stock unknown" },
};

/**
 * Stock of the order's lines at one warehouse. `available` maps CRM product id → sellable units there
 * (undefined = not mapped there / no snapshot). Quantities of the same product are summed.
 */
export function checkStock(lines: RoutingOrder["lines"], available: ReadonlyMap<string, number>): StockCheck {
  const need = new Map<string, { productId: string | null; title: string; need: number }>();
  lines
    .filter((l) => l.quantity > 0)
    .forEach((l, i) => {
      const key = l.productId ?? `unmatched:${i}`;
      const prev = need.get(key);
      need.set(key, {
        productId: l.productId,
        title: prev?.title ?? l.title,
        need: (prev?.need ?? 0) + l.quantity,
      });
    });
  const out: StockCheck["lines"] = [];
  let status: StockStatus = "ok";
  for (const n of need.values()) {
    const a = n.productId ? available.get(n.productId) : undefined;
    out.push({ ...n, available: a ?? null });
    if (a === undefined) {
      if (status === "ok") status = "unknown";
    } else if (a < n.need) status = "insufficient";
  }
  return { status, lines: out };
}

export interface EvaluateInput {
  order: RoutingOrder;
  /** All rules of the group; order does not matter (sorted here by priority). */
  rules: RoutingRuleRow[];
  connections: RoutingConnection[];
  /** Stock check per connection id (only connections of STOCK_CONNECTION_TYPES are needed). */
  stock: ReadonlyMap<string, StockCheck>;
  storeCodes: ReadonlyMap<string, string>;
}

export function evaluateRouting(input: EvaluateInput): RoutingDecision {
  const { order } = input;
  const byId = new Map(input.connections.map((c) => [c.id, c]));
  const sorted = [...input.rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const steps: RoutingStep[] = [];
  const decide = (
    c: RoutingConnection,
    via: "rule" | "stock_fallback",
    rule: { row: RoutingRuleRow; number: number; match: RuleMatch } | null,
  ): RoutingDecision => {
    const stock = input.stock.get(c.id) ?? null;
    const crossCompany = !!order.companyId && !!c.companyId && order.companyId !== c.companyId;
    const st = stock ? STOCK_TEXT[stock.status] : STOCK_TEXT.unknown;
    const cross = crossCompany
      ? {
          bg: "; склад на друга фирма (отчита се само в CRM)",
          en: "; another company's warehouse (recorded in the CRM only)",
        }
      : { bg: "", en: "" };
    const head = rule
      ? {
          bg: `Правило ${rule.number}: ${describeMatch(rule.match, input.storeCodes, "bg")}`,
          en: `Rule ${rule.number}: ${describeMatch(rule.match, input.storeCodes, "en")}`,
        }
      : { bg: "Без съвпадащо правило, по наличност", en: "No matching rule, by stock" };
    return {
      connectionId: c.id,
      connectionName: c.name,
      connectionType: c.type,
      via,
      ruleId: rule?.row.id ?? null,
      ruleNumber: rule?.number ?? null,
      ruleName: rule?.row.name ?? null,
      crossCompany,
      carrier: rule
        ? {
            parcelService: rule.row.parcelService,
            courierId: rule.row.courierId,
            serviceName: rule.row.serviceName,
            deliveryPointPolicy: rule.row.deliveryPointPolicy,
          }
        : null,
      stock,
      explanation: {
        bg: `${head.bg} → ${c.name}; ${st.bg}${cross.bg}`,
        en: `${head.en} → ${c.name}; ${st.en}${cross.en}`,
      },
      steps,
    };
  };

  for (const [i, row] of sorted.entries()) {
    const number = i + 1;
    const base = { ruleId: row.id, number, name: row.name };
    if (!row.enabled) {
      steps.push({ ...base, outcome: "disabled" });
      continue;
    }
    const parsed = RuleMatch.safeParse(row.match ?? {});
    if (!parsed.success) {
      steps.push({ ...base, outcome: "invalid" });
      continue;
    }
    const failed = failedCondition(parsed.data, order);
    if (failed) {
      steps.push({ ...base, outcome: "no_match", failed });
      continue;
    }
    const c = byId.get(row.connectionId);
    if (!c || !c.enabled || !STOCK_CONNECTION_TYPES.includes(c.type)) {
      steps.push({ ...base, outcome: "connection_disabled" });
      continue;
    }
    if (parsed.data.requireStock && input.stock.get(c.id)?.status !== "ok") {
      steps.push({ ...base, outcome: "no_stock" });
      continue;
    }
    steps.push({ ...base, outcome: "matched" });
    return decide(c, "rule", { row, number, match: parsed.data });
  }

  // Stock fallback: a warehouse that can ship every line; the selling company's own first, then by name.
  // Only warehouses of companies in the order's product line (P5-00): other lines sell other goods.
  const orderLine = order.lineId ?? null;
  const candidates = input.connections
    .filter(
      (c) =>
        c.enabled &&
        STOCK_CONNECTION_TYPES.includes(c.type) &&
        (c.lineId ?? null) === orderLine &&
        input.stock.get(c.id)?.status === "ok",
    )
    .sort(
      (a, b) =>
        Number(b.companyId === order.companyId) - Number(a.companyId === order.companyId) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
  if (candidates[0]) return decide(candidates[0], "stock_fallback", null);

  return {
    connectionId: null,
    connectionName: null,
    connectionType: null,
    via: "none",
    ruleId: null,
    ruleNumber: null,
    ruleName: null,
    crossCompany: false,
    carrier: null,
    stock: null,
    explanation: {
      bg: "Няма съвпадащо правило и няма склад с наличност за всички редове",
      en: "No matching rule and no warehouse with stock for every line",
    },
    steps,
  };
}
