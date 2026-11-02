import { describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { basePrisma, systemDb, withAccountTransaction } from "@/server/db/client";
import type { OutboundTransport } from "./transport";
import {
  confirmCanary,
  enqueueOutbound,
  enqueueOutboundInTx,
  processOutbound,
  setConnectionMode,
  sweepOutbox,
} from "./outbox";

// Regression tests for races found in the phase-0 audit (round 3). Each one failed before its fix.

async function setup(mode: "READ_ONLY" | "CANARY" | "LIVE", cap = 10) {
  const sys = systemDb();
  const account = await sys.account.create({ data: { name: `race ${Date.now()}` } });
  const connection = await sys.fulfillmentConnection.create({
    data: { accountId: account.id, type: "FHB_V3", name: "F", liveMode: mode, canaryDailyCap: cap },
  });
  return { account, connection };
}

describe("outbox races", () => {
  it("a stale re-arm cannot turn an in-flight request back into PENDING (no double send)", async () => {
    const { account, connection } = await setup("READ_ONLY");
    const input = {
      accountId: account.id,
      connectionId: connection.id,
      operation: "order.create",
      idempotencyKey: "k",
      payload: {},
    };
    const { request } = await enqueueOutbound(input);
    let sends = 0;
    const plain = {
      send: async () => (sends++, { outcome: "accepted" as const, response: {} }),
    } as OutboundTransport;
    expect(await processOutbound(request.id, () => plain)).toBe("REFUSED");
    await systemDb().fulfillmentConnection.update({
      where: { id: connection.id },
      data: { liveMode: "LIVE" },
    });

    // A: reads the REFUSED row, then stalls before writing.
    let go!: () => void;
    const gate = new Promise<void>((r) => (go = r));
    let read!: () => void;
    const didRead = new Promise<void>((r) => (read = r));
    const slow = withAccountTransaction(account.id, async (tx) => {
      const stalled = new Proxy(tx, {
        get(target, prop) {
          const v = Reflect.get(target, prop) as Record<string, unknown>;
          if (prop !== "outboundRequest") return v;
          return new Proxy(v, {
            get(d, op) {
              const fn = Reflect.get(d, op) as (a: unknown) => Promise<unknown>;
              if (op !== "findUnique") return fn;
              return async (a: unknown) => {
                const r = await fn.call(d, a);
                read();
                await gate;
                return r;
              };
            },
          });
        },
      }) as Prisma.TransactionClient;
      return enqueueOutboundInTx(stalled, input);
    });
    await didRead;
    await enqueueOutbound(input); // B re-arms and commits
    const sending = {
      send: async () => {
        sends++;
        go(); // A continues while the vendor call is in flight
        await new Promise((r) => setTimeout(r, 500));
        return { outcome: "accepted" as const, response: {} };
      },
    } as OutboundTransport;
    const inflight = processOutbound(request.id, () => sending);
    const a = await slow;
    expect(await inflight).toBe("SENT");
    expect(a.created).toBe(false);
    expect(await processOutbound(request.id, () => plain)).toBe("skipped");
    expect(sends).toBe(1);
  });

  it("a CANARY confirmation racing a kill switch cannot take the request out of HELD", async () => {
    const { account, connection } = await setup("CANARY", 5);
    const { request } = await enqueueOutbound({
      accountId: account.id,
      connectionId: connection.id,
      operation: "order.create",
      idempotencyKey: "k",
      payload: {},
    });
    const t = { send: async () => ({ outcome: "accepted" as const, response: {} }) } as OutboundTransport;
    expect(await processOutbound(request.id, () => t)).toBe("AWAITING_CONFIRMATION");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    // Simulated kill switch holding its locks (connection first, then the request), like killSwitch().
    const killer = basePrisma().$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls','on',TRUE)`;
        await tx.$executeRaw`UPDATE "FulfillmentConnection" SET "liveMode"='READ_ONLY' WHERE id=${connection.id}`;
        await tx.$executeRaw`UPDATE "OutboundRequest" SET status='HELD', "confirmedAt"=NULL WHERE id=${request.id}`;
        locked();
        await gate;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    const conf = confirmCanary({ userId: "u-op", accountId: account.id, role: "OPERATOR" }, request.id);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await killer;
    await expect(conf).rejects.toMatchObject({ code: "not_confirmable" });
    const row = await systemDb().outboundRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect({ status: row.status, confirmedAt: row.confirmedAt }).toEqual({
      status: "HELD",
      confirmedAt: null,
    });
  });

  it("leaving CANARY puts waiting requests back in the queue under the new mode (none get stuck)", async () => {
    const { account, connection } = await setup("CANARY", 1);
    const owner = { userId: "u-owner", accountId: account.id, role: "OWNER" as const };
    const t = { send: async () => ({ outcome: "accepted" as const, response: {} }) } as OutboundTransport;
    const ids: string[] = [];
    for (const k of ["unconfirmed", "capped-1", "capped-2"]) {
      ids.push(
        (
          await enqueueOutbound({
            accountId: account.id,
            connectionId: connection.id,
            operation: "o",
            idempotencyKey: k,
            payload: {},
          })
        ).request.id,
      );
    }
    for (const id of ids) await processOutbound(id, () => t);
    await confirmCanary(owner, ids[1]!);
    await confirmCanary(owner, ids[2]!);
    expect(await processOutbound(ids[1]!, () => t)).toBe("SENT");
    expect(await processOutbound(ids[2]!, () => t)).toBe("AWAITING_CONFIRMATION"); // cap 1 → parked until tomorrow
    await setConnectionMode(owner, connection.id, "LIVE");
    const due = (await sweepOutbox()).map((d) => d.id);
    expect(due).toEqual(expect.arrayContaining([ids[0], ids[2]]));
    expect(await processOutbound(ids[0]!, () => t)).toBe("SENT");
    expect(await processOutbound(ids[2]!, () => t)).toBe("SENT");
  });
});
