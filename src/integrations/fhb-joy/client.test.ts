import { describe, expect, it, vi } from "vitest";
import examples from "./__fixtures__/openapi-examples.json";
import { JoyClient, JoyError, type FetchLike } from "./client";
import {
  JoyDeliveryPoints,
  JoyErrorBody,
  JoyHalLink,
  JoyLabels,
  JoyLoginResponse,
  JoyPackageCreate,
  JoyPackageInfo,
  JoyShipmentCreate,
  JoyShipmentInfo,
  JoyShipmentLabel,
} from "./schemas";

// Fixtures are the vendor's documentation examples (docs/integrations/raw/fhb-joy.openapi.json) — no real data.
const ex = examples as Record<string, unknown>;
const CREDS = { appId: "test-app-id", secret: "test-secret" };

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function fake(handlers: Handler[]) {
  const calls: { method: string; url: URL; headers: Record<string, string>; body: unknown }[] = [];
  const loginBodies: unknown[] = [];
  let i = 0;
  const fetchImpl = vi.fn<FetchLike>(async (u, init = {}) => {
    const url = new URL(u);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/api/joy/login") {
      loginBodies.push(body);
      return json({ token: `tok-${loginBodies.length}`, expiration: "2099-01-01 00:00:00 +0100" });
    }
    calls.push({
      method: init.method ?? "GET",
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body,
    });
    const h = handlers[Math.min(i++, handlers.length - 1)];
    if (!h) throw new Error("no handler");
    return h(url, init);
  });
  const client = new JoyClient(CREDS, { fetchImpl, sleep: async () => {} });
  return { client, calls, loginBodies };
}

describe("schemas accept every documented example", () => {
  const cases: [string, { safeParse: (v: unknown) => { success: boolean } }][] = [
    ["POST /login 200", JoyLoginResponse],
    ["POST /shipments request", JoyShipmentCreate],
    ["POST /shipments 200", JoyShipmentLabel],
    ["GET /shipments 200", JoyShipmentLabel],
    ["GET /shipment 200", JoyShipmentInfo],
    ["GET /labels 200", JoyLabels],
    ["POST /packages 201", JoyHalLink],
    ["GET /packages 200", JoyPackageInfo],
    ["GET /delivery-point 200", JoyDeliveryPoints],
    ["POST /shipments 400", JoyErrorBody],
  ];
  it.each(cases)("%s", (name, schema) => {
    expect(ex[name], name).toBeDefined();
    expect(schema.safeParse(ex[name]).success).toBe(true);
  });

  it("the package request example uses psc, not zip", () => {
    const body = ex["POST /packages request"] as Record<string, unknown>;
    expect(body.psc).toBeDefined();
    expect(JoyPackageCreate.safeParse({ ...body, id: "1003201" }).success).toBe(true);
  });

  it("an empty _embedded serialised as [] parses", () => {
    const r = JoyShipmentInfo.parse({ id: "X", status: "pending", _embedded: [] });
    expect(r._embedded).toBeNull();
  });

  it("an unknown status is kept raw, not refused", () => {
    expect(JoyShipmentInfo.parse({ id: "X", status: "something_new" }).status).toBe("something_new");
  });

  it("weight must have one entry per package", () => {
    const body = { ...(ex["POST /shipments request"] as object), numberOfPackages: 2, weight: [1] };
    expect(JoyShipmentCreate.safeParse(body).success).toBe(false);
  });
});

describe("JoyClient", () => {
  it("logs in with camelCase appId and sends the base64 token", async () => {
    const { client, calls, loginBodies } = fake([() => json(ex["GET /shipment 200"])]);
    await client.getShipment("M-M1001");
    expect(loginBodies[0]).toEqual({ appId: "test-app-id", secret: "test-secret" });
    expect(calls[0]!.headers["X-Authentication-Simple"]).toBe(Buffer.from("tok-1").toString("base64"));
  });

  it("puts the id in the body on POST and in the query on GET/DELETE", async () => {
    const { client, calls } = fake([
      () => json(ex["POST /shipments 200"]),
      () => json(ex["GET /shipment 200"]),
      () => new Response(null, { status: 204 }),
    ]);
    const body = ex["POST /shipments request"] as never;
    await client.createShipment(body);
    await client.getShipment("1003201");
    await client.rejectShipment("1003201");
    expect(calls[0]!.url.search).toBe("");
    expect((calls[0]!.body as { id: string }).id).toBe("1003201");
    expect(calls[1]!.url.searchParams.get("id")).toBe("1003201");
    expect(calls[2]!.method).toBe("DELETE");
    expect(calls[2]!.url.searchParams.get("id")).toBe("1003201");
  });

  it("re-logs in once on 401 and repeats the call once", async () => {
    const { client, calls, loginBodies } = fake([
      () => json(ex["GET /shipment 401"], 401),
      () => json(ex["GET /shipment 200"]),
    ]);
    expect((await client.getShipment("1003201"))?.status).toBe("pending");
    expect(loginBodies).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it("answers null for a 404 on reads (read-back: not created)", async () => {
    const { client } = fake([() => json({ status: "error", message: "Shipment not found." }, 404)]);
    expect(await client.getShipment("nope")).toBeNull();
  });

  it("never retries a create on 5xx: the outcome is unknown", async () => {
    const { client, calls } = fake([() => json({}, 502)]);
    const err = await client.createShipment(ex["POST /shipments request"] as never).catch((e) => e);
    expect(err).toBeInstanceOf(JoyError);
    expect((err as JoyError).outcomeUnknown).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("retries reads on 5xx", async () => {
    const { client, calls } = fake([() => json({}, 503), () => json(ex["GET /shipment 200"])]);
    expect(await client.getShipment("1003201")).not.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("maps 400 to validation with the offending field, 409 to conflict", async () => {
    const { client } = fake([
      () => json(ex["POST /shipments 400"], 400),
      () => json({ status: "error", message: "Resource already exists, use PUT method" }, 409),
    ]);
    const e1 = (await client
      .createShipment(ex["POST /shipments request"] as never)
      .catch((e) => e)) as JoyError;
    expect(e1.code).toBe("validation");
    expect(e1.field).toBe("name");
    expect(e1.outcomeUnknown).toBe(false);
    const e2 = (await client
      .createShipment(ex["POST /shipments request"] as never)
      .catch((e) => e)) as JoyError;
    expect(e2.code).toBe("conflict");
  });

  it("bulk labels use ids=a,b and refuse more than 100", async () => {
    const { client, calls } = fake([() => json(ex["GET /labels 200"])]);
    await client.labels(["A", "B"]);
    expect(calls[0]!.url.searchParams.get("ids")).toBe("A,B");
    await expect(client.labels(Array.from({ length: 101 }, (_, i) => `X${i}`))).rejects.toThrow(/100/);
  });

  it("refuses a strict-schema violation before anything is sent", async () => {
    const { client, calls } = fake([() => json({})]);
    await expect(client.createShipment({ id: "x" } as never)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
