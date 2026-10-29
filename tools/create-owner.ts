// Creates the first OWNER user and their first company (GATE P0-G1), or another user with --user-only.
// Prints the generated password and the 2FA key ONCE. Run in Render Shell:
//   pnpm owner:create --email you@example.com --name "Your Name" --account "Company name"
import "dotenv/config";
import { parseArgs } from "node:util";
import { bootstrapOwner } from "@/server/auth/users";
import { basePrisma } from "@/server/db/client";

const { values } = parseArgs({
  options: { email: { type: "string" }, name: { type: "string" }, account: { type: "string" } },
});
if (!values.email || !values.name || !values.account) {
  console.error('Usage: pnpm owner:create --email <email> --name "<name>" --account "<company name>"');
  process.exit(2);
}

const r = await bootstrapOwner({ email: values.email, name: values.name, accountName: values.account });
console.log(`\nOWNER created: ${r.user.email} in company "${r.account.name}"`);
console.log(`Temporary password: ${r.password}`);
console.log(`2FA key (add to your authenticator app): ${r.totpSecret}`);
console.log(`or scan/open this URI: ${r.otpauthUri}\n`);
console.log("These are shown only now. Store the password in a password manager.");
await basePrisma().$disconnect();
