import { assertSafeDatabaseRole, basePrisma } from "@/server/db/client";
import { logger } from "@/lib/logger";

// Readiness: database reachable and the DB role does not bypass row-level security.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await basePrisma().$queryRaw`SELECT 1`;
    await assertSafeDatabaseRole();
    return Response.json({ status: "ready" });
  } catch (err) {
    logger.error({ err }, "readiness check failed");
    return Response.json({ status: "not_ready" }, { status: 503 });
  }
}
