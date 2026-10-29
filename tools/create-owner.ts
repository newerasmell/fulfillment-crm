// GATE P0-G1: creates a company and a single-use OWNER invitation link (valid 24 h).
// Run in the Render web service's Shell (not as a One-Off Job, whose output stays in the logs):
//   pnpm owner:create --email you@example.com --account "Company name"
// Open the printed link, choose your password and scan the 2FA key. Nobody else ever sees either.
import "dotenv/config";
import { parseArgs } from "node:util";
import { basePrisma } from "@/server/db/client";
import { createOwnerInvitation } from "@/server/invitations";

const { values } = parseArgs({ options: { email: { type: "string" }, account: { type: "string" } } });
if (!values.email || !values.account) {
  console.error('Usage: pnpm owner:create --email <email> --account "<company name>"');
  process.exit(2);
}

const base = (process.env.APP_URL ?? process.env.RENDER_EXTERNAL_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const r = await createOwnerInvitation({ email: values.email, accountName: values.account });
console.log(`\nCompany "${r.account.name}" created.`);
console.log(`Owner invitation for ${values.email} (valid until ${r.expiresAt.toISOString()}):`);
console.log(`${base}/invite/${r.token}\n`);
await basePrisma().$disconnect();
