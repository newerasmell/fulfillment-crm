// e2e only (no worker runs during e2e): fetches queued FHB return photos with a mocked FHB (no network),
// against E2E_DATABASE_URL.   DATABASE_URL=<e2e db> tsx tools/e2e-returns-worker.ts
import "dotenv/config";

const { fetchQueuedPhotosWithMock } = await import("../tests/e2e/seed-returns");
const { basePrisma } = await import("@/server/db/client");
const n = await fetchQueuedPhotosWithMock();
console.log(`fetched ${n} return photo(s)`);
await basePrisma().$disconnect();
