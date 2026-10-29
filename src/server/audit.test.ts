import { beforeAll, describe, expect, it } from "vitest";
import { systemDb } from "@/server/db/client";
import { listAudit, recordAudit, scrubForAudit } from "./audit";

describe("audit log", () => {
  let A: string;
  let B: string;
  beforeAll(async () => {
    A = (await systemDb().account.create({ data: { name: "Audit A" } })).id;
    B = (await systemDb().account.create({ data: { name: "Audit B" } })).id;
  });

  it("scrubs secret-looking fields recursively", () => {
    expect(
      scrubForAudit({ name: "x", password: "p", nested: { appSecret: "s", ok: 1 }, list: [{ token: "t" }] }),
    ).toEqual({
      name: "x",
      password: "[REDACTED]",
      nested: { appSecret: "[REDACTED]", ok: 1 },
      list: [{ token: "[REDACTED]" }],
    });
    expect(scrubForAudit({ seq: 10n, at: new Date("2026-01-01T00:00:00Z") })).toEqual({
      seq: "10",
      at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("records per account, lists newest first, pages, and stays isolated", async () => {
    for (let i = 0; i < 3; i++) {
      await recordAudit({
        accountId: A,
        action: "test.mutate",
        entityType: "Thing",
        entityId: String(i),
        after: { i },
      });
    }
    await recordAudit({ accountId: B, action: "test.mutate", after: { secret: "nope" } });
    const page1 = await listAudit(A, { take: 2 });
    expect(page1.rows.map((r) => r.entityId)).toEqual(["2", "1"]);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await listAudit(A, { take: 2, cursor: page1.nextCursor });
    expect(page2.rows.map((r) => r.entityId)).toEqual(["0"]);
    expect(page2.nextCursor).toBeUndefined();
    const b = await listAudit(B);
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]?.after).toEqual({ secret: "[REDACTED]" });
  });

  it("records system-level events without an account", async () => {
    const row = await recordAudit({ action: "auth.login_failed", after: { email: "x@example.com" } });
    expect(row.accountId).toBeNull();
  });
});
