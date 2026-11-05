import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { recordExpense, voidExpense } from "@/server/sales/expenses";
import { createSale } from "@/server/sales/sales";
import { closeShift, openShift, shiftSummary } from "@/server/sales/shifts";
import { postStockDocument, saveStockDraft } from "@/server/stock/documents";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

const { db } = useTestDb();

const DAY = 86_400_000;
const RATE = 1450_000000n;
const key = () => randomUUID();

/** An active business that takes dollars, Main branch, owner, manager, cashier, one 29,250 dinar item in stock. */
async function shop() {
  if ((await db.rtPlan.count()) === 0) await createPlan(db, { maxBranches: 3 });
  const w = await createBusinessWithStaff(db, {
    branches: ["Main"],
    staff: [
      { key: "owner", role: "OWNER" },
      { key: "manager", role: "MANAGER" },
      { key: "cashier", role: "CASHIER", branches: ["Main"] },
    ],
  });
  const businessId = w.business.id;
  await db.rtBusiness.update({ where: { id: businessId }, data: { status: "ACTIVE", enabledCurrencies: ["IQD", "USD"] } });
  await db.rtSubscription.create({
    data: { businessId, planCode: "basic", status: "ACTIVE", currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 30 * DAY) },
  });
  await db.rtLocation.create({ data: { businessId, branchId: w.branches.Main!.id, name: "المخزن" } });
  const list = await db.rtPriceList.create({ data: { businessId, name: "الأسعار", kind: "DEFAULT" } });
  const as = (who: string, k = key()) => ({ userId: w.staff[who]!.user.id, businessId, idempotencyKey: k });
  const product = await db.rtProduct.create({ data: { businessId, nameAr: "حليب" } });
  const variant = await db.rtVariant.create({ data: { businessId, productId: product.id, sku: "S-1" } });
  const piece = await db.rtUnit.create({ data: { businessId, variantId: variant.id, name: "حبة", factor: 1, isBase: true } });
  await db.rtPrice.create({ data: { businessId, unitId: piece.id, priceListId: list.id, currency: "IQD", amountMinor: 29_250n, validFrom: new Date(Date.now() - DAY) } });
  const d = await saveStockDraft({ kind: "RECEIPT", lines: [{ variantId: variant.id, unitId: piece.id, quantity: "50", cost: { amount: "600", currency: "IQD" } }] }, as("owner"));
  if (!d.ok) throw new Error(d.code);
  const p = await postStockDocument({ documentId: d.value.documentId, expectedVersion: d.value.version }, as("owner"));
  if (!p.ok) throw new Error(p.code);
  const sell = (payments: unknown[], who = "cashier") => {
    const k = key();
    return createSale({ saleKey: k, lines: [{ variantId: variant.id, unitId: piece.id, quantity: "1" }], payments: payments as never }, as(who, k));
  };
  return { ...w, businessId, as, sell, branchId: w.branches.Main!.id };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const open = async (s: Shop, extra: Record<string, unknown> = {}, openingCashMinor = 50_000n) => {
  const r = await openShift({ branchId: s.branchId, openingCashMinor, ...extra } as never, s.as("cashier"));
  if (!r.ok) throw new Error(r.code);
  return r.value;
};
const codeOf = async (p: Promise<{ ok: boolean; code?: string }>) => {
  const r = await p;
  return r.ok ? "ok" : r.code;
};
const spend = (s: Shop, amountMinor: bigint) => recordExpense({ expenseKey: key(), categoryKey: "SUPPLIES", amountMinor }, s.as("cashier"));
const summary = async (s: Shop, shiftId: string) => {
  const r = await shiftSummary({ shiftId }, s.as("cashier"));
  if (!r.ok) throw new Error(r.code);
  return r.value;
};
const cash = (amountMinor: bigint) => ({ method: "CASH", amountMinor });
const usd = (usdMinor: bigint, amountMinor: bigint) => ({ method: "CASH", currency: "USD", usdMinor, amountMinor });

