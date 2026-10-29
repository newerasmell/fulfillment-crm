import { describe, expect, it } from "vitest";
import { evaluateGate, isRaise, type GateInput } from "./gate";

const base: GateInput = {
  mode: "LIVE",
  connectionEnabled: true,
  accountPaused: false,
  globalPaused: false,
  confirmed: false,
  canarySentToday: 0,
  canaryDailyCap: 10,
  supportsTestMode: false,
  queuedBeforeKillSwitch: false,
};

describe("liveMode gate", () => {
  it("READ_ONLY refuses every write", () => {
    expect(evaluateGate({ ...base, mode: "READ_ONLY", confirmed: true })).toEqual({
      action: "refuse",
      reason: "read_only",
    });
  });
  it("DRY_RUN records, or uses the vendor test mode when there is one", () => {
    expect(evaluateGate({ ...base, mode: "DRY_RUN" })).toEqual({ action: "record_dry_run" });
    expect(evaluateGate({ ...base, mode: "DRY_RUN", supportsTestMode: true })).toEqual({
      action: "send_test_mode",
    });
  });
  it("CANARY needs a confirmation and respects the daily cap", () => {
    expect(evaluateGate({ ...base, mode: "CANARY" })).toEqual({
      action: "await_confirmation",
      reason: "needs_confirmation",
    });
    expect(evaluateGate({ ...base, mode: "CANARY", confirmed: true })).toEqual({ action: "send" });
    expect(evaluateGate({ ...base, mode: "CANARY", confirmed: true, canarySentToday: 10 })).toEqual({
      action: "await_confirmation",
      reason: "daily_cap_reached",
    });
  });
  it("LIVE sends", () => {
    expect(evaluateGate(base)).toEqual({ action: "send" });
  });
  it("kill switches win over every mode", () => {
    for (const mode of ["READ_ONLY", "DRY_RUN", "CANARY", "LIVE"] as const) {
      expect(evaluateGate({ ...base, mode, accountPaused: true }).action).toBe("pause");
      expect(evaluateGate({ ...base, mode, globalPaused: true })).toEqual({
        action: "pause",
        reason: "global_paused",
      });
    }
  });
  it("READ_ONLY after a kill switch holds requests queued before it instead of refusing them", () => {
    expect(evaluateGate({ ...base, mode: "READ_ONLY", queuedBeforeKillSwitch: true })).toEqual({
      action: "pause",
      reason: "kill_switch_hold",
    });
  });
  it("a disabled connection refuses", () => {
    expect(evaluateGate({ ...base, connectionEnabled: false })).toEqual({
      action: "refuse",
      reason: "connection_disabled",
    });
  });
  it("knows which changes raise the mode", () => {
    expect(isRaise("READ_ONLY", "DRY_RUN")).toBe(true);
    expect(isRaise("LIVE", "CANARY")).toBe(false);
    expect(isRaise("CANARY", "CANARY")).toBe(false);
  });
});
