import { describe, expect, it, vi } from "vitest";
import examples from "./__fixtures__/openapi-examples.json";
import { JOY_OPS, JoyTransport, type JoyResultEvent } from "./adapter";
import { JoyClient, type FetchLike } from "./client";

// Doc examples + synthetic ids only.
const ex = examples as Record<string, unknown>;
const body = { ...(ex["POST /shipments request"] as Record<string, unknown>), id: "M-M1001" };
const created = ex["POST /shipments 200"];
const info = ex["GET /shipment 200"];
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function setup(route: (method: string, path: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl = vi.fn<FetchLike>(async (u, init = {}) => {
    const url = new URL(u);
    const path = url.pathname.replace("/api/joy", "");
    if (path === "/login") return json({ token: "t", expiration: "2099-01-01 00:00:00 +0100" });
    calls.push(`${init.method ?? "GET"} ${path}`);
    return route(init.method ?? "GET", path);
  });
  const client = new JoyClient({ appId: "a", secret: "s" }, { fetchImpl, sleep: async () => {} });
  const events: JoyResultEvent[] = [];
  const transport = new JoyTransport({
    client: async () => client,
    onResult: async (e) => void events.push(e),
  });
  const call = {
    operation: JOY_OPS.createShipment,
    idempotencyKey: "joy.shipment.create:M-M1001",
    payload: { id: "M-M1001", body, ctx: { fulfillmentId: "f1" } },
    testMode: false,
  };
  return { transport, calls, events, call };
}

const notFound = () => json({ status: "error", message: "Shipment not found." }, 404);

describe("JoyTransport — never a second label", () => {
  it("has no test mode: DRY_RUN only records", () => {
    expect(setup(() => json({})).transport.supportsTestMode()).toBe(false);
  });

  it("creates once and hands the label to the effect, not to the outbox row", async () => {
    const { transport, calls, events, call } = setup((m, p) =>
      m === "GET" && p === "/shipment" ? notFound() : json(created),
    );
    const r = await transport.send(call);
    expect(r.outcome).toBe("accepted");
    expect(calls).toEqual(["GET /shipment", "POST /shipments"]);
    expect(JSON.stringify(r.response)).not.toContain("JVBER");
    expect(events[0]).toMatchObject({ kind: "created", recovered: false, tracking: ["40050000000"] });
    expect(events[0]!.kind === "created" && events[0]!.labelBase64).toBeTruthy();
  });

  it("a shipment already at Joy is recovered (reprint), POST is never sent", async () => {
    const { transport, calls, events, call } = setup((m, p) =>
      p === "/shipment" ? json(info) : m === "GET" && p === "/shipments" ? json(created) : json({}, 500),
    );
    const r = await transport.send(call);
    expect(r.outcome).toBe("accepted");
    expect(calls).toEqual(["GET /shipment", "GET /shipments"]);
    expect(events[0]).toMatchObject({ kind: "created", recovered: true });
  });

  it("a timeout on create throws (unknown outcome); read-back finds it, so no retry creates a second", async () => {
    let posted = 0;
    let existsAfterPost = false;
    const { transport, calls, call } = setup((m, p) => {
      if (p === "/shipment") return existsAfterPost ? json(info) : notFound();
      if (m === "POST") {
        posted++;
        existsAfterPost = true; // Joy created it, but our side never saw the answer
        throw new Error("The operation was aborted due to timeout");
      }
      return json(created);
    });
    await expect(transport.send(call)).rejects.toMatchObject({ outcomeUnknown: true });
    const back = await transport.readBack(call);
    expect(back.found).toBe(true);
    expect(posted).toBe(1);
    expect(calls.filter((c) => c === "POST /shipments")).toHaveLength(1);
  });

  it("read-back says not found when Joy has nothing (the outbox may then send again)", async () => {
    const { transport, call } = setup(() => notFound());
    expect((await transport.readBack(call)).found).toBe(false);
  });

  it("409 on create is read back, never retried with another id", async () => {
    let shipmentReads = 0;
    const { transport, calls, call } = setup((m, p) => {
      if (p === "/shipment") return shipmentReads++ === 0 ? notFound() : json(info);
      if (m === "POST")
        return json({ status: "error", message: "Resource already exists, use PUT method" }, 409);
      return json(created);
    });
    const r = await transport.send(call);
    expect(r.outcome).toBe("accepted");
    expect(calls.filter((c) => c === "POST /shipments")).toHaveLength(1);
  });

  it("a DIFFERENT shipment under our id is never claimed (send, 409 and read-back)", async () => {
    const foreign = { ...(info as object), name: "Someone Else", zip: "11000", variableSymbol: "999" };
    // Before create: found, but not ours → rejected with a CRITICAL id-conflict event, no POST, no reprint.
    const a = setup((m, p) => (p === "/shipment" ? json(foreign) : json(created)));
    const r = await a.transport.send(a.call);
    expect(r).toMatchObject({ outcome: "rejected", error: expect.stringContaining("joy id already used") });
    expect(a.calls).toEqual(["GET /shipment"]);
    expect(a.events[0]).toMatchObject({ kind: "create_rejected", idConflict: true, field: "id" });
    // 409 on create, the read-back finds someone else's shipment.
    let posted = false;
    const b = setup((m, p) => {
      if (p === "/shipment") return posted ? json(foreign) : notFound();
      posted = true;
      return json({ status: "error", message: "Resource already exists" }, 409);
    });
    expect((await b.transport.send(b.call)).outcome).toBe("rejected");
    expect(b.events[0]).toMatchObject({ kind: "create_rejected", idConflict: true });
    expect(b.events.some((e) => e.kind === "created")).toBe(false);
    // Read-back after a timeout: throws (→ UNCERTAIN + operator task), never "found".
    const c = setup((m, p) => (p === "/shipment" ? json({ ...foreign, cod: 1 }) : json(created)));
    await expect(c.transport.readBack(c.call)).rejects.toThrow(/joy id already used/);
    expect(c.events).toEqual([]);
    // Same shipment with cosmetic differences (case, spaces) is still ours.
    const d = setup((m, p) =>
      p === "/shipment"
        ? json({ ...(info as object), name: " oskar  šnajdr ", zip: "755 01" })
        : json(created),
    );
    expect((await d.transport.readBack(d.call)).found).toBe(true);
  });

  it("a 400 is a definite rejection with the field named", async () => {
    const { transport, events, call } = setup((m, p) =>
      p === "/shipment" ? notFound() : json(ex["POST /shipments 400"], 400),
    );
    const r = await transport.send(call);
    expect(r).toMatchObject({ outcome: "rejected" });
    expect(events[0]).toMatchObject({ kind: "create_rejected", field: "name" });
  });

  it("reject: 204 voids, 409 is refused", async () => {
    const a = setup(() => new Response(null, { status: 204 }));
    const rej = { ...a.call, operation: JOY_OPS.rejectShipment, payload: { id: "M-M1001", ctx: {} } };
    expect((await a.transport.send(rej)).outcome).toBe("accepted");
    expect(a.events[0]!.kind).toBe("voided");
    const b = setup(() => json({ status: "error", message: "Order has not Printed status" }, 409));
    expect((await b.transport.send(rej)).outcome).toBe("rejected");
    expect(b.events[0]!.kind).toBe("void_refused");
  });

  it("an effect failure never changes the vendor outcome", async () => {
    const failed = vi.fn(async () => {});
    const fetchImpl = vi.fn<FetchLike>(async (u, init = {}) => {
      const p = new URL(u).pathname.replace("/api/joy", "");
      if (p === "/login") return json({ token: "t" });
      if (p === "/shipment") return notFound();
      return init.method === "POST" ? json(created) : json({});
    });
    const client = new JoyClient({ appId: "a", secret: "s" }, { fetchImpl });
    const t = new JoyTransport({
      client: async () => client,
      onResult: async () => {
        throw new Error("db down");
      },
      onEffectFailed: failed,
    });
    const r = await t.send({
      operation: JOY_OPS.createShipment,
      idempotencyKey: "k",
      payload: { id: "M-M1001", body, ctx: {} },
      testMode: false,
    });
    expect(r.outcome).toBe("accepted");
    expect(failed).toHaveBeenCalledOnce();
  });
});
