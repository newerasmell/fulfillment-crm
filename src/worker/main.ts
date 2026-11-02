import "./env";
import { logger } from "@/lib/logger";
import { assertSafeDatabaseRole, basePrisma } from "@/server/db/client";
import { createBoss, ensureQueues } from "@/server/jobs/boss";
import { registerWorkers } from "@/server/jobs/handlers";
import { resolveEuShipmentsTransport } from "@/server/eushipments/transport";
import { assertSchemaUpToDate } from "./migrations";

async function main() {
  await assertSafeDatabaseRole();
  await assertSchemaUpToDate();
  const boss = createBoss({ worker: true });
  boss.on("error", (err) => logger.error({ err }, "pg-boss error"));
  await boss.start();
  await ensureQueues(boss);
  // Vendor transports by connection type; a type without one stays PENDING with "no_transport".
  await registerWorkers({ boss, resolveTransport: (c) => resolveEuShipmentsTransport(c) });
  logger.info("worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker stopping");
    await boss.stop({ graceful: true, timeout: 30_000 });
    await basePrisma().$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
