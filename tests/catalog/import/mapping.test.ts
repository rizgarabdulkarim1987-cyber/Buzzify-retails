import { describe, expect, it } from "vitest";
import { autoMapHeaders, validateMapping } from "@/server/catalog/import/mapping";

describe("mapping", () => {
  it("auto-maps Arabic headers", () => {
    const m = autoMapHeaders(["الباركود", "اسم المادة", "السعر", "الفئة", "ماركة", "الوحدة", "العملة", "رمز الصنف", "معامل التحويل"]);
    expect(m).toMatchObject({ barcode: 0, name: 1, price: 2, category: 3, brand: 4, unit: 5, currency: 6, sku: 7, factor: 8, nameCkb: null, nameEn: null });
  });

  it("auto-maps Kurdish (Sorani) headers, ignoring Arabic/Persian letter variants", () => {
    const m = autoMapHeaders(["بارکۆد", "ناوی کاڵا", "نرخ", "پۆل", "براند", "یەکە", "دراو"]);
    expect(m).toMatchObject({ barcode: 0, name: 1, price: 2, category: 3, brand: 4, unit: 5, currency: 6 });
  });

  it("auto-maps English headers regardless of case, spacing and punctuation", () => {
    const m = autoMapHeaders(["  Bar_Code ", "ITEM NAME", "Name (EN)", "Price:", "Category", "Brand", "UOM", "Currency", "SKU", "code"]);
    expect(m).toMatchObject({ barcode: 0, name: 1, nameEn: 2, price: 3, category: 4, brand: 5, unit: 6, currency: 7, sku: 8 });
  });

  it("recognizes the Kurdish and English name columns", () => {
    const m = autoMapHeaders(["الاسم", "الاسم بالكردي", "الاسم الإنجليزي"]);
    expect(m).toMatchObject({ name: 0, nameCkb: 1, nameEn: 2 });
  });

  it("with duplicate header names the first column wins and no column is used twice", () => {
    const m = autoMapHeaders(["name", "name", "barcode"]);
    expect(m.name).toBe(0);
    expect(validateMapping(m)).toEqual({ ok: true, problems: [] });
  });

  it("validateMapping requires name and (barcode or sku) and rejects a column used twice", () => {
    const empty = autoMapHeaders(["x"]);
    expect(validateMapping(empty).problems).toEqual(["MISSING_NAME", "MISSING_IDENTIFIER"]);
    expect(validateMapping({ ...empty, name: 0, sku: 1 })).toEqual({ ok: true, problems: [] });
    expect(validateMapping({ ...empty, name: 0, barcode: 1 }).ok).toBe(true);
    expect(validateMapping({ ...empty, name: 0, barcode: 0 }).problems).toEqual(["DUPLICATE_COLUMN"]);
    expect(validateMapping({ ...empty, name: -1, barcode: 1 }).problems).toContain("MISSING_NAME");
  });
});
