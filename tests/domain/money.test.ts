import { describe, expect, it } from "vitest";
import { assertCurrency, minorUnitDigits } from "@/server/domain/money";

describe("minorUnitDigits", () => {
  it("IQD has 0 digits and USD has 2", () => {
    expect(minorUnitDigits("IQD")).toBe(0);
    expect(minorUnitDigits("USD")).toBe(2);
  });

  it("assertCurrency accepts known codes and rejects others", () => {
    expect(assertCurrency("USD")).toBe("USD");
    expect(() => assertCurrency("EUR")).toThrow();
  });
});
