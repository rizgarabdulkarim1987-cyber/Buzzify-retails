import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseImportFile } from "@/server/catalog/import/parse";
import { RuleError } from "@/server/framework/errors";
import { buildXlsx } from "./xlsx-fixture";

const csv = (text: string) => strToU8(text);

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof RuleError) return e.code;
    throw e;
  }
  throw new Error("expected a RuleError");
}

/** Windows-1256 bytes for a text: the reverse of what TextDecoder("windows-1256") does. */
function win1256(text: string): Uint8Array {
  const dec = new TextDecoder("windows-1256");
  const reverse = new Map<string, number>();
  for (let b = 0; b < 256; b++) reverse.set(dec.decode(Uint8Array.of(b)), b);
  return Uint8Array.from([...text].map((ch) => {
    const b = reverse.get(ch);
    if (b === undefined) throw new Error(`no windows-1256 byte for ${ch}`);
    return b;
  }));
}

describe("parseImportFile: csv", () => {
  it("a UTF-8 CSV with BOM keeps Arabic names", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...csv("الباركود,الاسم,السعر\n6221,حليب المراعي,١٬٥٠٠\n")]);
    const r = parseImportFile(bytes, "items.csv");
    expect(r.headers).toEqual(["الباركود", "الاسم", "السعر"]);
    expect(r.rows).toEqual([["6221", "حليب المراعي", "١٬٥٠٠"]]);
  });

  it("a UTF-8 CSV without BOM parses the same", () => {
    expect(parseImportFile(csv("a,b\n1,2"), "x.csv")).toMatchObject({ headers: ["a", "b"], rows: [["1", "2"]] });
  });

  it("a Windows-1256 CSV is detected and decoded", () => {
    const bytes = win1256("الباركود,الاسم\n1,حليب\n2,عصير\n");
    const r = parseImportFile(bytes, "old.csv");
    expect(r.headers).toEqual(["الباركود", "الاسم"]);
    expect(r.rows).toEqual([["1", "حليب"], ["2", "عصير"]]);
  });

  it("detects semicolon and tab delimiters and an Excel sep= line", () => {
    expect(parseImportFile(csv("a;b;c\n1;2;3"), "x.csv").rows).toEqual([["1", "2", "3"]]);
    expect(parseImportFile(csv("a\tb\tc\n1\t2\t3"), "x.csv").rows).toEqual([["1", "2", "3"]]);
    expect(parseImportFile(csv("sep=;\na;b\n1;2"), "x.csv")).toMatchObject({ headers: ["a", "b"], rows: [["1", "2"]] });
  });

  it("handles quoted fields with delimiters, doubled quotes and newlines, and CRLF", () => {
    const r = parseImportFile(csv('a,b\r\n"x, y","say ""hi"""\r\n"line1\nline2",z\r\n'), "x.csv");
    expect(r.rows).toEqual([["x, y", 'say "hi"'], ["line1\nline2", "z"]]);
  });

  it("an empty file is unreadable; a header-only file has no rows", () => {
    expect(codeOf(() => parseImportFile(new Uint8Array(), "x.csv"))).toBe("IMPORT_UNREADABLE");
    expect(parseImportFile(csv("a,b\n"), "x.csv")).toMatchObject({ headers: ["a", "b"], rows: [] });
  });

  it("keeps duplicate header names as they are", () => {
    expect(parseImportFile(csv("a,a\n1,2"), "x.csv").headers).toEqual(["a", "a"]);
  });

  it("a text barcode cell keeps its leading zeros (csv)", () => {
    expect(parseImportFile(csv("barcode\n0012345678905"), "x.csv").rows).toEqual([["0012345678905"]]);
  });

  it("refuses unsupported extensions", () => {
    for (const name of ["a.xls", "a.xlsm", "a.pdf", "a", "a.csv.exe"]) {
      expect(codeOf(() => parseImportFile(csv("a\n1"), name)), name).toBe("IMPORT_UNREADABLE");
    }
  });

  it("a zip bomb or an over 5 MB file is refused", () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1).fill(97);
    expect(codeOf(() => parseImportFile(big, "x.csv"))).toBe("IMPORT_TOO_LARGE");
    expect(codeOf(() => parseImportFile(big, "x.xlsx"))).toBe("IMPORT_TOO_LARGE");

    // Tiny on disk, 60 MB when inflated: refused before anything is inflated.
    const sheet = `<?xml version="1.0"?><worksheet><sheetData>${" ".repeat(60 * 1024 * 1024)}</sheetData></worksheet>`;
    const bomb = buildXlsx([["a"]], { sheetXmlOverride: sheet });
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024);
    expect(codeOf(() => parseImportFile(bomb, "bomb.xlsx"))).toBe("IMPORT_TOO_LARGE");

    // Many entries whose declared total is over the cap.
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 6; i++) files[`junk${i}.bin`] = new Uint8Array(10 * 1024 * 1024);
    expect(codeOf(() => parseImportFile(zipSync(files), "many.xlsx"))).toBe("IMPORT_TOO_LARGE");
  });

  it("more than 10000 rows is refused", () => {
    const ok = "a\n" + Array.from({ length: 10000 }, (_, i) => String(i)).join("\n");
    expect(parseImportFile(csv(ok), "x.csv").rows).toHaveLength(10000);
    expect(codeOf(() => parseImportFile(csv(ok + "\n10000"), "x.csv"))).toBe("IMPORT_TOO_MANY_ROWS");
    const xlsxRows = [["a"], ...Array.from({ length: 10001 }, (_, i) => [String(i)])];
    expect(codeOf(() => parseImportFile(buildXlsx(xlsxRows), "x.xlsx"))).toBe("IMPORT_TOO_MANY_ROWS");
  });
});

