import { describe, expect, it } from "vitest";
import {
  MAX_BASE_QTY,
  QTY_SCALE,
  STOCK_REASONS,
  convertMinor,
  expiryStatus,
  lineValueMinor,
  parseRate,
  reduceValue,
  splitIntoUnits,
  toBaseQty,
  unitCostMinor,
} from "@/server/domain/stock";
import { RuleError } from "@/server/framework/errors";

const piece = { factor: 1, quantityScale: 0 };
const carton = { factor: 24, quantityScale: 0 };
const kilo = { factor: 1, quantityScale: 3 };

describe("stock domain", () => {
  it("exposes the constants", () => {
    expect(QTY_SCALE).toBe(1000n);
    expect(MAX_BASE_QTY).toBe(10n ** 15n);
    expect([...STOCK_REASONS]).toEqual(["DAMAGED", "EXPIRED", "LOST", "COUNT_FIX", "OTHER"]);
  });

  it("toBaseQty converts cartons and kilos exactly and rejects extra decimals, zero and negatives", () => {
    expect(toBaseQty("2", carton)).toBe(48_000n);
    expect(toBaseQty("1.5", kilo)).toBe(1_500n);
    expect(toBaseQty("0.001", kilo)).toBe(1n);
    expect(toBaseQty("٣", piece)).toBe(3_000n);
    expect(() => toBaseQty("1.5", piece)).toThrow(RuleError);
    expect(() => toBaseQty("1.0001", kilo)).toThrow(RuleError);
    expect(() => toBaseQty("0", piece)).toThrow(RuleError);
    expect(() => toBaseQty("0.000", kilo)).toThrow(RuleError);
    expect(() => toBaseQty("-1", piece)).toThrow(RuleError);
    expect(() => toBaseQty("abc", piece)).toThrow(RuleError);
    expect(() => toBaseQty("", piece)).toThrow(RuleError);
    expect(toBaseQty("1000000000000", piece)).toBe(MAX_BASE_QTY);
    expect(() => toBaseQty("1000000000001", piece)).toThrow(RuleError);
    expect(() => toBaseQty("99999999999999999999999", carton)).toThrow(RuleError);
  });

  it("splitIntoUnits shows 2 cartons and 5 pieces for 53 pieces of a 24 carton", () => {
    const units = [
      { name: "piece", factor: 1 },
      { name: "carton", factor: 24 },
    ];
    expect(splitIntoUnits(53_000n, units)).toEqual([
      { name: "carton", count: 2n },
      { name: "piece", count: 5n },
    ]);
    expect(splitIntoUnits(48_000n, units)).toEqual([{ name: "carton", count: 2n }]);
    expect(splitIntoUnits(0n, units)).toEqual([]);
  });

  it("parseRate reads IQD per USD as an integer times 10^6", () => {
    expect(parseRate("1310")).toBe(1_310_000_000n);
    expect(parseRate("1,310.5")).toBe(1_310_500_000n);
    expect(parseRate("١٣١٠")).toBe(1_310_000_000n);
    expect(() => parseRate("0")).toThrow(RuleError);
    expect(() => parseRate("1.1234567")).toThrow(RuleError);
    expect(() => parseRate("x")).toThrow(RuleError);
  });

  it("convertMinor rounds half up in both directions between IQD and USD", () => {
    const rate = parseRate("1500"); // 1 USD = 1500 IQD
    expect(convertMinor(750n, "IQD", "USD", rate)).toBe(50n); // 0.50 USD
    expect(convertMinor(7n, "IQD", "USD", rate)).toBe(0n); // 0.4667 cent
    expect(convertMinor(8n, "IQD", "USD", rate)).toBe(1n); // 0.533 cent
    expect(convertMinor(15n, "IQD", "USD", parseRate("3000"))).toBe(1n); // exactly 0.5 cent
    expect(convertMinor(1n, "USD", "IQD", rate)).toBe(15n); // 1 cent = 15 IQD
    expect(convertMinor(1n, "USD", "IQD", parseRate("1550"))).toBe(16n); // 15.5 -> 16
    expect(convertMinor(1n, "USD", "IQD", parseRate("1549"))).toBe(15n); // 15.49 -> 15
    expect(convertMinor(5n, "IQD", "IQD", null)).toBe(5n);
    expect(convertMinor(5n, "USD", "USD", null)).toBe(5n);
  });

  it("convertMinor refuses different currencies without a rate", () => {
    expect(() => convertMinor(5n, "IQD", "USD", null)).toThrow(RuleError);
    try {
      convertMinor(5n, "USD", "IQD", null);
      expect.unreachable();
    } catch (e) {
      expect((e as RuleError).code).toBe("INVALID_INPUT");
    }
  });

  it("lineValueMinor multiplies the unit cost by the typed quantity, half up", () => {
    expect(lineValueMinor(1_000n, "3", piece)).toBe(3_000n);
    expect(lineValueMinor(1_000n, "1.5", kilo)).toBe(1_500n);
    expect(lineValueMinor(1n, "0.5", kilo)).toBe(1n); // 0.5 -> 1
    expect(lineValueMinor(1n, "0.499", kilo)).toBe(0n);
  });

  it("unitCostMinor gives the cost of one unit of the given factor", () => {
    expect(unitCostMinor(10_000n, 5_000n, 1)).toBe(500n); // 10 pieces worth 5000
    expect(unitCostMinor(10_000n, 5_000n, 24)).toBe(12_000n);
    expect(unitCostMinor(3_000n, 100n, 1)).toBe(33n);
    expect(unitCostMinor(0n, 0n, 1)).toBe(0n);
  });

  it("reduceValue spends exactly the whole value across 1000 small outflows", () => {
    let qty = 1_000_000n;
    let value = 1_234_567n;
    let spent = 0n;
    for (let i = 0; i < 1000; i++) {
      const out = 1_000n;
      const v = reduceValue(qty, value, out);
      spent += v;
      qty -= out;
      value -= v;
    }
    expect(qty).toBe(0n);
    expect(value).toBe(0n);
    expect(spent).toBe(1_234_567n);
    expect(reduceValue(5_000n, 777n, 5_000n)).toBe(777n);
    expect(reduceValue(3_000n, 10n, 1_000n)).toBe(3n);
    expect(() => reduceValue(1_000n, 10n, 2_000n)).toThrow(RuleError);
  });

  it("expiryStatus marks SOON inside alertDays and EXPIRED before today", () => {
    const today = new Date("2026-10-30T10:00:00Z");
    expect(expiryStatus(null, today, 30)).toBe("NONE");
    expect(expiryStatus(new Date("2026-10-29T00:00:00Z"), today, 30)).toBe("EXPIRED");
    expect(expiryStatus(new Date("2026-10-30T00:00:00Z"), today, 30)).toBe("SOON");
    expect(expiryStatus(new Date("2026-11-29T00:00:00Z"), today, 30)).toBe("SOON");
    expect(expiryStatus(new Date("2026-11-30T00:00:00Z"), today, 30)).toBe("OK");
  });
});
