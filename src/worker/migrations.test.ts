import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSchemaUpToDate } from "./migrations";

describe("assertSchemaUpToDate", () => {
  it("passes on the migrated test database and fails when a migration is missing", async () => {
    await expect(assertSchemaUpToDate()).resolves.toBeUndefined();
    const dir = mkdtempSync(path.join(tmpdir(), "mig-"));
    mkdirSync(path.join(dir, "29991231000000_future"));
    await expect(assertSchemaUpToDate(dir)).rejects.toThrow(/29991231000000_future/);
  });
});
