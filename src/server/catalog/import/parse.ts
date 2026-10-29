/*
 * Reads a catalog import file (CSV or xlsx) into plain text cells. No validation happens here.
 *
 * Library choice (xlsx): `fflate` 0.8.3, exact-pinned, zero dependencies, `npm audit` clean, plus the
 * small sheet reader below. The npm `xlsx` (SheetJS) package is stale on npm and has known high
 * CVEs (prototype pollution, ReDoS), and `exceljs` drags in a large old dependency tree; an import
 * file only needs strings and numbers, which is a few hundred lines on top of an unzip.
 *
 * Safety rules:
 *  - The file is at most 5 MB; an xlsx is a zip, so its DECLARED uncompressed total is capped at 50 MB
 *    before anything is inflated (zip bomb), and fflate inflates into a buffer of the declared size,
 *    so a forged smaller size cannot grow past it. Only workbook.xml, its rels, sharedStrings.xml and
 *    the first sheet are ever inflated.
 *  - The XML is scanned with indexOf (no regular expression runs over the document), entities are
 *    decoded by a fixed table, and no DOCTYPE or external entity is ever resolved (no XXE).
 *  - Cells are read as TEXT. Shared and inline strings keep their exact text (leading zeros stay).
 *    Numeric cells give their stored text (Excel stores 6221234567890 as "6221234567890" and a
 *    long number as "1.23457E+12") and are listed in `numericCells` so the validator can reject a
 *    barcode that was typed as a number (zeros may have been lost; see validate.ts).
 *  - Formulas are NEVER evaluated. A formula cell yields the value the file cached for it (as text),
 *    or an empty cell when none is cached. A text cell that starts with "=" is just text.
 *  - Only .csv and .xlsx are accepted. .xls, .xlsm and everything else is refused (IMPORT_UNREADABLE).
 *  - Every failure is a RuleError with IMPORT_TOO_LARGE, IMPORT_TOO_MANY_ROWS or IMPORT_UNREADABLE;
 *    a raw library error never escapes.
 */
import { strFromU8, unzipSync } from "fflate";
import { RuleError } from "@/server/framework/errors";

export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10_000;
const MAX_COLUMNS = 16_384; // Excel's limit (XFD)

export type ParsedImport = {
  headers: string[];
  /** Data rows (header excluded); a row may be shorter or longer than the header. */
  rows: string[][];
  /** "row:col" (row 1-based data row, col 0-based) of every xlsx cell stored as a number. Empty for CSV. */
  numericCells: Set<string>;
};

const unreadable = () => new RuleError("IMPORT_UNREADABLE");

export function parseImportFile(bytes: Uint8Array, name: string): ParsedImport {
  if (bytes.length > MAX_IMPORT_FILE_BYTES) throw new RuleError("IMPORT_TOO_LARGE");
  const lower = name.trim().toLowerCase();
  let table: { cells: string[][]; numeric: Set<string> };
  try {
    if (lower.endsWith(".csv")) table = { cells: parseCsv(bytes), numeric: new Set() };
    else if (lower.endsWith(".xlsx")) table = readXlsx(bytes);
    else throw unreadable();
  } catch (e) {
    if (e instanceof RuleError) throw e;
    throw unreadable();
  }
  return finish(table.cells, table.numeric);
}

/** Splits header and data, drops trailing empty rows, enforces the row cap. */
function finish(cells: string[][], numeric: Set<string>): ParsedImport {
  const isBlank = (r: readonly string[]) => r.every((c) => c.trim() === "");
  let start = 0;
  while (start < cells.length && isBlank(cells[start]!)) start++;
  let end = cells.length;
  while (end > start && isBlank(cells[end - 1]!)) end--;
  if (start >= end) throw unreadable(); // empty file
  const headers = cells[start]!.map((h) => h.trim());
  const rows = cells.slice(start + 1, end);
  if (rows.length > MAX_IMPORT_ROWS) throw new RuleError("IMPORT_TOO_MANY_ROWS");
  return { headers, rows, numericCells: numeric };
}

// ---------------------------------------------------------------------------------------------
// CSV

function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes); // strips a BOM
  } catch {
    return new TextDecoder("windows-1256").decode(bytes);
  }
}

