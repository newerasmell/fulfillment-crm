import type { EditableField } from "@/server/review/diff";

/**
 * Guardrails on what the AI may suggest changing (SPEC §7.5): never the recipient's identity (name, country,
 * e-mail), never COD or amounts. Only these address fields and the phone may appear in AI fixes.
 */
export const AI_FIXABLE_FIELDS = [
  "shippingAddress.company",
  "shippingAddress.address1",
  "shippingAddress.address2",
  "shippingAddress.city",
  "shippingAddress.zip",
  "shippingAddress.province",
  "phone",
] as const satisfies readonly EditableField[];
export type AiFixableField = (typeof AI_FIXABLE_FIELDS)[number];
export const isAiFixable = (f: string): f is AiFixableField =>
  (AI_FIXABLE_FIELDS as readonly string[]).includes(f);

/** Values of these fields are masked before they are shown to a model as someone else's past case. */
const PERSONAL = new Set([
  "phone",
  "shippingAddress.name",
  "shippingAddress.address1",
  "shippingAddress.address2",
]);

/** "06301234567" → "0630•••••67": keeps the start (prefix pattern) and the last two characters. */
export function maskValue(field: string, v: string | null): string | null {
  if (v == null || !PERSONAL.has(field)) return v;
  const s = v.trim();
  if (s.length <= 6) return "•".repeat(s.length);
  return `${s.slice(0, 4)}${"•".repeat(Math.max(s.length - 6, 1))}${s.slice(-2)}`;
}
