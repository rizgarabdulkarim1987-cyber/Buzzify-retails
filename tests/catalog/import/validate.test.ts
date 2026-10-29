import { describe, expect, it } from "vitest";
import { autoMapHeaders } from "@/server/catalog/import/mapping";
import {
  IMPORT_LIMITS,
  serializeRowResult,
  validateRows,
  type BusinessCurrencies,
  type ExistingItem,
  type ExistingIndex,
} from "@/server/catalog/import/validate";
import type { Mapping } from "@/server/catalog/import/mapping";
import { MAX_PRODUCT_NAME_LENGTH, MAX_SKU_LENGTH, MAX_UNIT_NAME_LENGTH } from "@/server/catalog/products";
import { MAX_NAME_LENGTH } from "@/server/catalog/taxonomy";

const HEADERS = ["barcode", "name", "price", "currency", "category", "brand", "nameCkb", "nameEn", "unit", "factor", "sku"];
const mapping: Mapping = {
  barcode: 0, name: 1, price: 2, currency: 3, category: 4, brand: 5, nameCkb: 6, nameEn: 7, unit: 8, factor: 9, sku: 10,
};
const biz: BusinessCurrencies = { default: "IQD", enabled: ["IQD", "USD"] };

/** A row in HEADERS order; omitted trailing cells are empty. */
const row = (...cells: string[]): string[] => HEADERS.map((_, i) => cells[i] ?? "");

function item(over: Partial<ExistingItem> = {}): ExistingItem {
  return {
    variantId: "v1", productId: "p1", archived: false, nameAr: "حليب", nameCkb: null, nameEn: null,
    categoryName: "ألبان", brandName: "المراعي", unitName: "حبة", prices: { IQD: 1500n }, ...over,
  };
}
const index = (entries: Record<string, ExistingItem> = {}): ExistingIndex => new Map(Object.entries(entries));

const run = (rows: string[][], existing: ExistingIndex = index(), m: Mapping = mapping, c = biz, o?: Parameters<typeof validateRows>[4]) =>
  validateRows(rows, m, existing, c, o);