function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && ch in counts) counts[ch]!++;
  }
  let best = ",";
  for (const d of [";", "\t"]) if (counts[d]! > counts[best]!) best = d;
  return best;
}

function parseCsv(bytes: Uint8Array): string[][] {
  let text = decodeCsv(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let delimiter: string | null = null;
  const sep = /^sep=(.)\r?\n/i.exec(text); // Excel's "sep=;" first line
  if (sep) {
    delimiter = sep[1]!;
    text = text.slice(sep[0].length);
  }
  delimiter ??= detectDelimiter(text);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;
  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === delimiter) endField();
    else if (ch === "\n") endRow();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw unreadable(); // unterminated quote
  if (fieldStarted || field !== "" || row.length > 0) endRow();
  return rows;
}

// ---------------------------------------------------------------------------------------------
// xlsx

type Element = { attrs: string; inner: string };

/**
 * The elements named `tag` in `xml`, in order, found with indexOf only (linear; a malformed or
 * hostile document ends the scan with an error instead of backtracking). Elements of one name
 * never nest in the parts of OOXML read here (row, c, v, t, si, sheet, Relationship).
 */
function* elements(xml: string, tag: string): Generator<Element> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let pos = 0;
  for (;;) {
    const i = xml.indexOf(open, pos);
    if (i === -1) return;
    const after = xml.charCodeAt(i + open.length);
    // The name must end here: <c> and <c r=..> match, <col> and <cols> do not.
    if (!(after === 62 || after === 47 || after === 32 || after === 9 || after === 10 || after === 13)) {
      pos = i + open.length;
      continue;
    }
    const gt = xml.indexOf(">", i);
    if (gt === -1) throw unreadable();
    const attrs = xml.slice(i + open.length, gt);
    if (attrs.endsWith("/")) {
      yield { attrs, inner: "" };
      pos = gt + 1;
      continue;
    }
    const end = xml.indexOf(close, gt + 1);
    if (end === -1) throw unreadable();
    yield { attrs, inner: xml.slice(gt + 1, end) };
    pos = end + close.length;
  }
}

