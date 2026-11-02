import type { SpecChange, SpecDiff } from "./diff";
import type { SpecSource } from "./sources";

/**
 * The upgrade brief (SPEC §8): a markdown hand-off for the Claude Code session that implements the change.
 * It says what changed (breaking vs additive), which adapter files, schemas and tests are affected, and the
 * steps — nothing is ever deployed from a vendor change automatically.
 */

const MAX_LINES_PER_SECTION = 80;

const fmt = (v: unknown) => {
  if (v === undefined || v === null) return "—";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
};

export function describeChange(c: SpecChange): string {
  const where = [c.endpoint ? `\`${c.endpoint}\`` : "", c.side, c.field ? `\`${c.field}\`` : ""]
    .filter(Boolean)
    .join(" ");
  switch (c.kind) {
    case "endpoint_added":
      return `${where}: new endpoint`;
    case "endpoint_removed":
      return `${where}: endpoint removed`;
    case "endpoint_deprecated":
      return `${where}: marked deprecated`;
    case "endpoint_text_changed":
      return `${where}: description text changed (read it: rules are often only in prose)`;
    case "summary_changed":
      return `${where}: title ${fmt(c.before)} → ${fmt(c.after)}`;
    case "field_added":
      return `${where}: added (${fmt((c.after as { type?: string } | undefined)?.type)}${(c.after as { required?: boolean } | undefined)?.required ? ", required" : ""})`;
    case "field_removed":
      return `${where}: removed`;
    case "type_changed":
      return `${where}: type ${fmt(c.before)} → ${fmt(c.after)}`;
    case "required_changed":
      return `${where}: required ${fmt(c.before)} → ${fmt(c.after)}`;
    case "enum_added":
      return `${where}: new values ${fmt(c.after)}`;
    case "enum_removed":
      return `${where}: values removed ${fmt(c.before)}`;
    case "constraints_changed":
      return `${where}: rules ${fmt(c.before)} → ${fmt(c.after)}`;
    case "version_changed":
      return `spec version ${fmt(c.before)} → ${fmt(c.after)}`;
    case "changelog":
      return `changelog: ${fmt(c.after)}`;
  }
}

function section(title: string, changes: SpecChange[]): string[] {
  if (!changes.length) return [];
  const lines = changes.slice(0, MAX_LINES_PER_SECTION).map((c) => `- ${describeChange(c)}`);
  if (changes.length > MAX_LINES_PER_SECTION)
    lines.push(`- … and ${changes.length - MAX_LINES_PER_SECTION} more (see the stored diff)`);
  return [`## ${title} (${changes.length})`, "", ...lines, ""];
}

/** Which of our files a set of changes touches, by the adapter layout in CLAUDE.md. */
export function affectedFiles(source: SpecSource, changes: SpecChange[]): string[] {
  const dir = source.adapterDir;
  const files = new Set<string>();
  for (const c of changes) {
    if (c.severity === "info" && c.kind !== "endpoint_text_changed") continue;
    if (c.kind === "endpoint_added" || c.kind === "endpoint_removed" || c.kind === "endpoint_deprecated") {
      files.add(`${dir}/client.ts`);
      files.add(`${dir}/adapter.ts`);
    }
    if (c.side === "request") {
      files.add(`${dir}/mapper.ts`);
      files.add(`${dir}/validators.ts`);
      files.add(`${dir}/schemas.ts`);
    }
    if (c.side === "response") {
      files.add(`${dir}/schemas.ts`);
      if (c.kind === "enum_added" || c.kind === "enum_removed") files.add(`${dir}/status-map.ts`);
    }
    if (c.kind === "endpoint_text_changed") files.add(`${dir}/validators.ts`);
  }
  if (files.size) {
    files.add(`${dir}/__fixtures__/`);
    files.add(`${dir}/*.test.ts`);
  }
  return [...files].sort();
}

export interface BriefInput {
  source: SpecSource;
  diff: SpecDiff;
  previous: { hash: string; fetchedAt: Date };
  current: { hash: string; fetchedAt: Date };
}

export function buildUpgradeBrief({ source, diff, previous, current }: BriefInput): string {
  const { counts, changes } = diff;
  const endpoints = [
    ...new Set(changes.filter((c) => c.severity !== "info" && c.endpoint).map((c) => c.endpoint!)),
  ];
  const files = affectedFiles(source, changes);
  const lines = [
    `# Upgrade brief: ${source.label}`,
    "",
    `Source: ${source.url}`,
    `Previous: \`${previous.hash.slice(0, 12)}\` (${previous.fetchedAt.toISOString()}) → new: \`${current.hash.slice(0, 12)}\` (${current.fetchedAt.toISOString()})`,
    "",
    `**${counts.breaking} breaking, ${counts.additive} additive, ${counts.info} informational.**`,
    "",
    counts.breaking
      ? "Breaking changes: connections of this vendor must stay in DRY_RUN until a person confirms correct payloads (SPEC §8). Nothing is deployed automatically."
      : "No breaking change detected. Nothing is deployed automatically.",
    "",
    ...section(
      "Breaking",
      changes.filter((c) => c.severity === "breaking"),
    ),
    ...section(
      "Additive",
      changes.filter((c) => c.severity === "additive"),
    ),
    ...section(
      "Informational / changelog",
      changes.filter((c) => c.severity === "info"),
    ),
    "## Affected code",
    "",
    ...(files.length ? files.map((f) => `- \`${f}\``) : ["- none detected (text-only change)"]),
    ...(endpoints.length ? ["", "Endpoints: " + endpoints.map((e) => `\`${e}\``).join(", ")] : []),
    "",
    "## Steps",
    "",
    `1. Run \`pnpm docs:refresh\` locally and read the diff of \`${source.rawFile}\` and \`${source.reference}\`.`,
    "2. Update the Zod schemas, mappers, validators and status map listed above; add or update fixtures and tests.",
    "3. Update `docs/integrations/INTEGRATION_NOTES.md` and record the change in `docs/PROGRESS.md`.",
    "4. Deploy; keep affected connections in DRY_RUN until an operator has checked real payloads, then an OWNER raises the mode.",
    "",
  ];
  return lines.join("\n");
}
