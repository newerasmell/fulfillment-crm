import { readdirSync } from "node:fs";
import path from "node:path";
import { appliedMigrations } from "@/server/db/client";

/** The worker must not run newer code against an older schema (it can start before the web pre-deploy). */
export async function assertSchemaUpToDate(dir = path.join(process.cwd(), "prisma", "migrations")) {
  const expected = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const applied = await appliedMigrations();
  const missing = expected.filter((m) => !applied.has(m));
  if (missing.length)
    throw new Error(`Database schema is behind the code; missing migrations: ${missing.join(", ")}`);
}
