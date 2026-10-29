import { strToU8, zipSync } from "fflate";

/** A cell: text, a real number (numeric cell), a formula with its cached value, or empty. */
export type FixtureCell = string | number | null | { f: string; v?: string | number };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function colName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A minimal but structurally real xlsx (shared strings, workbook rels), built in memory. */
export function buildXlsx(
  rows: FixtureCell[][],
  opts: { inlineStrings?: boolean; extraFiles?: Record<string, Uint8Array>; sheetXmlOverride?: string } = {},
): Uint8Array {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const sst = (s: string) => {
    let i = sharedIndex.get(s);
    if (i === undefined) {
      i = shared.length;
      shared.push(s);
      sharedIndex.set(s, i);
    }
    return i;
  };
  const rowXml = rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => {
          const ref = `${colName(c)}${r + 1}`;
          if (cell === null) return "";
          if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
          if (typeof cell === "string") {
            return opts.inlineStrings
              ? `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(cell)}</t></is></c>`
              : `<c r="${ref}" t="s"><v>${sst(cell)}</v></c>`;
          }
          const v = cell.v === undefined ? "" : typeof cell.v === "number" ? `<v>${cell.v}</v>` : `<v>${esc(cell.v)}</v>`;
          const t = typeof cell.v === "string" ? ' t="str"' : "";
          return `<c r="${ref}"${t}><f>${esc(cell.f)}</f>${v}</c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const sheet =
    opts.sheetXmlOverride ??
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
    "xl/sharedStrings.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
        .map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`)
        .join("")}</sst>`,
    ),
    ...opts.extraFiles,
  };
  return zipSync(files);
}
