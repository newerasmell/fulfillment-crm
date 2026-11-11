import { beforeAll, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/server/auth/rbac";
import { systemDb } from "@/server/db/client";
import { euTestGroup, euTestOrder } from "@/server/eushipments/test-fixtures";
import { processOutbound, sweepOutbox, STALE_SENDING_MS, WORKER_STOPPED } from "./outbox";
import {
  RECHECK_MIN_AGE_MS,
  RECHECKING,
  requestWarehouseRecheck,
  runWarehouseRecheck,
  uncertainCreatesOf,
} from "./recheck";
import type { OutboundTransport } from "./transport";

// "Провери в склада" (owner report 2026-11-11). Synthetic data, fake transports only (no vendor call).
describe("warehouse recheck of an interrupted create-order", () => {
  let g: Awaited<ReturnType<typeof euTestGroup>>;
  let n = 0;
  const db = () => systemDb();
  const old = () => new Date(Date.now() - RECHECK_MIN_AGE_MS - 60_000);

  beforeAll(async () => {
    g = await euTestGroup("recheck");
  });

  /** A create-order whose worker stopped inside the call: UNCERTAIN with its task (as the sweep leaves it). */
  async function interrupted(over: { lockedAt?: Date; evaluatedMode?: "LIVE" | "CANARY" | "DRY_RUN" } = {}) {
    const { order } = await euTestOrder(g, { number: `#RC-${++n}` });
    await db().order.update({ where: { id: order.id }, data: { status: "QUEUED" } });
    const f = await db().fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: order.id,
        connectionId: g.connection.id,
        externalId: `RC-${n}`,
        status: "QUEUED",
      },
    });
    const req = await db().outboundRequest.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        operation: "eushipments.createOrder",
        idempotencyKey: `rc-${n}-${Date.now()}`,
        payload: { body: { awb: { referenceNumber: `RC-${n}` } }, ctx: { fulfillmentId: f.id } },
        status: "SENDING",
        evaluatedMode: over.evaluatedMode ?? "LIVE",
        attempts: 1,
        fulfillmentId: f.id,
        lockedAt: new Date(Date.now() - STALE_SENDING_MS - 1000),
      },
    });
    await sweepOutbox(); // → UNCERTAIN + task
    await db().outboundRequest.update({
      where: { id: req.id },
      data: { lockedAt: over.lockedAt ?? old() },
    });
    return { order, f, req };
  }
  const reqOf = (id: string) => db().outboundRequest.findUniqueOrThrow({ where: { id } });
  const openTasks = (id: string) =>
    db().alert.count({ where: { entityId: id, kind: "outbox_uncertain", status: { not: "RESOLVED" } } });
  const transport = (readBack: OutboundTransport["readBack"]) => {
    const send = vi.fn(async () => ({ outcome: "accepted" as const, response: { orderId: "E-1" } }));
    const t = { send, readBack } as OutboundTransport;
    return { send, resolve: () => t };
  };

  it("found at the warehouse: SENT, the task resolved, nothing sent", async () => {
    const { req, order } = await interrupted();
    expect(await uncertainCreatesOf(g.owner, order.id)).toEqual([
      expect.objectContaining({ requestId: req.id, refusal: null }),
    ]);
    await expect(
      requestWarehouseRecheck({ ...g.owner, role: "OPERATOR" }, { requestId: req.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const job = await requestWarehouseRecheck(g.owner, { requestId: req.id });
    expect((await reqOf(req.id)).lastError).toBe(RECHECKING);
    // Pressed twice: the second is refused while the first runs.
    await expect(requestWarehouseRecheck(g.owner, { requestId: req.id })).rejects.toMatchObject({
      code: "recheck_checking",
    });
    const { send, resolve } = transport(async () => ({ found: true, response: { awb: "A1" } }));
    expect(await runWarehouseRecheck(job, resolve)).toBe("SENT");
    expect(await reqOf(req.id)).toMatchObject({ status: "SENT", lastResponse: { awb: "A1" } });
    expect(send).not.toHaveBeenCalled();
    expect(await openTasks(req.id)).toBe(0);
    // Done once: the job running again changes nothing.
    expect(await runWarehouseRecheck(job, resolve)).toBe("skipped");
  });

  it("not at the warehouse: PENDING through the gate (CANARY confirmation cleared); the task resolves once sent", async () => {
    const { req } = await interrupted();
    await db().outboundRequest.update({
      where: { id: req.id },
      data: { confirmedAt: new Date(), confirmedById: g.owner.userId },
    });
    const job = await requestWarehouseRecheck(g.owner, { requestId: req.id });
    const { send, resolve } = transport(async () => ({ found: false }));
    expect(await runWarehouseRecheck(job, resolve)).toBe("PENDING");
    expect(await reqOf(req.id)).toMatchObject({ status: "PENDING", confirmedAt: null, confirmedById: null });
    expect(await openTasks(req.id)).toBe(1); // not sent yet
    expect(send).not.toHaveBeenCalled();
    expect(await processOutbound(req.id, resolve)).toBe("SENT"); // LIVE connection
    expect(send).toHaveBeenCalledTimes(1);
    expect(await openTasks(req.id)).toBe(0);
  });

  it("the lookup fails: stays UNCERTAIN, can be asked again", async () => {
    const { req } = await interrupted();
    const job = await requestWarehouseRecheck(g.owner, { requestId: req.id });
    const { send, resolve } = transport(async () => {
      throw new Error("vendor down");
    });
    expect(await runWarehouseRecheck(job, resolve)).toBe("UNCERTAIN");
    expect(await reqOf(req.id)).toMatchObject({ status: "UNCERTAIN", lastError: WORKER_STOPPED });
    expect(send).not.toHaveBeenCalled();
    expect(await openTasks(req.id)).toBe(1);
    await requestWarehouseRecheck(g.owner, { requestId: req.id }); // allowed again
  });

  it("refused: too recent, a DRY_RUN call, a lowered mode, a moved shipment, another company's order", async () => {
    const recent = await interrupted({ lockedAt: new Date() });
    await expect(requestWarehouseRecheck(g.owner, { requestId: recent.req.id })).rejects.toMatchObject({
      code: "recheck_too_recent",
    });
    const dry = await interrupted({ evaluatedMode: "DRY_RUN" });
    await expect(requestWarehouseRecheck(g.owner, { requestId: dry.req.id })).rejects.toMatchObject({
      code: "recheck_mode_not_live",
    });
    const moved = await interrupted();
    await db().fulfillment.update({ where: { id: moved.f.id }, data: { status: "CANCELLED" } });
    await expect(requestWarehouseRecheck(g.owner, { requestId: moved.req.id })).rejects.toMatchObject({
      code: "recheck_shipment_moved",
    });
    const scoped = await interrupted();
    await expect(
      requestWarehouseRecheck({ ...g.owner, companyScope: ["other-company"] }, { requestId: scoped.req.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    // Mode lowered between the click and the worker: given back unchanged, the warehouse is not asked.
    const lowered = await interrupted();
    const job = await requestWarehouseRecheck(g.owner, { requestId: lowered.req.id });
    await db().fulfillmentConnection.update({
      where: { id: g.connection.id },
      data: { liveMode: "READ_ONLY" },
    });
    const readBack = vi.fn(async () => ({ found: false }));
    expect(await runWarehouseRecheck(job, transport(readBack).resolve)).toBe("UNCERTAIN");
    expect(readBack).not.toHaveBeenCalled();
    expect(await reqOf(lowered.req.id)).toMatchObject({ status: "UNCERTAIN", lastError: WORKER_STOPPED });
    await db().fulfillmentConnection.update({ where: { id: g.connection.id }, data: { liveMode: "LIVE" } });
    // Another kind of unknown result (no worker stop): left to a person.
    const other = await interrupted();
    await db().outboundRequest.update({ where: { id: other.req.id }, data: { lastError: "timeout" } });
    await expect(requestWarehouseRecheck(g.owner, { requestId: other.req.id })).rejects.toMatchObject({
      code: "recheck_not_recheckable",
    });
  });

  it("a task a person already closed: never offered; a deleted reference there: a person decides", async () => {
    const { req, order } = await interrupted();
    await db().alert.updateMany({
      where: { entityId: req.id, kind: "outbox_uncertain" },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    expect((await uncertainCreatesOf(g.owner, order.id))[0]?.refusal).toBe("task_resolved");
    await expect(requestWarehouseRecheck(g.owner, { requestId: req.id })).rejects.toMatchObject({
      code: "recheck_task_resolved",
    });
    // Closed between the click and the worker: the warehouse is not asked.
    const late = await interrupted();
    const job = await requestWarehouseRecheck(g.owner, { requestId: late.req.id });
    await db().alert.updateMany({
      where: { entityId: late.req.id, kind: "outbox_uncertain" },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    const readBack = vi.fn(async () => ({ found: false }));
    expect(await runWarehouseRecheck(job, transport(readBack).resolve)).toBe("UNCERTAIN");
    expect(readBack).not.toHaveBeenCalled();

    const del = await interrupted();
    const job2 = await requestWarehouseRecheck(g.owner, { requestId: del.req.id });
    const { resolve } = transport(async () => {
      throw new Error("reference RC-x is a deleted/cancelled shipment at euShipments — check the cabinet");
    });
    expect(await runWarehouseRecheck(job2, resolve)).toBe("UNCERTAIN");
    const shown = (await uncertainCreatesOf(g.owner, del.order.id))[0];
    expect(shown?.refusal).toBe("deleted_there");
    expect(shown?.lastCheckError).toContain("deleted/cancelled");
    expect(await db().alertNote.count({ where: { alert: { entityId: del.req.id }, action: "note" } })).toBe(
      1,
    );
  });

  it("paused outbox: refused; two workers on one request: one moves it", async () => {
    const { req } = await interrupted();
    await db().account.update({ where: { id: g.accountId }, data: { outboxPaused: true } });
    await expect(requestWarehouseRecheck(g.owner, { requestId: req.id })).rejects.toMatchObject({
      code: "recheck_outbox_paused",
    });
    await db().account.update({ where: { id: g.accountId }, data: { outboxPaused: false } });
    const job = await requestWarehouseRecheck(g.owner, { requestId: req.id });
    const { resolve } = transport(async () => ({ found: false }));
    const results = await Promise.all([runWarehouseRecheck(job, resolve), runWarehouseRecheck(job, resolve)]);
    expect(results.filter((x) => x === "PENDING")).toHaveLength(1);
    expect(await reqOf(req.id)).toMatchObject({ status: "PENDING" });
  });

  it("a late answer of the interrupted attempt never overwrites the new send", async () => {
    const { order } = await euTestOrder(g, { number: `#RC-${++n}` });
    await db().order.update({ where: { id: order.id }, data: { status: "QUEUED" } });
    const f = await db().fulfillment.create({
      data: {
        accountId: g.accountId,
        orderId: order.id,
        connectionId: g.connection.id,
        externalId: `RC-${n}`,
        status: "QUEUED",
      },
    });
    const req = await db().outboundRequest.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        operation: "eushipments.createOrder",
        idempotencyKey: `rc-late-${Date.now()}`,
        payload: { body: { awb: { referenceNumber: `RC-${n}` } }, ctx: { fulfillmentId: f.id } },
        fulfillmentId: f.id,
      },
    });
    const gates: (() => void)[] = [];
    const answers = ["OLD", "NEW"];
    const send = vi.fn(async () => {
      const answer = answers[send.mock.calls.length - 1]!;
      await new Promise<void>((r) => gates.push(r));
      return { outcome: "accepted" as const, response: { orderId: answer } };
    });
    const t = { send, readBack: async () => ({ found: false }) } as OutboundTransport;
    const waitCalls = async (k: number) => {
      for (let i = 0; i < 200 && send.mock.calls.length < k; i++) await new Promise((r) => setTimeout(r, 25));
    };
    // Attempt 1 hangs inside the vendor call; the worker is declared stopped.
    const first = processOutbound(req.id, () => t);
    await waitCalls(1);
    await db().outboundRequest.update({
      where: { id: req.id },
      data: { lockedAt: new Date(Date.now() - RECHECK_MIN_AGE_MS - 60_000) },
    });
    await sweepOutbox(new Date(Date.now() + 1000));
    expect((await reqOf(req.id)).status).toBe("UNCERTAIN");
    // Checked: absent → attempt 2 starts and hangs too.
    const job = await requestWarehouseRecheck(g.owner, { requestId: req.id });
    expect(await runWarehouseRecheck(job, () => t)).toBe("PENDING");
    const second = processOutbound(req.id, () => t);
    await waitCalls(2);
    // The old attempt answers first: it must not touch the new one.
    gates[0]!();
    await first;
    expect(await reqOf(req.id)).toMatchObject({ status: "SENDING", attempts: 2 });
    expect(await db().auditLog.count({ where: { entityId: req.id, action: "outbox.late_result" } })).toBe(1);
    expect(await openTasks(req.id)).toBe(1);
    gates[1]!();
    expect(await second).toBe("SENT");
    expect(await reqOf(req.id)).toMatchObject({ status: "SENT", lastResponse: { orderId: "NEW" } });
    expect(await openTasks(req.id)).toBe(0);
  });
});
