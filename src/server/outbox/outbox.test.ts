import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveMode } from "@/generated/prisma/client";
import type { Actor } from "@/server/accounts";
import { ForbiddenError } from "@/server/auth/rbac";
import { systemDb } from "@/server/db/client";
import {
  confirmCanary,
  countHeldRequests,
  releaseHeldRequests,
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
    for (const id of ids) expect(await processOutbound(id, resolve)).toBe("AWAITING_CONFIRMATION");
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

  it("kill switch: connections to READ_ONLY, queue paused, waiting requests HELD (nothing dropped)", async () => {
    const { enqueue, owner, connection } = await setup("LIVE");
    const { transport, resolve } = fakeTransport();
    const { request } = await enqueue("ks");
    await expect(killSwitch({ ...owner, role: "ADMIN" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await killSwitch(owner)).toEqual({ held: 1 });
    expect((await systemDb().outboundRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe(
      "HELD",
    );
    expect(await processOutbound(request.id, resolve)).toBe("skipped");
    expect(
      (await systemDb().fulfillmentConnection.findUniqueOrThrow({ where: { id: connection.id } })).liveMode,
    ).toBe("READ_ONLY");
    // resume + raising the mode alone does NOT send held requests: only an explicit release does
    await resumeOutbox(owner);
    await setConnectionMode(owner, connection.id, "LIVE");
    expect((await sweepOutbox()).map((d) => d.id)).not.toContain(request.id);
    expect(await countHeldRequests(owner.accountId)).toBe(1);
    await expect(releaseHeldRequests({ ...owner, role: "ADMIN" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await releaseHeldRequests(owner)).toBe(1);
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

  it("CANARY cap holds for concurrent sends on different requests (in-flight calls count)", async () => {
    const { enqueue, owner } = await setup("CANARY", 1);
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const send = vi.fn(async () => {
      await blocked;
      return { outcome: "accepted" as const, response: {} };
    });
    const resolve = () => ({ send });
    const a = (await enqueue("cap-a")).request.id;
    const b = (await enqueue("cap-b")).request.id;
    for (const id of [a, b]) {
      await processOutbound(id, resolve);
      await confirmCanary(owner, id);
    }
    const first = processOutbound(a, resolve); // claims and blocks inside the vendor call
    await new Promise((r) => setTimeout(r, 100));
    const second = await processOutbound(b, resolve); // must see A in flight
    release();
    expect(await first).toBe("SENT");
    expect(second).toBe("AWAITING_CONFIRMATION");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("held requests released while still READ_ONLY are refused; CANARY confirmations do not survive a kill switch", async () => {
    const { enqueue, owner, connection } = await setup("CANARY");
    const { transport, resolve } = fakeTransport();
    const { request } = await enqueue("hold");
    await processOutbound(request.id, resolve);
    await confirmCanary(owner, request.id);
    await killSwitch(owner);
    const held = await systemDb().outboundRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(held).toMatchObject({ status: "HELD", confirmedAt: null });
    await resumeOutbox(owner);
    await setConnectionMode(owner, connection.id, "CANARY");
    await releaseHeldRequests(owner);
    expect(await processOutbound(request.id, resolve)).toBe("AWAITING_CONFIRMATION"); // needs a fresh click
    expect(transport.send).not.toHaveBeenCalled();
    // a request queued while READ_ONLY just before a kill switch is refused once released in READ_ONLY
    const { owner: o2, enqueue: enq2 } = await setup("READ_ONLY");
    const r2 = (await enq2("ro")).request;
    await killSwitch(o2);
    await resumeOutbox(o2);
    await releaseHeldRequests(o2);
    expect(await processOutbound(r2.id, resolve)).toBe("REFUSED");
  });

  it("kill switch while the worker is busy: no deadlock, no failure", async () => {
    const { enqueue, owner } = await setup("LIVE");
    const { resolve } = fakeTransport();
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push((await enqueue(`busy-${i}`)).request.id);
    const work = ids.map((id) => processOutbound(id, resolve));
    await Promise.all([killSwitch(owner), killSwitch(owner), resumeOutbox(owner), ...work]);
    const statuses = await systemDb().outboundRequest.groupBy({
      by: ["status"],
      where: { id: { in: ids } },
      _count: true,
    });
    expect(statuses.every((g) => ["SENT", "HELD", "PAUSED"].includes(g.status))).toBe(true);
  });

  it("parked rows of one account never crowd out new work of another (sweep starvation)", async () => {
    const { enqueue: blocked } = await setup("LIVE");
    const { account: other, enqueue: fresh } = await setup("LIVE");
    process.env.OUTBOX_PAUSED = "1";
    for (let i = 0; i < 5; i++)
      await processOutbound((await blocked(`park-${i}`)).request.id, fakeTransport().resolve);
    delete process.env.OUTBOX_PAUSED;
    const newOne = (await fresh("new-work")).request;
    const picked = await sweepOutbox(new Date(), 1000, 2); // re-picks have their own small budget
    expect(picked.map((d) => d.id)).toContain(newOne.id);
    expect(picked.find((d) => d.id === newOne.id)?.accountId).toBe(other.id);
  });

  it("global pause: held rows are picked up again once the pause is lifted", async () => {
    const { enqueue } = await setup("LIVE");
    process.env.OUTBOX_PAUSED = "1";
    const { request } = await enqueue("gp2");
    expect(await processOutbound(request.id, fakeTransport().resolve)).toBe("PAUSED");
    expect((await sweepOutbox()).map((d) => d.id)).not.toContain(request.id);
    delete process.env.OUTBOX_PAUSED;
    expect((await sweepOutbox()).map((d) => d.id)).toContain(request.id);
    expect(await processOutbound(request.id, fakeTransport().resolve)).toBe("SENT");
  });

  it("a confirmed request parked by the daily cap is re-picked by the sweep the next UTC day", async () => {
    const { enqueue, owner } = await setup("CANARY", 1);
    const { resolve } = fakeTransport();
    const a = (await enqueue("sw-a")).request.id;
    const b = (await enqueue("sw-b")).request.id;
    for (const id of [a, b]) {
      await processOutbound(id, resolve);
      await confirmCanary(owner, id);
    }
    expect(await processOutbound(a, resolve)).toBe("SENT");
    expect(await processOutbound(b, resolve)).toBe("AWAITING_CONFIRMATION");
    expect((await sweepOutbox()).map((d) => d.id)).not.toContain(b); // nothing can change today
    const tomorrow = new Date(Date.now() + 24 * 3600_000);
    expect((await sweepOutbox(tomorrow)).map((d) => d.id)).toContain(b);
  });

  it("concurrent enqueues of the same key are idempotent", async () => {
    const { enqueue } = await setup("LIVE");
    const results = await Promise.all([enqueue("same"), enqueue("same"), enqueue("same")]);
    expect(new Set(results.map((r) => r.request.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it("CANARY confirmation only for requests awaiting it on a CANARY connection", async () => {
    const { enqueue, owner } = await setup("LIVE");
    const { request } = await enqueue("not-canary");
    await expect(confirmCanary(owner, request.id)).rejects.toMatchObject({ code: "not_confirmable" });
  });

  it("a late vendor result does not overwrite an UNCERTAIN decision", async () => {
    const { enqueue } = await setup("LIVE");
    const { request } = await enqueue("late");
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const send = vi.fn(async () => {
      await blocked;
      return { outcome: "accepted" as const, response: {} };
    });
    const p = processOutbound(request.id, () => ({ send }));
    await new Promise((r) => setTimeout(r, 100));
    await sweepOutbox(new Date(Date.now() + STALE_SENDING_MS + 1000)); // declares it UNCERTAIN
    release();
    expect(await p).toBe("UNCERTAIN");
    const late = await systemDb().auditLog.findFirst({
      where: { entityId: request.id, action: "outbox.late_result" },
    });
    expect(late?.after).toMatchObject({ wouldBe: "SENT" });
  });

  it("re-arming a failed request resets its attempts", async () => {
    const { enqueue } = await setup("LIVE");
    const send = vi.fn(async () => ({ outcome: "rejected" as const, response: {}, error: "bad" }));
    const { request } = await enqueue("reset");
    await processOutbound(request.id, () => ({ send }));
    const rearmed = await enqueue("reset");
    expect(rearmed.request).toMatchObject({ status: "PENDING", attempts: 0, evaluatedMode: null });
  });
});
