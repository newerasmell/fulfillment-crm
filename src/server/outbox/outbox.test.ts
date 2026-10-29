import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveMode } from "@/generated/prisma/client";
import type { Actor } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { systemDb } from "@/server/db/client";
import {
  confirmCanary,
  enqueueOutbound,
  killSwitch,
  processOutbound,
  resumeOutbox,
  setConnectionMode,
  STALE_SENDING_MS,
  sweepOutbox,
} from "./outbox";
import type { OutboundTransport } from "./transport";

let seq = 0;
async function setup(mode: LiveMode, cap = 10) {
  const sys = systemDb();
  const account = await sys.account.create({ data: { name: `Outbox ${++seq}` } });
  const connection = await sys.fulfillmentConnection.create({
    data: { accountId: account.id, type: "FHB_V3", name: "FHB", liveMode: mode, canaryDailyCap: cap },
  });
  const owner: Actor = { userId: "u-owner", accountId: account.id, role: "OWNER" };
  const enqueue = (key: string) =>
    enqueueOutbound({
      accountId: account.id,
      connectionId: connection.id,
      operation: "order.create",
      idempotencyKey: key,
      payload: { id: key },
    });
  return { account, connection, owner, enqueue };
}

function fakeTransport(overrides: Partial<OutboundTransport> = {}) {
  const t = {
    send: vi.fn(async () => ({ outcome: "accepted" as const, response: { ok: true } })),
    ...overrides,
  };
  return { transport: t as OutboundTransport, resolve: () => t as OutboundTransport };
}

