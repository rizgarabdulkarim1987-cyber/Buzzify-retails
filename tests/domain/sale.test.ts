import { describe, expect, it } from "vitest";
import { pickFefo, settlePayments, type StockRow } from "@/server/domain/sale";
import { RuleError } from "@/server/framework/errors";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const TODAY = day("2026-11-03");

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "ok";
  } catch (err) {
    if (err instanceof RuleError) return err.code;
    throw err;
  }
}

describe("settlePayments", () => {
  it("cash with change, card exact, mixed with change from cash only", () => {
    expect(settlePayments(3000n, [{ method: "CASH", amountMinor: 5000n }])).toEqual({
      cashTenderedMinor: 5000n,
      cashKeptMinor: 3000n,
      cardMinor: 0n,
      paidMinor: 5000n,
      changeMinor: 2000n,
    });
    expect(settlePayments(4500n, [{ method: "CARD", amountMinor: 4500n }]).changeMinor).toBe(0n);
    const mixed = settlePayments(15_000n, [
      { method: "CARD", amountMinor: 10_000n },
      { method: "CASH", amountMinor: 10_000n },
    ]);
    expect(mixed).toMatchObject({ cashKeptMinor: 5000n, cardMinor: 10_000n, changeMinor: 5000n });
  });

  it("refuses short, over-card, superfluous cash and non-positive entries", () => {
    expect(codeOf(() => settlePayments(1000n, [{ method: "CASH", amountMinor: 999n }]))).toBe("PAYMENT_SHORT");
    expect(codeOf(() => settlePayments(1000n, []))).toBe("PAYMENT_SHORT");
    expect(codeOf(() => settlePayments(1000n, [{ method: "CARD", amountMinor: 1001n }]))).toBe("PAYMENT_RULE");
    expect(codeOf(() => settlePayments(1000n, [{ method: "CARD", amountMinor: 1000n }, { method: "CASH", amountMinor: 500n }]))).toBe("PAYMENT_RULE");
    expect(codeOf(() => settlePayments(1000n, [{ method: "CASH", amountMinor: 0n }]))).toBe("INVALID_INPUT");
    expect(settlePayments(0n, []).paidMinor).toBe(0n);
  });
});

describe("pickFefo", () => {
  const rows: StockRow[] = [
    { batchId: null, qty: 4000n, expiryDate: null, createdAt: null },
    { batchId: "late", qty: 3000n, expiryDate: day("2026-12-20"), createdAt: day("2026-10-01") },
    { batchId: "nodate", qty: 1000n, expiryDate: null, createdAt: day("2026-09-01") },
    { batchId: "soon", qty: 2000n, expiryDate: day("2026-11-10"), createdAt: day("2026-10-05") },
    { batchId: "old", qty: 9000n, expiryDate: day("2026-11-02"), createdAt: day("2026-08-01") },
    { batchId: "today", qty: 500n, expiryDate: day("2026-11-03"), createdAt: day("2026-08-01") },
  ];

  it("takes the earliest expiry first (today still sells), then undated batches, then the no-batch row", () => {
    expect(pickFefo(rows, 6000n, TODAY, 1)).toEqual([
      { batchId: "today", qty: 500n },
      { batchId: "soon", qty: 2000n },
      { batchId: "late", qty: 3000n },
      { batchId: "nodate", qty: 500n },
    ]);
    expect(pickFefo(rows, 10_500n, TODAY, 1).at(-1)).toEqual({ batchId: null, qty: 4000n });
  });

  it("never takes an expired batch: STOCK_EXPIRED when only expired stock would cover it, STOCK_NEGATIVE beyond everything", () => {
    expect(codeOf(() => pickFefo(rows, 11_000n, TODAY, 2))).toBe("STOCK_EXPIRED");
    expect(codeOf(() => pickFefo(rows, 20_000n, TODAY, 2))).toBe("STOCK_NEGATIVE");
    expect(codeOf(() => pickFefo([], 1n, TODAY, 2))).toBe("STOCK_NEGATIVE");
    try {
      pickFefo(rows, 11_000n, TODAY, 7);
    } catch (err) {
      expect((err as RuleError).details).toEqual({ lineNo: "7" });
    }
  });
});
