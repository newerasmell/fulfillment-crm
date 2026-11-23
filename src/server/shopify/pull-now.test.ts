import { describe, expect, it } from "vitest";
import { systemDb } from "@/server/db/client";
import { euTestGroup } from "@/server/eushipments/test-fixtures";
import { lastOrdersPull, pullOrdersNow } from "./pull-now";

// „Изтегли поръчките сега“ (owner request 2026-11-23). Synthetic data only; the queue is a stub.
describe("pull orders now", () => {
  it("queues the scheduled pull for every connected store the member sees, and nothing else", async () => {
    const g = await euTestGroup("pull-now");
    const db = systemDb();
    const cred = g.connection.credentialId!;
    const other = await db.company.create({ data: { accountId: g.accountId, name: "Second company" } });
    const store = (over: Record<string, unknown>) =>
      db.store.create({
        data: {
          accountId: g.accountId,
          companyId: g.company.id,
          domain: `pull-${Math.random().toString(36).slice(2, 8)}.example`,
          code: `P${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          name: "S",
          currency: "EUR",
          credentialId: cred,
          connectionStatus: { ok: true },
          ...over,
        },
      });
    const connected = await store({ syncCursors: { ordersSyncedAt: "2026-11-23T06:00:00.000Z" } });
    // A failed test: left alone, and its old pull time is not "the last pull".
    await store({
      connectionStatus: { ok: false },
      syncCursors: { ordersSyncedAt: "2026-10-01T00:00:00.000Z" },
    });
    await store({ archivedAt: new Date() }); // archived: not even counted
    const otherCompany = await store({
      companyId: other.id,
      syncCursors: { ordersSyncedAt: "2026-11-23T05:00:00.000Z" },
    });
    await db.store.update({
      where: { id: g.store.id },
      data: { credentialId: cred, connectionStatus: { ok: true } },
    });

    const ctx = { accountId: g.accountId, role: "OWNER" as const, companyScope: null, activeCompanyId: null };
    const sent: string[] = [];
    const r = await pullOrdersNow(ctx, async (id) => {
      sent.push(id);
      return id === connected.id ? null : `job-${id}`; // null = already waiting
    });
    expect(sent.sort()).toEqual([connected.id, otherCompany.id, g.store.id].sort());
    expect(r).toMatchObject({ already: 1, skipped: 1 });
    expect(r.queued).toBe(sent.length - 1);
    expect((await lastOrdersPull(ctx))?.toISOString()).toBe("2026-11-23T05:00:00.000Z");

    // A member of the second company only: its store only.
    const scoped = { ...ctx, role: "OPERATOR" as const, companyScope: [other.id] };
    const mine: string[] = [];
    await pullOrdersNow(scoped, async (id) => (mine.push(id), "job"));
    expect(mine).toEqual([otherCompany.id]);
    // The company picked in the sidebar, and the sidebar's product line, limit it the same way.
    const picked: string[] = [];
    await pullOrdersNow({ ...ctx, activeCompanyId: other.id }, async (id) => (picked.push(id), "job"));
    expect(picked).toEqual([otherCompany.id]);
    const inLine: string[] = [];
    await pullOrdersNow({ ...ctx, lineCompanyIds: [other.id] }, async (id) => (inLine.push(id), "job"));
    expect(inLine).toEqual([otherCompany.id]);
    // Roles without stores.sync may not; another group sees nothing of these.
    await expect(pullOrdersNow({ ...ctx, role: "WAREHOUSE" }, async () => "job")).rejects.toThrow();
    const stranger = await euTestGroup("pull-now-other");
    const theirs: string[] = [];
    await pullOrdersNow({ ...ctx, accountId: stranger.accountId }, async (id) => (theirs.push(id), "job"));
    expect(theirs).not.toContain(connected.id);
  });
});