describe("outbox sender + liveMode gate", () => {
  beforeEach(() => {
    delete process.env.OUTBOX_PAUSED;
  });

  it("READ_ONLY: writes are refused and nothing is sent", async () => {
    const { enqueue } = await setup("READ_ONLY");
    const { request } = await enqueue("r1");
    const { transport, resolve } = fakeTransport();
    expect(await processOutbound(request.id, resolve)).toBe("REFUSED");
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("DRY_RUN: recorded, not sent; with a vendor test mode it is validated only", async () => {
    const { enqueue } = await setup("DRY_RUN");
    const { transport, resolve } = fakeTransport();
    const a = (await enqueue("d1")).request;
    expect(await processOutbound(a.id, resolve)).toBe("DRY_RUN_RECORDED");
    expect(transport.send).not.toHaveBeenCalled();

    const testMode = fakeTransport({ supportsTestMode: () => true });
    const b = (await enqueue("d2")).request;
    expect(await processOutbound(b.id, testMode.resolve)).toBe("DRY_RUN_RECORDED");
    expect(testMode.transport.send).toHaveBeenCalledWith(expect.objectContaining({ testMode: true }));
  });

  it("CANARY: needs a confirmation per request and stops at the daily cap", async () => {
    const { enqueue, owner } = await setup("CANARY", 2);
    const { transport, resolve } = fakeTransport();
    const ids = [];
    for (const k of ["c1", "c2", "c3"]) ids.push((await enqueue(k)).request.id);
    expect(await processOutbound(ids[0]!, resolve)).toBe("AWAITING_CONFIRMATION");
    expect(transport.send).not.toHaveBeenCalled();

    await expect(confirmCanary({ ...owner, role: "VIEWER" }, ids[0]!)).rejects.toBeInstanceOf(ForbiddenError);
    for (const id of ids) await confirmCanary({ ...owner, role: "OPERATOR" }, id);
    expect(await processOutbound(ids[0]!, resolve)).toBe("SENT");
    expect(await processOutbound(ids[1]!, resolve)).toBe("SENT");
    expect(await processOutbound(ids[2]!, resolve)).toBe("AWAITING_CONFIRMATION"); // cap 2 reached
    const third = await systemDb().outboundRequest.findUniqueOrThrow({ where: { id: ids[2]! } });
    expect(third.lastError).toBe("daily_cap_reached");
    expect(transport.send).toHaveBeenCalledTimes(2);
    // next UTC day the confirmed request goes out
    const tomorrow = new Date(Date.now() + 24 * 3600_000);
    expect(await processOutbound(ids[2]!, resolve, tomorrow)).toBe("SENT");
  });

  it("LIVE: sends once; enqueueing the same key again never creates a second shipment", async () => {
    const { enqueue } = await setup("LIVE");
    const { transport, resolve } = fakeTransport();
    const first = await enqueue("L1");
    const again = await enqueue("L1");
    expect(again.created).toBe(false);
    expect(again.request.id).toBe(first.request.id);
    expect(await processOutbound(first.request.id, resolve)).toBe("SENT");
    expect(await processOutbound(first.request.id, resolve)).toBe("skipped");
    const afterSent = await enqueue("L1");
    expect(afterSent.created).toBe(false);
    expect(transport.send).toHaveBeenCalledTimes(1);
    const audit = await systemDb().auditLog.findFirst({
      where: { entityId: first.request.id, action: "outbox.sent" },
    });
    expect(audit?.after).toMatchObject({ mode: "LIVE", operation: "order.create" });
  });

  it("concurrent senders: the row lock lets exactly one call through", async () => {
    const { enqueue } = await setup("LIVE");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { transport, resolve } = fakeTransport({
      send: vi.fn(async () => {
        await gate;
        return { outcome: "accepted" as const, response: {} };
      }),
    });
    const { request } = await enqueue("race");
    const p1 = processOutbound(request.id, resolve);
    await new Promise((r) => setTimeout(r, 50));
    const second = await processOutbound(request.id, resolve); // SENDING by now → skipped
    release();
    expect(await p1).toBe("SENT");
    expect(second).toBe("skipped");
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("duplicate-submit: vendor accepted but we timed out → read-back finds it → SENT, no second send", async () => {
    const { enqueue } = await setup("LIVE");
    const send = vi.fn(async () => {
      throw new Error("timeout after vendor accepted");
    });
    const readBack = vi.fn(async () => ({ found: true, response: { vendorId: "V1" } }));
    const { request } = await enqueue("dup");
    expect(await processOutbound(request.id, () => ({ send, readBack }))).toBe("SENT");
    expect(send).toHaveBeenCalledTimes(1);
    expect(readBack).toHaveBeenCalledTimes(1);
    const row = await systemDb().outboundRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.lastResponse).toEqual({ vendorId: "V1" });
  });

  it("unknown outcome, read-back says not created → retried later with backoff", async () => {
    const { enqueue } = await setup("LIVE");
    let calls = 0;
    const send = vi.fn(async () => {
      if (++calls === 1) throw new Error("502");
      return { outcome: "accepted" as const, response: {} };
    });
    const readBack = vi.fn(async () => ({ found: false }));
    const { request } = await enqueue("retry");
    const now = new Date();
    expect(await processOutbound(request.id, () => ({ send, readBack }), now)).toBe("PENDING");
    expect(await processOutbound(request.id, () => ({ send, readBack }), now)).toBe("skipped"); // backoff
    expect(
      await processOutbound(request.id, () => ({ send, readBack }), new Date(now.getTime() + 60 * 60_000)),
    ).toBe("SENT");
  });

  it("unknown outcome without read-back → UNCERTAIN + operator task, never retried automatically", async () => {
    const { enqueue, account } = await setup("LIVE");
    const send = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const { request } = await enqueue("unc");
    expect(await processOutbound(request.id, () => ({ send }))).toBe("UNCERTAIN");
    expect(await processOutbound(request.id, () => ({ send }))).toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1);
    const task = await systemDb().alert.findFirst({ where: { accountId: account.id, entityId: request.id } });
    expect(task).toMatchObject({ isTask: true, kind: "outbox_uncertain", severity: "CRITICAL" });
    expect(await enqueue("unc")).toMatchObject({ created: false }); // cannot be re-armed either
    expect((await sweepOutbox()).map((d) => d.id)).not.toContain(request.id);
  });

  it("vendor rejection → FAILED; a corrected payload can be queued again under the same key", async () => {
    const { enqueue } = await setup("LIVE");
    const send = vi.fn(async () => ({
      outcome: "rejected" as const,
      response: { error: "bad zip" },
      error: "bad zip",
    }));
    const { request } = await enqueue("rej");
    expect(await processOutbound(request.id, () => ({ send }))).toBe("FAILED");
    const rearmed = await enqueue("rej");
    expect(rearmed).toMatchObject({ created: true });
    expect(rearmed.request.status).toBe("PENDING");
  });

  it("kill switch: all connections to READ_ONLY, queue paused, nothing dropped", async () => {
    const { enqueue, owner, connection } = await setup("LIVE");
    const { transport, resolve } = fakeTransport();
    const { request } = await enqueue("ks");
    await expect(killSwitch({ ...owner, role: "ADMIN" })).rejects.toBeInstanceOf(ForbiddenError);
    await killSwitch(owner);
    expect(await processOutbound(request.id, resolve)).toBe("PAUSED");
    expect(
      (await systemDb().fulfillmentConnection.findUniqueOrThrow({ where: { id: connection.id } })).liveMode,
    ).toBe("READ_ONLY");
    await setConnectionMode(owner, connection.id, "LIVE");
    await resumeOutbox(owner);
    expect((await sweepOutbox()).map((d) => d.id)).toContain(request.id);
    expect(await processOutbound(request.id, resolve)).toBe("SENT");
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("global pause (OUTBOX_PAUSED=1) holds everything", async () => {
    const { enqueue } = await setup("LIVE");
    process.env.OUTBOX_PAUSED = "1";
    const { request } = await enqueue("gp");
    expect(await processOutbound(request.id, fakeTransport().resolve)).toBe("PAUSED");
  });

  it("only an OWNER can raise a mode; admins can lower it; both are audited", async () => {
    const { owner, connection } = await setup("DRY_RUN");
    const admin = { ...owner, role: "ADMIN" as const };
    await expect(setConnectionMode(admin, connection.id, "LIVE")).rejects.toBeInstanceOf(ForbiddenError);
    await setConnectionMode(admin, connection.id, "READ_ONLY");
    await setConnectionMode(owner, connection.id, "CANARY");
    const logs = await systemDb().auditLog.findMany({
      where: { entityId: connection.id, action: "connection.mode_change" },
    });
    expect(logs.map((l) => l.after)).toEqual([{ liveMode: "READ_ONLY" }, { liveMode: "CANARY" }]);
  });

  it("a crashed send (stale SENDING) becomes UNCERTAIN on the next sweep", async () => {
    const { enqueue } = await setup("LIVE");
    const { request } = await enqueue("crash");
    await systemDb().outboundRequest.update({
      where: { id: request.id },
      data: { status: "SENDING", lockedAt: new Date(Date.now() - STALE_SENDING_MS - 1000) },
    });
    await sweepOutbox();
    expect((await systemDb().outboundRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe(
      "UNCERTAIN",
    );
  });
});
