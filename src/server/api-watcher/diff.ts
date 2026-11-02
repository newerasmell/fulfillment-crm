import type { EndpointInfo, FieldInfo, NormalisedSpec } from "./normalise";

/**
 * Structured diff of two normalised specs (SPEC §8): endpoints added/removed, fields added/removed/changed,
 * enum values, changelog text. Every change is classified from OUR side of the integration:
 *  - breaking: something we send or read may stop working (needs code before the connection goes LIVE again);
 *  - additive: new optional input, new output, relaxed rule — safe to ignore until we want it;
 *  - info: wording, titles, changelog lines — read, but nothing to change.
 * New response enum values count as breaking: an unknown status reaches the status map (CLAUDE.md).
 */

export type Severity = "breaking" | "additive" | "info";
export type Side = "request" | "response";

export type ChangeKind =
  | "endpoint_added"
  | "endpoint_removed"
  | "endpoint_deprecated"
  | "endpoint_text_changed"
  | "summary_changed"
  | "field_added"
  | "field_removed"
  | "type_changed"
  | "required_changed"
  | "enum_added"
  | "enum_removed"
  | "constraints_changed"
  | "version_changed"
  | "changelog";

export interface SpecChange {
  kind: ChangeKind;
  severity: Severity;
  endpoint?: string;
  side?: Side;
  field?: string;
  before?: unknown;
  after?: unknown;
}

export interface SpecDiff {
  counts: Record<Severity, number>;
  changes: SpecChange[];
}

const ORDER: Record<Severity, number> = { breaking: 0, additive: 1, info: 2 };

function diffField(
  out: SpecChange[],
  endpoint: string,
  side: Side,
  field: string,
  a: FieldInfo,
  b: FieldInfo,
) {
  const base = { endpoint, side, field };
  if (a.type !== b.type || (a.format ?? null) !== (b.format ?? null)) {
    out.push({
      ...base,
      kind: "type_changed",
      severity: "breaking",
      before: [a.type, a.format].filter(Boolean).join(" "),
      after: [b.type, b.format].filter(Boolean).join(" "),
    });
  }
  if (
    (a.required ?? false) !== (b.required ?? false) &&
    (a.required !== undefined || b.required !== undefined)
  ) {
    const nowRequired = b.required === true;
    // Request: newly required input breaks us. Response: a field that may now be missing breaks us.
    const breaking = side === "request" ? nowRequired : !nowRequired;
    out.push({
      ...base,
      kind: "required_changed",
      severity: breaking ? "breaking" : "additive",
      before: a.required ?? false,
      after: b.required ?? false,
    });
  }
  const ea = new Set(a.enum ?? []);
  const eb = new Set(b.enum ?? []);
  if (a.enum || b.enum) {
    const added = [...eb].filter((v) => !ea.has(v));
    const removed = [...ea].filter((v) => !eb.has(v));
    // An enum that appears or disappears entirely is a constraint change on the field.
    if (added.length && a.enum)
      out.push({
        ...base,
        kind: "enum_added",
        severity: side === "response" ? "breaking" : "additive",
        after: added,
      });
    if (removed.length && b.enum)
      out.push({
        ...base,
        kind: "enum_removed",
        severity: side === "request" ? "breaking" : "additive",
        before: removed,
      });
    if (!a.enum !== !b.enum)
      out.push({
        ...base,
        kind: "constraints_changed",
        severity: side === "request" && b.enum ? "breaking" : "info",
        before: a.enum ?? null,
        after: b.enum ?? null,
      });
  }
  const ca = JSON.stringify(a.constraints ?? {});
  const cb = JSON.stringify(b.constraints ?? {});
  if (ca !== cb) {
    out.push({
      ...base,
      kind: "constraints_changed",
      severity: side === "request" ? "breaking" : "info",
      before: a.constraints ?? null,
      after: b.constraints ?? null,
    });
  }
}

function diffFields(
  out: SpecChange[],
  endpoint: string,
  side: Side,
  a: Record<string, FieldInfo>,
  b: Record<string, FieldInfo>,
) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const field of keys) {
    const fa = a[field];
    const fb = b[field];
    if (fa && fb) diffField(out, endpoint, side, field, fa, fb);
    else if (fb) {
      // New input: breaking only when we must now send it. New output is always safe to ignore.
      const severity: Severity = side === "request" && fb.required === true ? "breaking" : "additive";
      out.push({ kind: "field_added", severity, endpoint, side, field, after: fb });
    } else if (fa) {
      out.push({ kind: "field_removed", severity: "breaking", endpoint, side, field, before: fa });
    }
  }
}

function diffEndpoint(out: SpecChange[], key: string, a: EndpointInfo, b: EndpointInfo) {
  if (!a.deprecated && b.deprecated)
    out.push({ kind: "endpoint_deprecated", severity: "breaking", endpoint: key });
  if (a.summary !== b.summary)
    out.push({
      kind: "summary_changed",
      severity: "info",
      endpoint: key,
      before: a.summary,
      after: b.summary,
    });
  if (a.textHash !== b.textHash) out.push({ kind: "endpoint_text_changed", severity: "info", endpoint: key });
  diffFields(out, key, "request", a.request, b.request);
  diffFields(out, key, "response", a.response, b.response);
}

export function diffSpecs(before: NormalisedSpec, after: NormalisedSpec): SpecDiff {
  const changes: SpecChange[] = [];
  if (before.version !== after.version || before.title !== after.title) {
    changes.push({
      kind: "version_changed",
      severity: "info",
      before: `${before.title} ${before.version ?? ""}`.trim(),
      after: `${after.title} ${after.version ?? ""}`.trim(),
    });
  }
  const keys = [...new Set([...Object.keys(before.endpoints), ...Object.keys(after.endpoints)])].sort();
  for (const key of keys) {
    const a = before.endpoints[key];
    const b = after.endpoints[key];
    if (a && b) diffEndpoint(changes, key, a, b);
    else if (b) changes.push({ kind: "endpoint_added", severity: "additive", endpoint: key });
    else changes.push({ kind: "endpoint_removed", severity: "breaking", endpoint: key });
  }
  const old = new Set(before.changelog);
  for (const line of after.changelog) {
    if (!old.has(line)) changes.push({ kind: "changelog", severity: "info", after: line });
  }
  changes.sort((x, y) => ORDER[x.severity] - ORDER[y.severity]);
  const counts: Record<Severity, number> = { breaking: 0, additive: 0, info: 0 };
  for (const c of changes) counts[c.severity]++;
  return { counts, changes };
}
