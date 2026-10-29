import "./env";
import { logger } from "@/lib/logger";
import { assertSafeDatabaseRole, basePrisma } from "@/server/db/client";
import { createBoss, ensureQueues } from "@/server/jobs/boss";
import { registerWorkers } from "@/server/jobs/handlers";

async function main() {
  await assertSafeDatabaseRole();
  const boss = createBoss({ worker: true });
  boss.on("error", (err) => logger.error({ err }, "pg-boss error"));
  await boss.start();
  await ensureQueues(boss);
  // No vendor adapters yet (phase 2+): every send stays PENDING with "no_transport".
  await registerWorkers({ boss, resolveTransport: () => undefined });
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
