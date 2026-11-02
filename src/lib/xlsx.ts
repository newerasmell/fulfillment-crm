import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Minimal Excel (.xlsx) and CSV for one-sheet tables of text (the product mapping export/import, P5-00).
 * No dependency: an .xlsx is a ZIP of a few XML files. Writing uses inline strings; reading understands what
 * Excel, LibreOffice and Google Sheets save (shared strings, inline strings, numbers, booleans). Size limits
 * guard against zip bombs.
 */

export const MAX_UNZIPPED_BYTES = 40 * 1024 * 1024;
const MAX_ENTRIES = 200;
/**
 * Sheet limits: the row / column index comes from the file (`<row r="…">`, `<c r="…">`), so without a cap a 1 KB
 * file could make us pad billions of empty rows. 5000 data rows (mapping MAX_ROWS) + header + 1 for the
 * "too many rows" message; 500 columns is far above any line's warehouses + stores.
 */
export const MAX_SHEET_ROWS = 5002;
export const MAX_SHEET_COLUMNS = 500;
const MAX_SHEET_CELLS = 1_000_000;

// ───────────── ZIP ─────────────

interface ZipEntry {
  name: string;
  data: Buffer;
}

function dosTime(d: Date) {
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

export function zip(entries: ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dosTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const compressed = deflateRawSync(e.data);
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + compressed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export class SpreadsheetError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "SpreadsheetError";
  }
}

export function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SpreadsheetError("not_a_zip");
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_ENTRIES) throw new SpreadsheetError("too_many_entries");
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new SpreadsheetError("bad_zip");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + xlen + clen;
    total += usize;
    if (total > MAX_UNZIPPED_BYTES) throw new SpreadsheetError("too_large");
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new SpreadsheetError("bad_zip");
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) {
      const data = inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
      out.set(name, data);
    } else throw new SpreadsheetError("unsupported_compression");
  }
  return out;
}

// ───────────── XML helpers ─────────────

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Characters XML 1.0 does not allow.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

const unesc = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });

/** Text of every <t> inside a fragment (rich-text runs concatenated; phonetic runs ignored). */
const textOf = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)]
    .map((m) => unesc(m[1] ?? ""))
    .join("");

function colLetter(i: number) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function colIndex(ref: string) {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ───────────── XLSX ─────────────

export function writeXlsx(rows: string[][], sheetName = "Sheet1"): Buffer {
  const sheetRows = rows
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">${r
          .map((v, ci) =>
            v === ""
              ? ""
              : `<c r="${colLetter(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${esc(v)}</t></is></c>`,
          )
          .join("")}</row>`,
    )
    .join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${sheetRows}</sheetData></worksheet>`;
  const name = esc(sheetName.replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Sheet1");
  const files: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    },
    {
      name: "xl/styles.xml",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`),
    },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet) },
  ];
  return zip(files);
}

/** First sheet of a workbook as rows of trimmed-right text cells. Any parse failure is a SpreadsheetError. */
export function readXlsx(buf: Buffer): string[][] {
  try {
    return parseXlsx(buf);
  } catch (err) {
    if (err instanceof SpreadsheetError) throw err;
    throw new SpreadsheetError("bad_file");
  }
}

function parseXlsx(buf: Buffer): string[][] {
  const files = unzip(buf);
  const get = (n: string) => files.get(n)?.toString("utf8");
  let sheetPath = "xl/worksheets/sheet1.xml";
  const wb = get("xl/workbook.xml");
  const rels = get("xl/_rels/workbook.xml.rels");
  if (wb && rels) {
    const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
    // Fixed patterns only (the id comes from the file): find the Relationship whose Id equals rid in code.
    const target = rid
      ? [...rels.matchAll(/<Relationship\b([^>]*)>/g)]
          .map((m) => m[1] ?? "")
          .filter((a) => /\bId="([^"]*)"/.exec(a)?.[1] === rid)
          .map((a) => /\bTarget="([^"]+)"/.exec(a)?.[1])
          .find((t) => !!t)
      : undefined;
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheet =
    get(sheetPath) ??
    [...files.keys()]
      .filter((k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k))
      .sort()
      .map(get)[0];
  if (!sheet) throw new SpreadsheetError("no_sheet");
  const shared = [
    ...(get("xl/sharedStrings.xml") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g),
  ].map((m) => textOf(m[1] ?? ""));
  const rows: string[][] = [];
  let cellCount = 0;
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const attrs = rm[1] ?? rm[3] ?? "";
    const rIdx = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? rows.length + 1) - 1;
    if (rIdx >= MAX_SHEET_ROWS || rows.length >= MAX_SHEET_ROWS) throw new SpreadsheetError("too_many_rows");
    const cells: string[] = [];
    let next = 0;
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1] ?? "";
      const body = cm[2] ?? "";
      const ref = /\br="([A-Z]+)\d*"/i.exec(a)?.[1];
      const ci = ref ? colIndex(ref) : next;
      next = ci + 1;
      const t = /\bt="([^"]+)"/.exec(a)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = "";
      if (t === "s") value = shared[Number(v)] ?? "";
      else if (t === "inlineStr") value = textOf(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "");
      else if (t === "b") value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
      else value = unesc(v ?? "");
      if (ci >= MAX_SHEET_COLUMNS) throw new SpreadsheetError("too_many_columns");
      cellCount += Math.max(1, ci + 1 - cells.length);
      if (cellCount > MAX_SHEET_CELLS) throw new SpreadsheetError("too_many_cells");
      while (cells.length < ci) cells.push("");
      cells[ci] = value;
    }
    if (rIdx < 0) continue;
    while (rows.length < rIdx) rows.push([]);
    rows[rIdx] = cells;
  }
  return rows;
}

// ───────────── CSV ─────────────

const BOM = String.fromCharCode(0xfeff);

/** A cell Excel would run as a formula (CSV injection): = + - @ or a leading tab / CR. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * CSV with ";" (what Excel with a Bulgarian locale expects) and a BOM so Cyrillic opens correctly. Cells that
 * would start a formula (names come from vendor data and Shopify titles) get a leading apostrophe; readCsv
 * strips it again, so an export round-trips.
 */
export function writeCsv(rows: string[][], sep = ";"): string {
  const cell = (raw: string) => {
    const v = FORMULA_START.test(raw) ? `'${raw}` : raw;
    return /[";,\n\r\t]/.test(v) || /^\s|\s$/.test(v) || FORMULA_START.test(raw)
      ? `"${v.replace(/"/g, '""')}"`
      : v;
  };
  return BOM + rows.map((r) => r.map(cell).join(sep)).join("\r\n") + "\r\n";
}

/** RFC 4180 CSV; the separator (";", "," or tab) is detected from the first line. */
export function readCsv(text: string): string[][] {
  const s = text.startsWith(BOM) ? text.slice(1) : text;
  const first = s.split(/\r?\n/, 1)[0] ?? "";
  const counts = [";", ",", "\t"].map((c) => [c, first.split(c).length - 1] as const);
  const sep = counts.sort((a, b) => b[1] - a[1])[0]![1] > 0 ? counts[0]![0] : ";";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  // Undo writeCsv's formula guard: "'=x" → "=x" (only before a formula character, so "'abc" stays).
  return rows.map((r) =>
    r.map((c) => (c.startsWith("'") && FORMULA_START.test(c.slice(1)) ? c.slice(1) : c)),
  );
}

/** Reads an uploaded table: .xlsx by its ZIP signature, otherwise UTF-8 CSV. */
export function readTable(buf: Buffer): string[][] {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return readXlsx(buf);
  return readCsv(buf.toString("utf8"));
}
