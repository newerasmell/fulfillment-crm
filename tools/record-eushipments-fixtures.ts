// euShipments fixture recording (GATE P3-G1 — run by the OWNER against the deployed CRM's database; never in
// CI, never by the autopilot: the build environment has no production credentials by design).
//   tsx tools/record-eushipments-fixtures.ts <accountId> <connectionId>
// Read calls only; every response is scrubbed (src/integrations/eushipments/fixtures/scrub.ts) before it is
// written to src/integrations/eushipments/__fixtures__/recorded/. Review the files, then commit them.
import "dotenv/config";

const [accountId, connectionId] = process.argv.slice(2);
if (!accountId || !connectionId) {
  console.error("usage: tsx tools/record-eushipments-fixtures.ts <accountId> <connectionId>");
  process.exit(2);
}
const { recordEuFixtures } = await import("@/server/eushipments/record-fixtures");
const { basePrisma } = await import("@/server/db/client");
try {
  const r = await recordEuFixtures(accountId, connectionId);
  for (const f of r.written) console.log(`written  ${f}`);
  for (const f of r.refused)
    console.log(`REFUSED  ${f.endpoint}: unclassified fields ${f.unclassified.slice(0, 10).join(", ")}`);
  for (const f of r.failed) console.log(`failed   ${f.endpoint}: ${f.error}`);
  process.exitCode = r.refused.length ? 1 : 0;
} finally {
  await basePrisma().$disconnect();
}
