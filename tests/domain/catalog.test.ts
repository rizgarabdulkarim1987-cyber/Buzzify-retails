import { describe, expect, it } from "vitest";
import {
  MAX_BARCODE_LENGTH,
  MAX_UNIT_FACTOR,
  assertUnitFactor,
  normalizeBarcode,
  normalizeSearchText,
  parseMoneyText,
  suggestUnitPrice,
} from "@/server/domain/catalog";

describe("catalog domain", () => {
  it("normalizeSearchText folds hamza, taa marbuta, tashkeel, tatweel, Arabic-Indic digits and case", () => {
    expect(normalizeSearchText("أحمد")).toBe(normalizeSearchText("احمد"));
    expect(normalizeSearchText("إسلام")).toBe("اسلام");
    expect(normalizeSearchText("آمن")).toBe("امن");
    expect(normalizeSearchText("مدرسة")).toBe("مدرسه");
    expect(normalizeSearchText("على")).toBe("علي");
    expect(normalizeSearchText("مُحَمَّد")).toBe("محمد");
    expect(normalizeSearchText("محـــمد")).toBe("محمد");
    expect(normalizeSearchText("٣٠٠")).toBe("300");
    expect(normalizeSearchText("۱۲۳۴۵۶۷۸۹۰")).toBe("1234567890");
    expect(normalizeSearchText("  Coca   COLA \n 330ml ")).toBe("coca cola 330ml");
  });

  it("normalizeBarcode keeps leading zeros and converts Arabic-Indic digits", () => {
    expect(normalizeBarcode("  0012345  ")).toBe("0012345");
    expect(normalizeBarcode("٠٠١٢٣")).toBe("00123");
    expect(normalizeBarcode("AB-12.3/4_5")).toBe("AB-12.3/4_5");
  });

  it("normalizeBarcode rejects empty, control characters and over 64 characters", () => {
    expect(MAX_BARCODE_LENGTH).toBe(64);
    expect(() => normalizeBarcode("   ")).toThrow();
    expect(() => normalizeBarcode("")).toThrow();
    expect(() => normalizeBarcode("12\n34")).toThrow();
    expect(() => normalizeBarcode("12\u00003")).toThrow();
    expect(() => normalizeBarcode("12 34")).toThrow();
    expect(() => normalizeBarcode("12#34")).toThrow();
    expect(normalizeBarcode("1".repeat(64))).toHaveLength(64);
    expect(() => normalizeBarcode("1".repeat(65))).toThrow();
  });

  it("parseMoneyText reads Arabic digits, the Arabic decimal and thousands separators", () => {
    expect(parseMoneyText("1,200", "IQD")).toBe(1200n);
    expect(parseMoneyText("١٬٢٠٠", "IQD")).toBe(1200n);
    expect(parseMoneyText("12.5", "USD")).toBe(1250n);
    expect(parseMoneyText("١٢٫٥", "USD")).toBe(1250n);
    expect(parseMoneyText("1,234.56", "USD")).toBe(123456n);
    expect(parseMoneyText("12", "USD")).toBe(1200n);
    expect(parseMoneyText("0.05", "USD")).toBe(5n);
    expect(parseMoneyText("0", "IQD")).toBe(0n);
    expect(parseMoneyText(" 250 ", "IQD")).toBe(250n);
  });

  it("parseMoneyText refuses fractions for IQD and more than 2 decimals for USD, negatives and garbage", () => {
    expect(() => parseMoneyText("1200.5", "IQD")).toThrow();
    expect(() => parseMoneyText("12.345", "USD")).toThrow();
    expect(() => parseMoneyText("-5", "IQD")).toThrow();
    expect(() => parseMoneyText("-5.00", "USD")).toThrow();
    expect(() => parseMoneyText("abc", "IQD")).toThrow();
    expect(() => parseMoneyText("", "IQD")).toThrow();
    expect(() => parseMoneyText("   ", "USD")).toThrow();
    expect(() => parseMoneyText("1.2.3", "USD")).toThrow();
    expect(() => parseMoneyText("12abc", "IQD")).toThrow();
    expect(() => parseMoneyText(".", "USD")).toThrow();
  });

  it("assertUnitFactor accepts only positive integers up to 100000", () => {
    expect(MAX_UNIT_FACTOR).toBe(100_000);
    expect(() => assertUnitFactor(1)).not.toThrow();
    expect(() => assertUnitFactor(100_000)).not.toThrow();
    for (const bad of [0, -1, 1.5, 100_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertUnitFactor(bad)).toThrow();
    }
  });

  it("suggestUnitPrice multiplies exactly in BigInt", () => {
    expect(suggestUnitPrice(250n, 12)).toBe(3000n);
    expect(suggestUnitPrice(9_007_199_254_740_993n, 3)).toBe(27_021_597_764_222_979n);
    expect(suggestUnitPrice(0n, 5)).toBe(0n);
    expect(() => suggestUnitPrice(100n, 0)).toThrow();
  });
});
