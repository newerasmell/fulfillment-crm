import { z } from "zod";
import { AI_FIXABLE_FIELDS } from "./fields";

/**
 * The reviewer's strict JSON output (SPEC §7.2), delivered as the input of ONE tool call. `strict: true` makes
 * the API validate the tool input against this schema; Zod validates it again here (confidence range, sizes),
 * so a malformed answer is logged as invalid_output and never becomes a suggestion.
 */

export const AI_DECISIONS = ["APPROVE", "EDIT_AND_APPROVE", "HOLD", "CANCEL"] as const;
export type AiDecision = (typeof AI_DECISIONS)[number];

export const AI_FLAGS = [
  "address_unclear",
  "phone_unclear",
  "possible_duplicate",
  "customer_history_risk",
  "fraud_risk",
  "cod_amount_question",
  "recipient_question",
  "stock_question",
  "other",
] as const;

export const REVIEW_TOOL_NAME = "submit_review";

export const REVIEW_TOOL = {
  name: REVIEW_TOOL_NAME,
  description:
    "Submit your review of the order. Call this exactly once with your decision, confidence (0 to 1), the " +
    "field fixes you propose (only the listed fields), flags for a human, and a short explanation in Bulgarian.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["decision", "confidence", "fixes", "flags", "explanation_bg"],
    properties: {
      decision: { type: "string", enum: [...AI_DECISIONS] },
      confidence: { type: "number", description: "0 = pure guess, 1 = certain." },
      fixes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["field", "from", "to", "reason"],
          properties: {
            field: { type: "string", enum: [...AI_FIXABLE_FIELDS] },
            from: { anyOf: [{ type: "string" }, { type: "null" }] },
            to: { type: "string" },
            reason: { type: "string" },
          },
        },
      },
      flags: { type: "array", items: { type: "string", enum: [...AI_FLAGS] } },
      explanation_bg: { type: "string" },
    },
  },
} as const;

export const ReviewOutput = z.object({
  decision: z.enum(AI_DECISIONS),
  confidence: z.number().min(0).max(1),
  fixes: z
    .array(
      z.object({
        // Checked against AI_FIXABLE_FIELDS by the guardrails (a disallowed field is dropped and noted, not fatal).
        field: z.string().max(80),
        from: z.string().max(300).nullable(),
        to: z.string().trim().min(1).max(300),
        reason: z.string().max(500),
      }),
    )
    .max(10),
  flags: z.array(z.enum(AI_FLAGS)).max(10),
  explanation_bg: z.string().trim().min(1).max(2000),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;
