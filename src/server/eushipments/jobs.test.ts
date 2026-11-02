import { describe, expect, it } from "vitest";
import { QUEUES } from "@/server/jobs/queues";
import { EuCitiesJob, EuConnectionJob, parseEuJob, usableEuConnections } from "./jobs";
import { euTestGroup } from "./test-fixtures";

describe("euShipments pollers", () => {
  it("every per-connection queue is stately (one queued + one running per connection)", () => {
    const eu = Object.values(QUEUES).filter((q) => q.name.startsWith("eushipments.") && !("cron" in q));
    expect(eu.length).toBeGreaterThanOrEqual(8);
    for (const q of eu) expect((q.options as { policy?: string }).policy, q.name).toBe("stately");
  });

  it("job payloads are Zod-parsed: a malformed job throws (→ dead letter) instead of running", () => {
    const ok = { accountId: "acc", connectionId: "con" };
    expect(parseEuJob(EuConnectionJob, ok, "q")).toEqual(ok);
    expect(parseEuJob(EuCitiesJob, { ...ok, countryId: 2 }, "q")).toEqual({ ...ok, countryId: 2 });
    expect(() => parseEuJob(EuConnectionJob, { connectionId: "con" }, "q")).toThrow(/malformed q job/);
    expect(() => parseEuJob(EuCitiesJob, { ...ok, countryId: "2" }, "q")).toThrow(/malformed/);
    expect(() => parseEuJob(EuConnectionJob, null, "q")).toThrow(/malformed/);
  });

  it("only polls enabled connections with a token, a company and a passed connection test", async () => {
    const g = await euTestGroup("jobs");
    const ids = async () => (await usableEuConnections()).map((c) => c.id);
    expect(await ids()).not.toContain(g.connection.id); // never tested
    await g.db.eushipmentsSync.create({
      data: {
        accountId: g.accountId,
        connectionId: g.connection.id,
        kind: "connection",
        lastOkAt: new Date(),
      },
    });
    expect(await ids()).toContain(g.connection.id);
    await g.db.eushipmentsSync.update({
      where: { connectionId_kind: { connectionId: g.connection.id, kind: "connection" } },
      data: { lastError: "auth" },
    });
    expect(await ids()).not.toContain(g.connection.id);
    await g.db.eushipmentsSync.update({
      where: { connectionId_kind: { connectionId: g.connection.id, kind: "connection" } },
      data: { lastError: null },
    });
    await g.db.fulfillmentConnection.update({ where: { id: g.connection.id }, data: { enabled: false } });
    expect(await ids()).not.toContain(g.connection.id);
    await g.db.fulfillmentConnection.update({
      where: { id: g.connection.id },
      data: { enabled: true, vendorIds: {} },
    });
    expect(await ids()).not.toContain(g.connection.id);
  });
});
