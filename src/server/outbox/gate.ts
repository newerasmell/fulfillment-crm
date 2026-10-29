import type { LiveMode } from "@/generated/prisma/client";

/**
 * The liveMode gate (INTEGRATION_NOTES §6). Pure: given the state at the moment the sender picks a request,
 * decide what may happen. Enforced in the outbox sender, never in the UI.
 */
export type GateDecision =
  | { action: "pause"; reason: "account_paused" | "global_paused" | "kill_switch_hold" }
  | { action: "refuse"; reason: "read_only" | "connection_disabled" }
  | { action: "record_dry_run" }
  | { action: "send_test_mode" } // DRY_RUN where the vendor validates without persisting (euShipments testMode)
  | { action: "await_confirmation"; reason: "needs_confirmation" | "daily_cap_reached" }
  | { action: "send" };

export interface GateInput {
  mode: LiveMode;
  connectionEnabled: boolean;
  accountPaused: boolean;
  globalPaused: boolean;
  /** CANARY: an operator confirmed this exact request. */
  confirmed: boolean;
  /** CANARY: requests already sent today on this connection. */
  canarySentToday: number;
  canaryDailyCap: number;
  /** The operation can be sent to the vendor in a validate-only test mode. */
  supportsTestMode: boolean;
  /**
   * The request was queued before the account's last kill switch. While its connection is READ_ONLY it is
   * held (stays queued) instead of refused, so a kill switch never drops queued work.
   */
  queuedBeforeKillSwitch: boolean;
}

export function evaluateGate(i: GateInput): GateDecision {
  if (i.globalPaused) return { action: "pause", reason: "global_paused" };
  if (i.accountPaused) return { action: "pause", reason: "account_paused" };
  if (!i.connectionEnabled) return { action: "refuse", reason: "connection_disabled" };
  switch (i.mode) {
    case "READ_ONLY":
      return i.queuedBeforeKillSwitch
        ? { action: "pause", reason: "kill_switch_hold" }
        : { action: "refuse", reason: "read_only" };
    case "DRY_RUN":
      return i.supportsTestMode ? { action: "send_test_mode" } : { action: "record_dry_run" };
    case "CANARY":
      if (!i.confirmed) return { action: "await_confirmation", reason: "needs_confirmation" };
      if (i.canarySentToday >= i.canaryDailyCap)
        return { action: "await_confirmation", reason: "daily_cap_reached" };
      return { action: "send" };
    case "LIVE":
      return { action: "send" };
  }
}

const RANK: Record<LiveMode, number> = { READ_ONLY: 0, DRY_RUN: 1, CANARY: 2, LIVE: 3 };
export const isRaise = (from: LiveMode, to: LiveMode) => RANK[to] > RANK[from];
