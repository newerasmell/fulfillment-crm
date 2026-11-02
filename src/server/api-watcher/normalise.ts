import { createHash } from "node:crypto";

/**
 * Vendor spec normalisation (SPEC §8): sort keys, drop volatile fields, hash, and reduce the document to a
 * comparable structure — endpoints with their parameters, request fields and response fields. The diff and the
 * upgrade brief work on this structure only, so they never depend on how the vendor happens to order JSON.
 */

export interface FieldInfo {
  type: string;
  required?: boolean;
  enum?: string[];
  format?: string;
  /** maxLength / minLength / maximum / minimum / pattern, when documented. */
  constraints?: Record<string, string | number>;
}

export interface EndpointInfo {
  /** Human title (OpenAPI summary or Postman request name). */
  summary: string;
  deprecated: boolean;
  /** Hash of the prose description: vendors document rules in text (euShipments especially). */
  textHash: string;
  /** Request side: parameters (`query:x`, `path:x`, `header:x`) and body fields (`items[].sku`). */
  request: Record<string, FieldInfo>;
  /** Response side: `200:data[].status`, documented error codes, status tables. */
  response: Record<string, FieldInfo>;
}

export interface NormalisedSpec {
  format: "openapi" | "postman";
  title: string;
  version: string | null;
  /** Changelog text (OpenAPI "Change log" section, Postman "Version / Change" tables), one entry per line. */
  changelog: string[];
  endpoints: Record<string, EndpointInfo>;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Keys that change on every publish of a Postman collection without any API change. */
const POSTMAN_VOLATILE = new Set([
  "_postman_id",
  "id",
  "publishDate",
  "publishedId",
  "collectionId",
  "owner",
  "updatedAt",
  "createdAt",
  "lastUpdatedBy",
]);

/** Recursively sorts object keys and drops volatile ones; arrays keep their order (it is meaningful). */
export function canonicalise(value: unknown, volatile: ReadonlySet<string> = new Set()): Json {
  if (Array.isArray(value)) return value.map((v) => canonicalise(v, volatile));
  if (isObj(value)) {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(value).sort()) {
      if (volatile.has(k)) continue;
      out[k] = canonicalise(value[k], volatile);
    }
    return out;
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  return null;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function hashDocument(canonical: Json): string {
  return sha256(JSON.stringify(canonical));
}

const textHash = (s: string) => sha256(s.replace(/\s+/g, " ").trim()).slice(0, 16);

// ───────────────────────── OpenAPI ─────────────────────────

const CONSTRAINT_KEYS = ["maxLength", "minLength", "maximum", "minimum", "pattern"] as const;
const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const MAX_DEPTH = 12;

function fieldOf(s: Obj, required: boolean | undefined): FieldInfo {
  let type = typeof s.type === "string" ? s.type : isObj(s.properties) ? "object" : "any";
  if (s.nullable === true) type += "|null";
  const info: FieldInfo = { type };
  if (required !== undefined) info.required = required;
  if (Array.isArray(s.enum)) info.enum = s.enum.map((e) => String(e)).sort();
  if (typeof s.format === "string") info.format = s.format;
  const c: Record<string, string | number> = {};
  for (const k of CONSTRAINT_KEYS) {
    const v = s[k];
    if (typeof v === "string" || typeof v === "number") c[k] = v;
  }
  if (Object.keys(c).length) info.constraints = c;
  return info;
}

function mergeField(a: FieldInfo | undefined, b: FieldInfo): FieldInfo {
  if (!a) return b;
  // Variants of oneOf/anyOf/allOf at the same path: keep the union of what each documents.
  const out: FieldInfo = { ...a };
  if (a.type !== b.type)
    out.type = [...new Set([...a.type.split("/"), ...b.type.split("/")])].sort().join("/");
  if (a.required !== undefined || b.required !== undefined) out.required = !!(a.required || b.required);
  if (a.enum || b.enum) out.enum = [...new Set([...(a.enum ?? []), ...(b.enum ?? [])])].sort();
  return out;
}

class OpenApiReader {
  constructor(private readonly doc: Obj) {}

  private ref(ref: string): unknown {
    if (!ref.startsWith("#/")) return undefined;
    let node: unknown = this.doc;
    for (const part of ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      node = isObj(node) ? node[key] : undefined;
    }
    return node;
  }

  resolve(s: unknown, seen: ReadonlySet<string> = new Set()): { node: Obj | undefined; seen: Set<string> } {
    let node = s;
    const visited = new Set(seen);
    while (isObj(node) && typeof node.$ref === "string") {
      if (visited.has(node.$ref)) return { node: undefined, seen: visited }; // recursive schema
      visited.add(node.$ref);
      node = this.ref(node.$ref);
    }
    return { node: isObj(node) ? node : undefined, seen: visited };
  }

  flatten(
    schema: unknown,
    path: string,
    required: boolean | undefined,
    out: Record<string, FieldInfo>,
    seen: ReadonlySet<string> = new Set(),
    depth = 0,
  ) {
    if (depth > MAX_DEPTH) return;
    const { node: s, seen: nextSeen } = this.resolve(schema, seen);
    if (!s) return;
    for (const k of ["allOf", "oneOf", "anyOf"] as const) {
      const variants = s[k];
      if (Array.isArray(variants)) {
        for (const v of variants)
          this.flatten(v, path, k === "allOf" ? required : undefined, out, nextSeen, depth + 1);
        // A schema may combine allOf with its own properties: fall through to read them too.
        if (!isObj(s.properties) && !s.items) return;
      }
    }
    if (path) out[path] = mergeField(out[path], fieldOf(s, required));
    const req = new Set(Array.isArray(s.required) ? s.required.map(String) : []);
    if (isObj(s.properties)) {
      for (const [name, ps] of Object.entries(s.properties)) {
        this.flatten(ps, path ? `${path}.${name}` : name, req.has(name), out, nextSeen, depth + 1);
      }
    }
    if (s.items) this.flatten(s.items, `${path}[]`, undefined, out, nextSeen, depth + 1);
    if (isObj(s.additionalProperties))
      this.flatten(s.additionalProperties, `${path}{}`, undefined, out, nextSeen, depth + 1);
  }

  /** JSON content first, otherwise the first documented content type. */
  contentSchema(content: unknown): unknown {
    if (!isObj(content)) return undefined;
    const key = Object.keys(content).find((k) => k.includes("json")) ?? Object.keys(content)[0];
    const c = key ? content[key] : undefined;
    return isObj(c) ? c.schema : undefined;
  }
}

function changelogLines(text: string): string[] {
  // Keep from a "change log"/"changelog" heading on; without one, the description is not a changelog.
  const m = /^#{1,6}\s*change\s?log\b.*$/im.exec(text);
  if (!m) return [];
  return text
    .slice(m.index + m[0].length)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
}

export function normaliseOpenApi(doc: Obj): NormalisedSpec {
  const r = new OpenApiReader(doc);
  const info = isObj(doc.info) ? doc.info : {};
  const endpoints: Record<string, EndpointInfo> = {};
  const paths = isObj(doc.paths) ? doc.paths : {};
  for (const p of Object.keys(paths).sort()) {
    const ops = paths[p];
    if (!isObj(ops)) continue;
    const common = Array.isArray(ops.parameters) ? ops.parameters : [];
    for (const m of METHODS) {
      const op = ops[m];
      if (!isObj(op)) continue;
      const request: Record<string, FieldInfo> = {};
      const params = [...common, ...(Array.isArray(op.parameters) ? op.parameters : [])];
      for (const raw of params) {
        const { node: prm } = r.resolve(raw);
        if (!prm || typeof prm.name !== "string") continue;
        const { node: sch } = r.resolve(prm.schema);
        request[`${String(prm.in)}:${prm.name}`] = fieldOf(sch ?? {}, prm.required === true);
      }
      const { node: body } = r.resolve(op.requestBody);
      if (body) {
        const bodyFields: Record<string, FieldInfo> = {};
        r.flatten(r.contentSchema(body.content), "", undefined, bodyFields);
        for (const [k, v] of Object.entries(bodyFields)) request[`body:${k}`] = v;
      }
      const response: Record<string, FieldInfo> = {};
      const responses = isObj(op.responses) ? op.responses : {};
      for (const code of Object.keys(responses)) {
        const { node: res } = r.resolve(responses[code]);
        response[code] = { type: "status" };
        if (!res) continue;
        const fields: Record<string, FieldInfo> = {};
        r.flatten(r.contentSchema(res.content), "", undefined, fields);
        for (const [k, v] of Object.entries(fields)) response[`${code}:${k}`] = v;
      }
      endpoints[`${m.toUpperCase()} ${p}`] = {
        summary: typeof op.summary === "string" ? op.summary : "",
        deprecated: op.deprecated === true,
        textHash: textHash(`${String(op.description ?? "")}`),
        request,
        response,
      };
    }
  }
  return {
    format: "openapi",
    title: typeof info.title === "string" ? info.title : "",
    version: typeof info.version === "string" ? info.version : null,
    changelog: changelogLines(typeof info.description === "string" ? info.description : ""),
    endpoints,
  };
}

// ───────────────────────── Postman (euShipments) ─────────────────────────

const decode = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

interface HtmlTable {
  heading: string;
  header: string[];
  rows: string[][];
}

/** Tables of a Postman description, each with the closest preceding bold heading. */
export function htmlTables(html: string): HtmlTable[] {
  const out: HtmlTable[] = [];
  const re = /<p><strong>([^<]*)<\/strong><\/p>|<table>([\s\S]*?)<\/table>/gi;
  let heading = "";
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1] !== undefined) {
      heading = decode(m[1]).replace(/:$/, "");
      continue;
    }
    const body = m[2] ?? "";
    const cells = (row: string) =>
      [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => decode(c[1] ?? ""));
    const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => cells(r[1] ?? ""));
    if (!rows.length) continue;
    const [header, ...rest] = rows;
    out.push({ heading, header: (header ?? []).map((h) => h.toLowerCase()), rows: rest });
  }
  return out;
}

