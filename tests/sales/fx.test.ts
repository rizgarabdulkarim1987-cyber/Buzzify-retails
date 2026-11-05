import { describe, expect, it } from "vitest";
import { dinarToUsdCentsCeil, usdToDinar, validRateMicro } from "@/server/domain/fx";

describe("usdToDinar", () => {
  it("converts cents at the micro rate", () => {
    expect(usdToDinar(2000n, 1450_000000n)).toBe(29000n);
  });
  it("rounds down to a whole dinar", () => {
    expect(usdToDinar(1n, 1450_000000n)).toBe(14n);
  });
});

describe("dinarToUsdCentsCeil", () => {
  it("is the smallest cents that cover the dinar due", () => {
    const r = 1450_000000n;
    const c = dinarToUsdCentsCeil(29250n, r);
    expect(usdToDinar(c, r)).toBeGreaterThanOrEqual(29250n);
    expect(usdToDinar(c - 1n, r)).toBeLessThan(29250n);
  });
  it("holds for 200 random dinars and rates", () => {
    for (let i = 0; i < 200; i++) {
      const rate = BigInt(100 + Math.floor(Math.random() * 9900)) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000));
      const dinar = BigInt(1 + Math.floor(Math.random() * 5_000_000));
      const c = dinarToUsdCentsCeil(dinar, rate);
      expect(usdToDinar(c, rate)).toBeGreaterThanOrEqual(dinar);
      expect(usdToDinar(c - 1n, rate)).toBeLessThan(dinar);
    }
  });
  it("is zero for nothing due", () => {
    expect(dinarToUsdCentsCeil(0n, 1450_000000n)).toBe(0n);
  });
});

describe("validRateMicro", () => {
  it("refuses zero, negative and absurd rates", () => {
    expect(validRateMicro(0n)).toBe(false);
    expect(validRateMicro(-1n)).toBe(false);
    expect(validRateMicro(99_999999n)).toBe(false);
    expect(validRateMicro(10_000_000001n)).toBe(false);
  });
  it("accepts the bounds and a normal rate", () => {
    expect(validRateMicro(1450_000000n)).toBe(true);
    expect(validRateMicro(100_000000n)).toBe(true);
    expect(validRateMicro(10_000_000000n)).toBe(true);
  });
});
