// Validates render.yaml against Render's published JSON schema (BACKLOG P0-12). Needs network.
//   pnpm render:validate
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

const schema = await (await fetch("https://render.com/schema/render.yaml.json")).json();
const doc = parse(readFileSync("render.yaml", "utf8")) as {
  services?: { type: string; name: string }[];
  databases?: unknown[];
};
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validate = ajv.compile(schema);
if (!validate(doc)) {
  console.error(JSON.stringify(validate.errors, null, 2));
  process.exit(1);
}
const services = doc.services ?? [];
console.log(
  `render.yaml is valid: ${services.map((s) => `${s.type}:${s.name}`).join(", ")}; databases: ${doc.databases?.length ?? 0}`,
);
