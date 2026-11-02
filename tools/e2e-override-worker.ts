// e2e only (no worker runs during e2e): sends the override group's queued cancels with a MOCKED vendor and runs the
// reroute sweep against E2E_DATABASE_URL.   DATABASE_URL=<e2e db> tsx tools/e2e-override-worker.ts
import "dotenv/config";

const { runOverrideWorker } = await import("../tests/e2e/seed-override");
const { basePrisma } = await import("@/server/db/client");
const done = await runOverrideWorker();
console.log(`reroutes: ${JSON.stringify(done)}`);
await basePrisma().$disconnect();
