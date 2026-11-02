// Records FHB v3 fixtures from a configured production connection — READ calls only (GET), P2-03.
//
//   pnpm fixtures:record -- --connection <connectionId> [--pickup <service>:<country>] [--limit 5]
//
// Run by the OWNER at GATE P2-G1, on a machine with the production DATABASE_URL and CREDENTIALS_KEY (never
// in CI or on the autopilot box: there are no credentials there by design). Every response is passed through
// the fixture scrubber (src/integrations/fhb-v3/fixture-scrubber.ts) BEFORE it touches the disk, arrays are
// cut to --limit items, and the files go to src/integrations/fhb-v3/__fixtures__/recorded/. Check them, then
// commit. Nothing about the responses is printed except file names, item counts and schema results.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { FhbClient } from "@/integrations/fhb-v3/client";
import { createFhbFixtureRecorder } from "@/integrations/fhb-v3/fixture-recorder";

const { values } = parseArgs({
  options: {
    connection: { type: "string" },
    pickup: { type: "string" },
    limit: { type: "string", default: "5" },
    out: { type: "string", default: "src/integrations/fhb-v3/__fixtures__/recorded" },
  },
});

if (process.env.CI) {
  console.error("fixtures:record never runs in CI (it needs production credentials).");
  process.exit(1);
}
const connectionId = z.string().min(1).parse(values.connection);
const limit = z.coerce.number().int().min(1).max(50).parse(values.limit);

const { connectionAccount, fhbClientForConnection } = await import("@/server/fhb/connection");
const c = await connectionAccount(connectionId);
if (!c || c.type !== "FHB_V3") {
  console.error("No FHB v3 connection with that id.");
  process.exit(1);
}
const client: FhbClient = await fhbClientForConnection(c.accountId, connectionId);
const pickup = values.pickup ? values.pickup.split(":") : null;

const files = await createFhbFixtureRecorder(client, {
  limit,
  pickup: pickup ? { service: pickup[0]!, country: pickup[1] } : undefined,
}).record();

mkdirSync(values.out!, { recursive: true });
for (const f of files) {
  writeFileSync(path.join(values.out!, `${f.name}.json`), JSON.stringify(f.fixture, null, 2) + "\n");
  console.log(
    `${f.name}.json  ${f.fixture.endpoint}  items=${f.items ?? "-"}  schema=${f.fixture.schemaOk ? "ok" : "MISMATCH"}`,
  );
}
console.log("Scrubbed fixtures written. Review them, run `pnpm test`, then commit.");
process.exit(0);
