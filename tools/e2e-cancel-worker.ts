// e2e only (no worker runs during e2e): plays the sender / the vendor's confirmed delete for the cancel group against
// E2E_DATABASE_URL.   DATABASE_URL=<e2e db> tsx tools/e2e-cancel-worker.ts send|confirm
import "dotenv/config";

const step = process.argv[2] === "confirm" ? "confirm" : "send";
const { runCancelWorker } = await import("../tests/e2e/seed-cancel");
const { basePrisma } = await import("@/server/db/client");
console.log(`${step}: ${JSON.stringify(await runCancelWorker(step))}`);
await basePrisma().$disconnect();