describe("parseImportFile: xlsx", () => {
  it("reads text cells and keeps Arabic", () => {
    const r = parseImportFile(buildXlsx([["الباركود", "الاسم"], ["6221", "حليب & قشطة"]]), "x.xlsx");
    expect(r.headers).toEqual(["الباركود", "الاسم"]);
    expect(r.rows).toEqual([["6221", "حليب & قشطة"]]);
  });

  it("reads inline strings and fills empty cells", () => {
    const r = parseImportFile(buildXlsx([["a", "b", "c"], ["x", null, "z"]], { inlineStrings: true }), "x.xlsx");
    expect(r.rows).toEqual([["x", "", "z"]]);
  });

  it("a text barcode cell keeps its leading zeros", () => {
    const r = parseImportFile(buildXlsx([["barcode"], ["0012345678905"]]), "x.xlsx");
    expect(r.rows).toEqual([["0012345678905"]]);
    expect(r.numericCells.has("1:0")).toBe(false);
  });

  it("reports numeric cells (scientific notation kept as written) so the validator can judge them", () => {
    const r = parseImportFile(
      buildXlsx([["barcode", "name"], [6221234567890, "x"], ["1.23457E+12", "y"], [{ f: "A2", v: 5 }, "z"], [1.23457e12, "w"]]),
      "x.xlsx",
    );
    expect(r.rows[0]).toEqual(["6221234567890", "x"]);
    expect(r.numericCells.has("1:0")).toBe(true);
    expect(r.numericCells.has("1:1")).toBe(false);
    expect(r.numericCells.has("2:0")).toBe(false); // a text cell
    expect(r.numericCells.has("3:0")).toBe(true); // a numeric formula result
    expect(r.numericCells.has("4:0")).toBe(true);
  });

  it("formulas are never evaluated", () => {
    const r = parseImportFile(buildXlsx([["a", "b", "c"], [{ f: "1+1", v: 5 }, { f: "A2&B2" }, "=1+1"]]), "x.xlsx");
    // The cached value is what the file says (5, not 2); no cached value is empty; text starting with = stays literal text.
    expect(r.rows).toEqual([["5", "", "=1+1"]]);
  });

  it("decodes XML entities in text", () => {
    const r = parseImportFile(buildXlsx([["a"], ["x &amp; y &lt; &#1587; &#x633;"]], { inlineStrings: true }), "x.xlsx");
    // The fixture escapes once more, so the stored text is the literal "x &amp; y ...".
    expect(r.rows[0][0]).toBe("x &amp; y &lt; &#1587; &#x633;");
    const raw = buildXlsx([], {
      sheetXmlOverride: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>a &amp; b &lt; &#1587;&#x633;</t></is></c></row></sheetData></worksheet>`,
    });
    expect(parseImportFile(raw, "x.xlsx").rows[0][0]).toBe("a & b < سس");
  });

  it("a corrupt or non-zip file is unreadable, never a raw library error", () => {
    expect(codeOf(() => parseImportFile(csv("this is not a zip"), "x.xlsx"))).toBe("IMPORT_UNREADABLE");
    const good = buildXlsx([["a"], ["1"]]);
    expect(codeOf(() => parseImportFile(good.slice(0, Math.floor(good.length / 2)), "x.xlsx"))).toBe("IMPORT_UNREADABLE");
    expect(codeOf(() => parseImportFile(zipSync({ "hello.txt": csv("hi") }), "x.xlsx"))).toBe("IMPORT_UNREADABLE");
  });

  it("a forged smaller size in the archive cannot make it inflate past what it declares", () => {
    const sheet = `<?xml version="1.0"?><worksheet><sheetData>${" ".repeat(60 * 1024 * 1024)}</sheetData></worksheet>`;
    const z = buildXlsx([["a"]], { sheetXmlOverride: sheet });
    const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
    for (let i = 0; i < z.length - 30; i++) {
      const sig = dv.getUint32(i, true);
      if (sig === 0x02014b50 && dv.getUint32(i + 24, true) > 50_000_000) dv.setUint32(i + 24, 2000, true);
      if (sig === 0x04034b50 && dv.getUint32(i + 22, true) > 50_000_000) dv.setUint32(i + 22, 2000, true);
    }
    expect(codeOf(() => parseImportFile(z, "forged.xlsx"))).toBe("IMPORT_UNREADABLE");
  });

  it("an unclosed-tag flood does not hang", () => {
    const sheet = `<worksheet><sheetData>${"<row r=\"1\"><c ".repeat(100000)}</sheetData></worksheet>`;
    const t = Date.now();
    codeOf(() => parseImportFile(buildXlsx([], { sheetXmlOverride: sheet }), "x.xlsx"));
    expect(Date.now() - t).toBeLessThan(3000);
  });
});
