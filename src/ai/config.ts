/**
 * AI configuration (SPEC §7). Everything comes from the environment; nothing here is a secret that is ever
 * returned to the browser (the UI only learns WHETHER a key is set).
 *
 *   ANTHROPIC_API_KEY   — unset = the AI reviewer is off and the UI says so (GATE P8-G1).
 *   AI_REVIEWER_MODEL   — model for orders with findings (default claude-sonnet-5-5).
 *   AI_CHEAP_MODEL      — model for clean, high-volume orders (default claude-haiku-5-5).
 *   AI_KILL_SWITCH=1    — global stop for every group (no review runs, no AI approval is accepted).
 *   VOYAGE_API_KEY      — optional Voyage AI embeddings; unset = the local feature-hashing provider.
 *   VOYAGE_MODEL        — default voyage-3.5 (1024 dimensions).
 */

const MODEL_ID = /^claude-[a-z0-9.-]{3,60}$/;

function model(envName: string, fallback: string) {
  const v = process.env[envName]?.trim();
  return v && MODEL_ID.test(v) ? v : fallback;
}

export const DEFAULT_REVIEWER_MODEL = "claude-sonnet-5-5";
export const DEFAULT_CHEAP_MODEL = "claude-haiku-5-5";

export function aiModels() {
  return {
    reviewer: model("AI_REVIEWER_MODEL", DEFAULT_REVIEWER_MODEL),
    cheap: model("AI_CHEAP_MODEL", DEFAULT_CHEAP_MODEL),
  };
}

export type AiOffReason = "no_api_key" | "global_kill_switch";

/** Is the AI reviewer usable at all in this deployment (before any per-group switch or policy)? */
export function aiStatus(): { enabled: boolean; reason: AiOffReason | null } {
  if (process.env.AI_KILL_SWITCH === "1") return { enabled: false, reason: "global_kill_switch" };
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return { enabled: false, reason: "no_api_key" };
  return { enabled: true, reason: null };
}

export const globalKillSwitch = () => process.env.AI_KILL_SWITCH === "1";