/** A section heading such as "awb.packages" names the object the following field table describes. */
const OBJECT_HEADING = /^[a-z_][\w]*(\.[a-z_][\w]*)*$/i;

/** Strips `// comments` outside strings (Postman bodies are annotated JSON). Returns null if not JSON. */
export function parseAnnotatedJson(raw: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") out += raw[++i] ?? "";
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += ch;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

function flattenExample(value: unknown, path: string, out: Record<string, FieldInfo>, depth = 0) {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(value)) {
    if (path) out[path] ??= { type: "array" };
    for (const v of value) flattenExample(v, `${path}[]`, out, depth + 1);
    return;
  }
  if (isObj(value)) {
    if (path) out[path] ??= { type: "object" };
    for (const [k, v] of Object.entries(value)) flattenExample(v, path ? `${path}.${k}` : k, out, depth + 1);
    return;
  }
  if (path) out[path] ??= { type: value === null ? "null" : typeof value };
}

const yes = (s: string | undefined) => /^(yes|true|required|y)\b/i.test((s ?? "").trim());

function postmanPath(url: unknown): { path: string; query: string[] } {
  let raw = "";
  let query: string[] = [];
  if (typeof url === "string") raw = url;
  else if (isObj(url)) {
    raw = typeof url.raw === "string" ? url.raw : "";
    if (Array.isArray(url.path)) raw = "/" + url.path.map(String).join("/");
    if (Array.isArray(url.query))
      query = url.query
        .filter(isObj)
        .map((q) => String(q.key ?? ""))
        .filter(Boolean);
  }
  const noQuery = raw.split("?");
  if (!query.length && noQuery[1])
    query = noQuery[1]
      .split("&")
      .map((kv) => kv.split("=")[0] ?? "")
      .filter(Boolean);
  const pathOnly = (noQuery[0] ?? "").replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/^\{\{[^}]+\}\}/, "");
  const segs = pathOnly
    .split("/")
    .filter(Boolean)
    .map((s) => (/^(\d+|\{.*\}|:\w+|\{\{.*\}\})$/.test(s) ? "{}" : s));
  return { path: "/" + segs.join("/"), query: [...new Set(query)].sort() };
}

