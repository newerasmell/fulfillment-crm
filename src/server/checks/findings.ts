import type { Finding as EuFinding } from "@/integrations/eushipments/validators";
import type { ValidationFinding as FhbFinding } from "@/integrations/fhb-v3/validators";

/**
 * The one finding shape of the validator engine (P4-01, INTEGRATION_NOTES §5, SPEC §7). Vendor validators keep
 * their own shapes; they are mapped here. `hard` blocks approval and sending; `soft` must be seen by a person
 * (an order with any finding goes to NEEDS_REVIEW, a clean one to READY).
 */
export type FindingSeverity = "hard" | "soft";
export type FindingSource = "order" | "routing" | "stock" | "fhb" | "eushipments";

export interface Finding {
  /** Namespaced: order.*, routing.*, stock.*, fhb.*, eushipments.* */
  code: string;
  severity: FindingSeverity;
  source: FindingSource;
  /** Field to highlight (CRM path for order.*, vendor path for vendor findings); null = the whole order. */
  field: string | null;
  message_bg: string;
  message_en: string;
  /** A concrete correction an operator (or later the AI) can apply with one click. */
  suggestedFix?: { field: string; value: string };
}

export const hasHard = (fs: readonly Finding[]) => fs.some((f) => f.severity === "hard");
export const countBy = (fs: readonly Finding[]) => ({
  hardCount: fs.filter((f) => f.severity === "hard").length,
  softCount: fs.filter((f) => f.severity === "soft").length,
});

export function fromFhb(f: FhbFinding): Finding {
  return {
    code: f.code,
    severity: f.severity,
    source: "fhb",
    field: f.field,
    message_bg: f.message_bg,
    message_en: f.message_en,
    ...(f.suggestedFix ? { suggestedFix: f.suggestedFix } : {}),
  };
}

export function fromEu(f: EuFinding): Finding {
  return {
    code: `eushipments.${f.code}`,
    severity: f.severity === "block" ? "hard" : "soft",
    source: "eushipments",
    field: f.field,
    message_bg: f.message_bg,
    message_en: f.message_en,
    ...(f.suggestedFix ? { suggestedFix: { field: f.field, value: f.suggestedFix } } : {}),
  };
}

/** Hard first, then by source and code — a stable order for the UI and for comparing two checks. */
export function sortFindings(fs: Finding[]): Finding[] {
  const rank: Record<FindingSource, number> = { order: 0, routing: 1, stock: 2, fhb: 3, eushipments: 3 };
  return [...fs].sort(
    (a, b) =>
      Number(b.severity === "hard") - Number(a.severity === "hard") ||
      rank[a.source] - rank[b.source] ||
      a.code.localeCompare(b.code) ||
      (a.field ?? "").localeCompare(b.field ?? ""),
  );
}