describe("validateRows", () => {
  it("a missing name rejects the row and others stay OK", () => {
    const r = run([row("111", "حليب", "1500"), row("222", "   ", "1500"), row("333", "عصير")]);
    expect(r.map((x) => [x.rowNumber, x.status, x.reason])).toEqual([
      [1, "OK", undefined],
      [2, "REJECTED", "MISSING_NAME"],
      [3, "OK", undefined],
    ]);
  });

  it("prices in Arabic digits and separators parse; negative, fractional dinar and unknown currency are rejected", () => {
    const r = run([
      row("1", "a", "١٬٥٠٠"), // Arabic digits and thousands separator
      row("2", "b", "1,500"),
      row("3", "c", "٢٫٥٠", "USD"), // Arabic decimal separator, dollars
      row("4", "d", "-5"),
      row("5", "e", "1500.5"), // fractional dinar
      row("6", "f", "10", "EUR"), // unknown currency
      row("7", "g", "abc"),
      row("8", "h", "12,34"), // broken grouping
      row("9", "i", "2.555", "USD"), // too many decimals
      row("10", "j", "1500.00"), // zero fraction is fine
      row("11", "k", "10", "usd"), // currency is case-insensitive
      row("12", "l", "1000000000000000000000"), // over the cap
      row("13", "m", "5", "USD"),
    ]);
    expect(r.map((x) => x.reason ?? x.status)).toEqual([
      "OK", "OK", "OK", "NEGATIVE_PRICE", "FRACTIONAL_IQD", "UNKNOWN_CURRENCY", "BAD_PRICE", "BAD_PRICE", "BAD_PRICE",
      "OK", "OK", "PRICE_TOO_LARGE", "OK",
    ]);
    expect(r[0]?.normalized?.price).toEqual({ currency: "IQD", amountMinor: 1500n });
    expect(r[2]?.normalized?.price).toEqual({ currency: "USD", amountMinor: 250n });
    expect(r[12]?.normalized?.price).toEqual({ currency: "USD", amountMinor: 500n });
  });

  it("a currency the business has not enabled is rejected, and a missing currency uses the default", () => {
    const iqdOnly: BusinessCurrencies = { default: "IQD", enabled: ["IQD"] };
    const r = run([row("1", "a", "5", "USD"), row("2", "b", "5")], index(), mapping, iqdOnly);
    expect(r[0]).toMatchObject({ status: "REJECTED", reason: "UNKNOWN_CURRENCY" });
    expect(r[1]?.normalized?.price).toEqual({ currency: "IQD", amountMinor: 5n });
    const usdDefault = run([row("1", "a", "5.5")], index(), mapping, { default: "USD", enabled: ["USD"] });
    expect(usdDefault[0]?.normalized?.price).toEqual({ currency: "USD", amountMinor: 550n });
  });

  it("currency names in Arabic and symbols are understood", () => {
    const r = run([row("1", "a", "5", "دينار"), row("2", "b", "5", "دولار"), row("3", "c", "5", "$"), row("4", "d", "5", "د.ع")]);
    expect(r.map((x) => x.normalized?.price?.currency)).toEqual(["IQD", "USD", "USD", "IQD"]);
  });

  it("a barcode repeated inside the file rejects the later rows", () => {
    const r = run([row("111", "a"), row("222", "b"), row("111", "c"), row("١١١", "d")]);
    expect(r.map((x) => x.reason ?? x.status)).toEqual(["OK", "OK", "DUPLICATE_IN_FILE", "DUPLICATE_IN_FILE"]);
  });

  it("a rejected first row does not claim the barcode", () => {
    const r = run([row("111", ""), row("111", "b")]);
    expect(r.map((x) => x.reason ?? x.status)).toEqual(["MISSING_NAME", "OK"]);
  });

  it("a row whose barcode belongs to an archived product is rejected", () => {
    const r = run([row("111", "a")], index({ "111": item({ archived: true }) }));
    expect(r[0]).toMatchObject({ status: "REJECTED", reason: "ARCHIVED_BARCODE" });
  });

  it("a row matching an existing barcode is CHANGED with a diff, or SKIPPED when identical", () => {
    const existing = index({ "111": item({ nameCkb: "شیر" }) });
    const r = run(
      [
        row("111", "حليب طازج", "2000", "", "ألبان", "المراعي", "شیر"), // name and price changed
        row("111x", "x"),
        row("111", "حليب", "1500", "IQD", "ألبان", "المراعي", "شیر"), // identical
        row("111", "حليب", "", "", "  البان ", "", ""), // category equals after normalization; empty cells are not changes
      ],
      existing,
    );
    expect(r[0]).toMatchObject({ status: "CHANGED", matchedVariantId: "v1" });
    expect(r[0]?.diff).toEqual([
      { field: "name", before: "حليب", after: "حليب طازج" },
      { field: "price.IQD", before: "1500", after: "2000" },
    ]);
    expect(r[1]?.status).toBe("OK");
    // Row 3 repeats barcode 111 from row 1: duplicates are caught before matching.
    expect(r[2]).toMatchObject({ status: "REJECTED", reason: "DUPLICATE_IN_FILE" });

    const alone = run([row("111", "حليب", "1500", "IQD", "ألبان", "المراعي", "شیر")], existing);
    expect(alone[0]).toMatchObject({ status: "SKIPPED", reason: "UNCHANGED", matchedVariantId: "v1" });
    expect(alone[0]?.diff).toBeUndefined();

    const sameCat = run([row("111", "حليب", "", "", "  البان ", "", "")], existing);
    expect(sameCat[0]).toMatchObject({ status: "SKIPPED", reason: "UNCHANGED" }); // category equal after normalization; empty cells are not changes

    const catChange =run([row("111", "حليب", "", "", "عصائر", "ماركة جديدة")], existing);
    expect(catChange[0]?.diff).toEqual([
      { field: "category", before: "ألبان", after: "عصائر" },
      { field: "brand", before: "المراعي", after: "ماركة جديدة" },
    ]);
    const newCurrency = run([row("111", "حليب", "3", "USD")], existing);
    expect(newCurrency[0]?.diff).toEqual([{ field: "price.USD", before: null, after: "300" }]);
  });

  it("a new product row is OK with its parsed values", () => {
    const r = run([row(" ٦٢٢١ ", "  حليب  ", "1500", "", "ألبان", "المراعي", "شیر", "Milk", "علبة", "12", "SKU-1")]);
    expect(r[0]).toMatchObject({ status: "OK" });
    expect(r[0]?.normalized).toMatchObject({
      barcode: "6221", name: "حليب", nameCkb: "شیر", nameEn: "Milk", category: "ألبان", brand: "المراعي",
      unit: "علبة", factor: 12, sku: "SKU-1",
    });
  });

  it("rejects bad barcodes, factors and over-long names", () => {
    const r = run([
      row("bad barcode!", "a"),
      row("", "b"),
      row("1", "c", "", "", "", "", "", "", "", "0"),
      row("2", "d", "", "", "", "", "", "", "", "1.5"),
      row("3", "e", "", "", "", "", "", "", "", "١٢"),
      row("4", "x".repeat(201)),
      row("5", "f", "", "", "x".repeat(121)),
    ]);
    expect(r.map((x) => x.reason ?? x.status)).toEqual([
      "BAD_BARCODE", "MISSING_IDENTIFIER", "BAD_FACTOR", "BAD_FACTOR", "OK", "NAME_TOO_LONG", "NAME_TOO_LONG",
    ]);
    expect(r[4]?.normalized?.factor).toBe(12);
  });

  it("scientific notation and short numeric xlsx barcodes are rejected, plain numeric ones accepted", () => {
    const rows = [row("1.23457E+12", "a"), row("1.2E12", "b"), row("6221234567890", "c"), row("12345", "d"), row("0012345678905", "e"), row("12345", "f")];
    const r = run(rows, index(), mapping, biz, { numericCells: new Set(["3:0", "4:0"]) });
    expect(r.map((x) => x.reason ?? x.status)).toEqual([
      "NUMERIC_BARCODE_LOST_ZEROS", "NUMERIC_BARCODE_LOST_ZEROS", "OK", "NUMERIC_BARCODE_LOST_ZEROS", "OK", "OK",
    ]);
    // Row 6 is a text cell (not in numericCells): a short text barcode is fine.
  });

  it("rows with no sku and no barcode are rejected; sku identifies when the mapping has no barcode", () => {
    const skuOnly: Mapping = { ...autoMapHeaders([]), name: 0, sku: 1 };
    const r = run([["حليب طازج", "S1"], ["عصير", ""], ["شاي", "S1"]], index({ "sku:S1": item() }), skuOnly);
    expect(r.map((x) => x.reason ?? x.status)).toEqual(["CHANGED", "MISSING_IDENTIFIER", "DUPLICATE_IN_FILE"]);
    expect(r[0]).toMatchObject({ matchedVariantId: "v1" });
  });

  it("a completely empty row is skipped silently and still counts as a row number", () => {
    const r = run([row("1", "a"), row(), ["", "", ""], row("2", "b")]);
    expect(r.map((x) => [x.rowNumber, x.status, x.reason])).toEqual([
      [1, "OK", undefined],
      [2, "SKIPPED", "EMPTY_ROW"],
      [3, "SKIPPED", "EMPTY_ROW"],
      [4, "OK", undefined],
    ]);
  });

  it("short rows are padded and the inputs are never mutated", () => {
    const rows = [["1", "a"]];
    const frozen = JSON.stringify(rows);
    const map = Object.freeze({ ...mapping });
    const existing = index({ "9": item() });
    const r = validateRows(Object.freeze(rows.map((x) => Object.freeze(x))), map, existing, biz);
    expect(r[0]?.status).toBe("OK");
    expect(JSON.stringify(rows)).toBe(frozen);
    expect([...existing.keys()]).toEqual(["9"]);
  });

  it("field limits match the catalog actions", () => {
    expect(IMPORT_LIMITS).toEqual({ name: MAX_PRODUCT_NAME_LENGTH, taxonomy: MAX_NAME_LENGTH, unit: MAX_UNIT_NAME_LENGTH, sku: MAX_SKU_LENGTH });
  });

  it("serializeRowResult turns bigint amounts into strings and survives JSON", () => {
    const [res] = run([row("1", "a", "1500")]);
    const ser = serializeRowResult(res!);
    expect(ser.normalized?.price).toEqual({ currency: "IQD", amountMinor: "1500" });
    expect(JSON.parse(JSON.stringify(ser))).toEqual(ser);
  });
});
