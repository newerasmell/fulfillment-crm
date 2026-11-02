import { exit } from "node:process";

/** Refuse to serve traffic with a database role that would silently bypass row-level security. */
export async function registerNode() {
  if (!process.env.DATABASE_URL) return;
  const { assertSafeDatabaseRole } = await import("@/server/db/client");
  try {
    await assertSafeDatabaseRole();
  } catch (err) {
    const { logger } = await import("@/lib/logger");
    logger.fatal({ err }, "refusing to start: unsafe database role");
    exit(1);
  }
}
