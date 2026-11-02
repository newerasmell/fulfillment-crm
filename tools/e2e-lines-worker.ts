// e2e only (no worker runs during e2e): processes waiting master catalogue runs against E2E_DATABASE_URL.
//   DATABASE_URL=<e2e db> tsx tools/e2e-lines-worker.ts
import "dotenv/config";

const { runQueuedCatalogueRuns } = await import("../tests/e2e/seed-lines");
const { basePrisma } = await import("@/server/db/client");
const n = await runQueuedCatalogueRuns();
console.log(`processed ${n} catalogue run(s)`);
await basePrisma().$disconnect();
