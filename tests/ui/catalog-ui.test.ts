import { describe, expect, it } from "vitest";
import { ar } from "@/messages/ar";
import { en } from "@/messages/en";
import { ckb } from "@/messages/ckb";
import { fill, formatMoney, minorToInput, pickName } from "../../src/app/_lib/format";
import { categoryOptions } from "../../src/app/retail/catalog/_lib/categories";
import { failureMessage, isStale, ownerOfBarcode } from "../../src/app/retail/catalog/_lib/failures";
import { ERROR_MESSAGES } from "@/server/framework/errors";

describe("catalog failure messages", () => {
  it("every action error code has a message in all three languages, and UI codes map to catalog strings", () => {
    for (const t of [ar, ckb, en]) {
      for (const code of Object.keys(ERROR_MESSAGES) as (keyof typeof ERROR_MESSAGES)[]) {
        expect(failureMessage(t, { code })).toBe(t.errors[code]);
      }
      expect(failureMessage(t, { code: "BAD_PRICE" })).toBe(t.catalog.entry.badPrice);
      expect(failureMessage(t, { code: "BAD_BARCODE" })).toBe(t.catalog.entry.badBarcode);
      expect(failureMessage(t, { code: "INTERNAL" })).toBe(t.internalError);
    }
  });

  it("a taken barcode names its product in the interface language, and stale codes offer a reload", () => {
    const f = { code: "BARCODE_TAKEN" as const, details: { productId: "p1", productName: "سكر", productNameEn: "Sugar", productNameCkb: null } };
    expect(ownerOfBarcode(f, "en")).toEqual({ productId: "p1", name: "Sugar" });
    expect(ownerOfBarcode(f, "ckb")?.name).toBe("سكر");
    expect(ownerOfBarcode({ code: "SKU_TAKEN" }, "ar")).toBeNull();
    expect(isStale({ code: "VERSION_CONFLICT" })).toBe(true);
    expect(isStale({ code: "UNIT_RULE" })).toBe(false);
  });
});

describe("catalog display helpers", () => {
  it("shows money in the interface digits, exactly", () => {
    expect(formatMoney("ar", "IQD", "1250", "د.ع")).toBe("١٬٢٥٠ د.ع");
    expect(formatMoney("en", "IQD", 1250n, "IQD")).toBe("1,250 IQD");
    expect(formatMoney("en", "USD", "1205", "USD")).toBe("12.05 USD");
    expect(formatMoney("ar", "USD", 5n, "$")).toBe("٠٫٠٥ $");
    expect(formatMoney("en", "IQD", "9007199254740993123", "IQD")).toBe("9,007,199,254,740,993,123 IQD");
    expect(minorToInput("USD", "1250")).toBe("12.50");
    expect(minorToInput("IQD", 1250n)).toBe("1250");
  });

  it("falls back to the Arabic name and fills placeholders", () => {
    const names = { nameAr: "سكر", nameCkb: null, nameEn: "Sugar" };
    expect(pickName("ar", names)).toBe("سكر");
    expect(pickName("ckb", names)).toBe("سكر");
    expect(pickName("en", names)).toBe("Sugar");
    expect(fill("a {x} {y}", { x: 1 })).toBe("a 1 {y}");
  });

  it("lists categories depth first with their path, once each, even with an orphan or a cycle", () => {
    const row = (id: string, parentId: string | null, nameAr: string) => ({ id, parentId, nameAr, nameCkb: null, nameEn: null });
    const out = categoryOptions("ar", [row("b", "a", "حبوب"), row("a", null, "غذاء"), row("o", "missing", "يتيم"), row("c1", "c2", "x"), row("c2", "c1", "y")]);
    expect(out.map((o) => o.label)).toEqual(["غذاء", "غذاء › حبوب", "يتيم"]);
  });
});

import { baghdadToday, resolveStartDate, wholeNumber } from "../../src/app/retail/catalog/_lib/numbers";

describe("numbers and dates typed in the catalog forms", () => {
  it("reads whole numbers in Arabic-Indic, Persian and ASCII digits", () => {
    expect(wholeNumber("١٢")).toBe(12);
    expect(wholeNumber(" ۲۴ ")).toBe(24);
    expect(wholeNumber("30")).toBe(30);
    for (const bad of ["", "1.5", "-3", "1,000", "abc", "1234567", 5, null]) expect(wholeNumber(bad)).toBeNull();
  });

  it("start dates: empty or today is now, a later day is its Baghdad midnight, the past and garbage are refused", () => {
    const now = new Date("2026-10-29T21:30:00Z"); // already 30 Oct 00:30 in Baghdad
    expect(baghdadToday(now)).toBe("2026-10-30");
    expect(resolveStartDate("", now)).toEqual({ kind: "now" });
    expect(resolveStartDate("2026-10-30", now)).toEqual({ kind: "now" });
    expect(resolveStartDate("2026-10-29", now)).toEqual({ kind: "bad" });
    expect(resolveStartDate("2026-11-01", now)).toEqual({ kind: "at", at: new Date("2026-10-31T21:00:00Z") });
    expect(resolveStartDate("٢٠٢٦-١١-٠١", now)).toEqual({ kind: "at", at: new Date("2026-10-31T21:00:00Z") });
    for (const bad of ["2026-02-30", "tomorrow", "1/2/2026", "2026-13-01"]) expect(resolveStartDate(bad, now)).toEqual({ kind: "bad" });
  });
});