describe("the summary and the close subtract the shift's expenses", () => {
  it("expected cash = opening + cash kept - expenses not voided; a voided expense does not count", async () => {
    const s = await shop();
    const shift = await open(s);
    expect((await s.sell([cash(29_250n)])).ok).toBe(true);
    const a = await spend(s, 10_000n);
    const b = await spend(s, 5_000n);
    if (!a.ok || !b.ok) throw new Error("x");
    expect(await summary(s, shift.id)).toMatchObject({ expensesMinor: 15_000n, cashMinor: 29_250n, expectedCashMinor: 64_250n });
    await voidExpense({ expenseId: b.value.id, reason: "typo" }, s.as("manager"));
    expect(await summary(s, shift.id)).toMatchObject({ expensesMinor: 10_000n, expectedCashMinor: 69_250n });

    const c = await closeShift({ shiftId: shift.id, countedCashMinor: 69_000n, expectedVersion: shift.version }, s.as("cashier"));
    if (!c.ok) throw new Error(c.code);
    expect(c.value).toMatchObject({ expensesMinor: 10_000n, expectedCashMinor: 69_250n, differenceMinor: -250n });
    const row = await db.rtShift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(row).toMatchObject({ status: "CLOSED", expectedCashMinor: 69_250n, differenceMinor: -250n });
    // The closed shift's summary reads the same, and no void is possible any more.
    expect(await summary(s, shift.id)).toMatchObject({ expensesMinor: 10_000n, expectedCashMinor: 69_250n });
    expect(await codeOf(voidExpense({ expenseId: a.value.id, reason: "late" }, s.as("manager")))).toBe("SHIFT_NOT_OPEN");
  });

  it("without expenses the numbers are exactly as before", async () => {
    const s = await shop();
    const shift = await open(s);
    expect((await s.sell([cash(29_250n)])).ok).toBe(true);
    expect(await summary(s, shift.id)).toMatchObject({ expensesMinor: 0n, expectedCashMinor: 79_250n });
    const c = await closeShift({ shiftId: shift.id, countedCashMinor: 79_250n, expectedVersion: shift.version }, s.as("cashier"));
    if (!c.ok) throw new Error(c.code);
    expect(c.value).toMatchObject({ expensesMinor: 0n, expectedCashMinor: 79_250n, differenceMinor: 0n });
  });

  it("a refused or voided expense leaves the close untouched", async () => {
    const s = await shop();
    const shift = await open(s, {}, 1_000n);
    expect(await codeOf(spend(s, 1_001n))).toBe("EXPENSE_EXCEEDS_DRAWER");
    const a = await spend(s, 1_000n);
    if (!a.ok) throw new Error("x");
    await voidExpense({ expenseId: a.value.id, reason: "x" }, s.as("owner"));
    const c = await closeShift({ shiftId: shift.id, countedCashMinor: 1_000n, expectedVersion: shift.version }, s.as("cashier"));
    if (!c.ok) throw new Error(c.code);
    expect(c.value).toMatchObject({ expensesMinor: 0n, expectedCashMinor: 1_000n, differenceMinor: 0n });
  });

  it("dollars and expenses together: the dinar expected subtracts expenses only, the dollar drawer is untouched", async () => {
    const s = await shop();
    const shift = await open(s, { openingUsdMinor: 10_000n, usdRateMicro: RATE });
    // 50 dollars for 29,250: 72,500 handed over, 43,250 change from the dinar drawer: dinar drawer 50,000 - 43,250 = 6,750.
    expect((await s.sell([usd(5000n, 72_500n)])).ok).toBe(true);
    expect(await codeOf(spend(s, 6_751n))).toBe("EXPENSE_EXCEEDS_DRAWER");
    expect(await codeOf(spend(s, 6_000n))).toBe("ok");
    expect(await summary(s, shift.id)).toMatchObject({ expensesMinor: 6_000n, cashMinor: -43_250n, expectedCashMinor: 750n, usdTenderedMinor: 5000n, expectedUsdMinor: 15_000n });
    const c = await closeShift({ shiftId: shift.id, countedCashMinor: 750n, countedUsdMinor: 14_900n, expectedVersion: shift.version }, s.as("cashier"));
    if (!c.ok) throw new Error(c.code);
    expect(c.value).toMatchObject({ expectedCashMinor: 750n, differenceMinor: 0n, expectedUsdMinor: 15_000n, differenceUsdMinor: -100n });
  });

  it("a close and an expense racing never interleave: the closed expected cash holds exactly the expenses that got in", async () => {
    for (let round = 0; round < 4; round++) {
      const s = await shop();
      const shift = await open(s, {}, 50_000n);
      const [c, e] = await Promise.all([
        closeShift({ shiftId: shift.id, countedCashMinor: 50_000n, expectedVersion: shift.version }, s.as("cashier")),
        spend(s, 10_000n),
      ]);
      expect(c.ok).toBe(true);
      const row = await db.rtShift.findUniqueOrThrow({ where: { id: shift.id } });
      const kept = await db.rtExpense.aggregate({ where: { shiftId: shift.id, voidedAt: null }, _sum: { amountMinor: true } });
      expect(row.status).toBe("CLOSED");
      expect(row.expectedCashMinor).toBe(50_000n - (kept._sum.amountMinor ?? 0n));
      if (e.ok) expect(kept._sum.amountMinor).toBe(10_000n);
      else expect(e.code).toBe("SHIFT_NOT_OPEN");
    }
  }, 60_000);
});
