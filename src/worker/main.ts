import "./env";
import { logger } from "@/lib/logger";
import { assertSafeDatabaseRole, basePrisma } from "@/server/db/client";
import { createBoss, ensureQueues } from "@/server/jobs/boss";
import { registerWorkers } from "@/server/jobs/handlers";
import { resolveFhbTransport } from "@/server/fhb/transport";
import { resolveEuShipmentsTransport } from "@/server/eushipments/transport";
import { withLabelTransports } from "@/server/labels/transport";
import { assertSchemaUpToDate } from "./migrations";

async function main() {
  await assertSafeDatabaseRole();
  await assertSchemaUpToDate();
  const boss = createBoss({ worker: true });
  boss.on("error", (err) => logger.error({ err }, "pg-boss error"));
  await boss.start();
  await ensureQueues(boss);
  // Vendor transports by connection type; each resolver answers only for its own type.
  await registerWorkers({
    boss,
    // FHB Joy labels and euShipments AWBs are added on top (src/server/labels/transport.ts).
    resolveTransport: withLabelTransports((c) => resolveFhbTransport(c) ?? resolveEuShipmentsTransport(c)),
  });
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