function attr(attrs: string, name: string): string | null {
  // Attribute lists are short (one tag); the pattern is anchored on a delimiter and a literal quote.
  const m = new RegExp(`(?:^|\\s)${name.replace(/[:.]/g, "\\$&")}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? decodeXml(m[1] ?? m[2] ?? "") : null;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function codePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
}

function decodeXml(s: string): string {
  if (!s.includes("&") && !s.includes("_x")) return s;
  return s
    .replace(/&(?:#x([0-9a-fA-F]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos));/g, (_m, hex?: string, dec?: string, named?: string) =>
      named ? NAMED_ENTITIES[named]! : codePoint(hex ? parseInt(hex, 16) : parseInt(dec!, 10)),
    )
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => codePoint(parseInt(hex, 16))); // OOXML escape, e.g. _x000D_
}

/** Text of all <t> elements of a string item (rich text runs joined; phonetic hints skipped). */
function itemText(inner: string): string {
  let s = inner;
  while (s.includes("<rPh")) {
    const a = s.indexOf("<rPh");
    const b = s.indexOf("</rPh>", a);
    if (b === -1) throw unreadable();
    s = s.slice(0, a) + s.slice(b + 6);
  }
  let out = "";
  for (const t of elements(s, "t")) out += decodeXml(t.inner);
  return out;
}

function columnIndex(ref: string): number | null {
  const m = /^([A-Za-z]{1,3})\d*$/.exec(ref);
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]!.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function unzipNeeded(bytes: Uint8Array): Record<string, Uint8Array> {
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw unreadable(); // "PK"
  // Pass 1 inflates nothing: it only adds up what the archive DECLARES it will expand to.
  let total = 0;
  unzipSync(bytes, {
    filter: (f) => {
      total += f.originalSize;
      if (f.originalSize > MAX_IMPORT_UNCOMPRESSED_BYTES || total > MAX_IMPORT_UNCOMPRESSED_BYTES) {
        throw new RuleError("IMPORT_TOO_LARGE");
      }
      return false;
    },
  });
  const wanted = (n: string) =>
    n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || n === "xl/sharedStrings.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(n);
  return unzipSync(bytes, { filter: (f) => wanted(f.name) });
}

function readXlsx(bytes: Uint8Array): { cells: string[][]; numeric: Set<string> } {
  const files = unzipNeeded(bytes);
  const text = (n: string): string | null => (files[n] ? strFromU8(files[n]) : null);

  // The first sheet of the workbook (through its relationship), else the conventional sheet1.xml.
  let sheetPath = "xl/worksheets/sheet1.xml";
  const workbook = text("xl/workbook.xml");
  const rels = text("xl/_rels/workbook.xml.rels");
  if (workbook && rels) {
    const first = elements(workbook, "sheet").next();
    const rid = first.done ? null : attr(first.value.attrs, "r:id");
    if (rid) {
      for (const rel of elements(rels, "Relationship")) {
        if (attr(rel.attrs, "Id") === rid) {
          const target = attr(rel.attrs, "Target");
          if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
          break;
        }
      }
    }
  }
  const sheet = text(sheetPath);
  if (sheet === null) throw unreadable();

  const sharedXml = text("xl/sharedStrings.xml");
  const shared: string[] = [];
  if (sharedXml) for (const si of elements(sharedXml, "si")) shared.push(itemText(si.inner));

  const byRow = new Map<number, Map<number, string>>();
  const numericAt = new Map<number, Set<number>>();
  let lastRow = 0;
  for (const rowEl of elements(sheet, "row")) {
    const rAttr = Number(attr(rowEl.attrs, "r"));
    const rowIdx = Number.isInteger(rAttr) && rAttr >= 1 ? rAttr : lastRow + 1;
    lastRow = rowIdx;
    let lastCol = -1;
    for (const c of elements(rowEl.inner, "c")) {
      const ref = attr(c.attrs, "r");
      const col = (ref ? columnIndex(ref) : null) ?? lastCol + 1;
      lastCol = col;
      if (col >= MAX_COLUMNS) throw unreadable();
      const type = attr(c.attrs, "t");
      const v = elements(c.inner, "v").next();
      const vText = v.done ? "" : decodeXml(v.value.inner);
      let value: string;
      let isNumber = false;
      if (type === "s") value = shared[Number(vText)] ?? "";
      else if (type === "inlineStr") {
        const is = elements(c.inner, "is").next();
        value = is.done ? "" : itemText(is.value.inner);
      } else if (type === "str" || type === "d") value = vText;
      else if (type === "b") value = vText === "1" ? "TRUE" : "FALSE";
      else if (type === "e") value = "";
      else {
        value = vText.trim();
        isNumber = value !== "";
      }
      if (value === "") continue;
      let cols = byRow.get(rowIdx);
      if (!cols) byRow.set(rowIdx, (cols = new Map()));
      cols.set(col, value);
      if (isNumber) {
        let set = numericAt.get(rowIdx);
        if (!set) numericAt.set(rowIdx, (set = new Set()));
        set.add(col);
      }
    }
  }

  // Row numbers are bounded before anything dense is built (a cell at row 1,000,000 must not allocate).
  const rowNumbers = [...byRow.keys()].sort((a, b) => a - b);
  if (rowNumbers.length === 0) return { cells: [], numeric: new Set() };
  const headerRow = rowNumbers[0]!;
  const lastDataRow = rowNumbers[rowNumbers.length - 1]!;
  if (lastDataRow - headerRow > MAX_IMPORT_ROWS + 1_000) throw new RuleError("IMPORT_TOO_MANY_ROWS");

  const width = Math.max(...byRow.get(headerRow)!.keys()) + 1;
  const cells: string[][] = [];
  const numeric = new Set<string>();
  for (let r = headerRow; r <= lastDataRow; r++) {
    const cols = byRow.get(r);
    const maxCol = cols ? Math.max(...cols.keys()) + 1 : 0;
    const out = new Array<string>(Math.max(width, maxCol)).fill("");
    if (cols) for (const [c, v] of cols) out[c] = v;
    cells.push(out);
    if (r > headerRow) for (const c of numericAt.get(r) ?? []) numeric.add(`${r - headerRow}:${c}`);
  }
  return { cells, numeric };
}