/** Request names carry a version ("…_Web_Service_v1.5"): the key drops it so a bump reads as a change, not a new endpoint. */
const stripVersion = (name: string) =>
  name
    .replace(/[_\s-]*v\d+(\.\d+)*/gi, "")
    .replace(/\[deprecated\]\s*/i, "")
    .trim();

export function normalisePostman(doc: Obj): NormalisedSpec {
  const info = isObj(doc.info) ? doc.info : {};
  const endpoints: Record<string, EndpointInfo> = {};
  const changelog: string[] = [];

  const visit = (items: unknown[]) => {
    for (const it of items) {
      if (!isObj(it)) continue;
      if (Array.isArray(it.item)) {
        visit(it.item);
        continue;
      }
      const req = isObj(it.request) ? it.request : undefined;
      if (!req) continue;
      const name = typeof it.name === "string" ? it.name : "";
      const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
      const { path, query } = postmanPath(req.urlObject ?? req.url);
      const key = `${method} ${path} [${stripVersion(name)}]`;
      const description = typeof req.description === "string" ? req.description : "";
      const request: Record<string, FieldInfo> = {};
      const response: Record<string, FieldInfo> = {};
      for (const q of query) request[`query:${q}`] = { type: "string" };
      const body =
        isObj(req.body) && typeof req.body.raw === "string" ? parseAnnotatedJson(req.body.raw) : null;
      if (body !== null) {
        const ex: Record<string, FieldInfo> = {};
        flattenExample(body, "", ex);
        for (const [k, v] of Object.entries(ex)) request[`body:${k}`] = v;
      }
      for (const t of htmlTables(description)) {
        const [c0, c1, c2] = t.header;
        const prefix = OBJECT_HEADING.test(t.heading) ? `${t.heading}.` : "";
        if ((c0 === "field" || c0 === "parameter") && c1 === "type") {
          const where = c0 === "parameter" ? "param:" : "body:";
          const reqCol = c2 === "required" ? 2 : -1;
          for (const row of t.rows) {
            if (!row[0]) continue;
            const f: FieldInfo = { type: (row[1] ?? "").toLowerCase() || "any" };
            if (reqCol >= 0) f.required = yes(row[reqCol]);
            const restr = t.header.indexOf("restrictions");
            if (restr >= 0 && row[restr]) f.constraints = { restrictions: row[restr] };
            request[`${where}${prefix}${row[0]}`] = f;
          }
        } else if (c0 === "field" && c1 === "description" && t.header.length === 2) {
          for (const row of t.rows) if (row[0]) response[`field:${prefix}${row[0]}`] = { type: "documented" };
        } else if (c0 === "code" && c1 === "description") {
          const codes = t.rows.map((r) => r[0] ?? "").filter(Boolean);
          response[`codes:${t.heading || "errors"}`] = { type: "codes", enum: [...new Set(codes)].sort() };
        } else if ((c0 === "id" && c1 === "status") || c1 === "meaning") {
          const values = t.rows.map((r) => (c0 === "id" ? `${r[0]}=${r[1]}` : (r[0] ?? ""))).filter(Boolean);
          response[`enum:${t.heading || c0}`] = { type: "enum", enum: [...new Set(values)].sort() };
        } else if (c0 === "version" && c1 === "change") {
          for (const row of t.rows) changelog.push(`${stripVersion(name)} ${row[0] ?? ""}: ${row[1] ?? ""}`);
        }
      }
      // Same method+path+name twice in a collection (rare): keep both apart.
      let k = key;
      for (let n = 2; endpoints[k]; n++) k = `${key} #${n}`;
      endpoints[k] = {
        summary: name,
        deprecated: /deprecated/i.test(name),
        textHash: textHash(decode(description)),
        request,
        response,
      };
    }
  };
  visit(Array.isArray(doc.item) ? doc.item : []);
  return {
    format: "postman",
    title: typeof info.name === "string" ? info.name : "",
    version: null,
    changelog,
    endpoints,
  };
}

export interface NormalisedDocument {
  hash: string;
  spec: NormalisedSpec;
}

/** Hash covers the whole canonical document (prose included); the structure is what gets diffed. */
export function normaliseDocument(format: "openapi" | "postman", doc: Obj): NormalisedDocument {
  const canonical = canonicalise(doc, format === "postman" ? POSTMAN_VOLATILE : new Set());
  return {
    hash: hashDocument(canonical),
    spec: format === "openapi" ? normaliseOpenApi(doc) : normalisePostman(doc),
  };
}
