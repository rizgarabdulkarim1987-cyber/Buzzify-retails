import { describe, expect, it } from "vitest";
import { can } from "@/server/domain/permissions";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff } from "../helpers/fixtures";

const { db } = useTestDb();

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return JSON.stringify(e, Object.getOwnPropertyNames(e));
  }
  throw new Error("expected the database to refuse this write");
}

async function world() {
  const { business, branches } = await createBusinessWithStaff(db);
  const where = { businessId: business.id, branchId: branches.Main!.id };
  const location = await db.rtLocation.create({ data: { ...where, name: "المخزن" } });
  const shift = await db.rtShift.create({ data: { ...where, locationId: location.id, openedById: "u1", currency: "IQD", openingCashMinor: 0n } });
  let n = 0;
  const expense = (extra: Record<string, unknown> = {}) =>
    db.rtExpense.create({
      data: { ...where, shiftId: shift.id, categoryKey: "SUPPLIES", amountMinor: 5000n, currency: "IQD", expenseKey: `k${++n}`, createdById: "u1", ...extra } as never,
    });
  return { business, shift, where, expense };
}

describe("drawer expenses schema", () => {
  it("accepts a valid row", async () => {
    const w = await world();
    const e = await w.expense();
    expect(e).toMatchObject({ amountMinor: 5000n, voidedAt: null, voidedById: null, voidReason: null, note: null });
  });

  it("refuses an amount of 0 or less", async () => {
    const w = await world();
    expect(await failure(w.expense({ amountMinor: 0n }))).toContain("RtExpense_amount_positive");
    expect(await failure(w.expense({ amountMinor: -5n }))).toContain("RtExpense_amount_positive");
  });

  it("refuses half-set void fields, accepts all three", async () => {
    const w = await world();
    expect(await failure(w.expense({ voidedAt: new Date() }))).toContain("RtExpense_void_together");
    expect(await failure(w.expense({ voidedById: "u2", voidReason: "x" }))).toContain("RtExpense_void_together");
    const e = await w.expense({ voidedAt: new Date(), voidedById: "u2", voidReason: "typo" });
    expect(e.voidReason).toBe("typo");
  });

  it("OTHER needs a non-empty note", async () => {
    const w = await world();
    expect(await failure(w.expense({ categoryKey: "OTHER" }))).toContain("RtExpense_other_note");
    expect(await failure(w.expense({ categoryKey: "OTHER", note: "   " }))).toContain("RtExpense_other_note");
    expect((await w.expense({ categoryKey: "OTHER", note: "ice" })).note).toBe("ice");
  });

  it("refuses a duplicate expenseKey in one business", async () => {
    const w = await world();
    await w.expense({ expenseKey: "same" });
    expect(await failure(w.expense({ expenseKey: "same" }))).toMatch(/Unique constraint|expenseKey/);
  });

  it("expense.create belongs to OWNER, MANAGER, CASHIER", () => {
    expect(can("CASHIER", "expense.create")).toBe(true);
    expect(can("MANAGER", "expense.create")).toBe(true);
    expect(can("OWNER", "expense.create")).toBe(true);
    expect(can("ACCOUNTANT", "expense.create")).toBe(false);
    expect(can("AUDITOR", "expense.create")).toBe(false);
    expect(can("STOCK", "expense.create")).toBe(false);
  });
});
