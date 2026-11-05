import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSale } from "@/server/sales/sales";
import { listShiftExpenses, recordExpense, shiftExpensesTotal, voidExpense } from "@/server/sales/expenses";
import { openShift } from "@/server/sales/shifts";
import { postStockDocument, saveStockDraft } from "@/server/stock/documents";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

const { db } = useTestDb();

const DAY = 86_400_000;
const key = () => randomUUID();

/** An active business, Main branch, owner, manager, two cashiers, an accountant, one 29,250 dinar item in stock. */
async function shop() {
  if ((await db.rtPlan.count()) === 0) await createPlan(db, { maxBranches: 3 });
  const w = await createBusinessWithStaff(db, {
    branches: ["Main"],
    staff: [
      { key: "owner", role: "OWNER" },
      { key: "manager", role: "MANAGER" },
      { key: "cashier", role: "CASHIER", branches: ["Main"] },
      { key: "cashier2", role: "CASHIER", branches: ["Main"] },
      { key: "accountant", role: "ACCOUNTANT" },
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

const open = async (s: Shop, who = "cashier", openingCashMinor = 50_000n) => {
  const r = await openShift({ branchId: s.branchId, openingCashMinor }, s.as(who));
  if (!r.ok) throw new Error(r.code);
  return r.value;
};
const codeOf = async (p: Promise<{ ok: boolean; code?: string }>) => {
  const r = await p;
  return r.ok ? "ok" : r.code;
};
const spend = (s: Shop, amountMinor: unknown, extra: Record<string, unknown> = {}, who = "cashier", expenseKey = key()) =>
  recordExpense({ expenseKey, categoryKey: "SUPPLIES", amountMinor, ...extra } as never, s.as(who));
const closeRaw = (s: Shop, shiftId: string, who = "cashier") =>
  db.rtShift.update({
    where: { id: shiftId },
    data: { status: "CLOSED", closedAt: new Date(), closedById: s.staff[who]!.user.id, countedCashMinor: 0n, expectedCashMinor: 0n, differenceMinor: 0n },
  });

describe("recordExpense", () => {
  it("records on the seller's open shift, trims the note, audits it", async () => {
    const s = await shop();
    const shift = await open(s);
    const r = await spend(s, 5_000n, { categoryKey: "TRANSPORT", note: "  delivery man " });
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ shiftId: shift.id, categoryKey: "TRANSPORT", amountMinor: 5_000n, note: "delivery man", createdById: s.staff.cashier!.user.id, voidedAt: null, voidReason: null });
    expect(await db.rtAuditLog.count({ where: { businessId: s.businessId, action: "expense.record" } })).toBe(1);
  });

  it("refuses without an open shift", async () => {
    const s = await shop();
    expect(await codeOf(spend(s, 5_000n))).toBe("SHIFT_NOT_OPEN");
  });

  it("refuses 0, a negative, a fraction and a bad category; OTHER needs a note", async () => {
    const s = await shop();
    await open(s);
    for (const bad of [0n, "-5", "1.5", "abc"]) expect(await codeOf(spend(s, bad))).toBe("INVALID_INPUT");
    expect(await codeOf(spend(s, 5_000n, { categoryKey: "NOPE" }))).toBe("INVALID_INPUT");
    expect(await codeOf(spend(s, 5_000n, { categoryKey: "OTHER" }))).toBe("INVALID_INPUT");
    expect(await codeOf(spend(s, 5_000n, { categoryKey: "OTHER", note: "   " }))).toBe("INVALID_INPUT");
    expect(await db.rtExpense.count()).toBe(0);
    expect(await codeOf(spend(s, 5_000n, { categoryKey: "OTHER", note: "ice" }))).toBe("ok");
    expect(await db.rtExpense.count()).toBe(1);
  });

  it("an expense equal to the whole drawer is allowed; one dinar more is refused and nothing is written", async () => {
    const s = await shop();
    await open(s, "cashier", 50_000n);
    expect(await codeOf(spend(s, 50_001n))).toBe("EXPENSE_EXCEEDS_DRAWER");
    expect(await db.rtExpense.count()).toBe(0);
    expect(await codeOf(spend(s, 50_000n))).toBe("ok");
    expect(await db.rtExpense.count()).toBe(1);
    expect(await codeOf(spend(s, 1n))).toBe("EXPENSE_EXCEEDS_DRAWER");
    expect(await db.rtExpense.count()).toBe(1);
  });

  it("the drawer counts the cash the sales took and the expenses already made", async () => {
    const s = await shop();
    await open(s, "cashier", 0n);
    expect(await codeOf(spend(s, 1n))).toBe("EXPENSE_EXCEEDS_DRAWER");
    const sale = await s.sell([{ method: "CASH", amountMinor: 29_250n }]);
    if (!sale.ok) throw new Error(sale.code);
    expect(await codeOf(spend(s, 29_251n))).toBe("EXPENSE_EXCEEDS_DRAWER");
    expect(await codeOf(spend(s, 20_000n))).toBe("ok");
    expect(await codeOf(spend(s, 9_251n))).toBe("EXPENSE_EXCEEDS_DRAWER");
    expect(await codeOf(spend(s, 9_250n))).toBe("ok");
  });

  it("card sales put no cash in the drawer", async () => {
    const s = await shop();
    await open(s, "cashier", 0n);
    const sale = await s.sell([{ method: "CARD", amountMinor: 29_250n }]);
    if (!sale.ok) throw new Error(sale.code);
    expect(await codeOf(spend(s, 1n))).toBe("EXPENSE_EXCEEDS_DRAWER");
  });

  it("a retry with the same expenseKey (two taps on Save) returns the first expense and records one", async () => {
    const s = await shop();
    await open(s);
    const k = key();
    const first = await spend(s, 5_000n, {}, "cashier", k);
    const again = await spend(s, 5_000n, {}, "cashier", k);
    if (!first.ok || !again.ok) throw new Error("expected ok");
    expect(again.value.id).toBe(first.value.id);
    expect(await db.rtExpense.count()).toBe(1);
  });

  it("two parallel saves with one expenseKey record one expense", async () => {
    const s = await shop();
    await open(s);
    const k = key();
    const [a, b] = await Promise.all([spend(s, 5_000n, {}, "cashier", k), spend(s, 5_000n, {}, "cashier", k)]);
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.value.id).toBe(b.value.id);
    expect(await db.rtExpense.count()).toBe(1);
  });

  it("a retry is not refused by the drawer check when the first save emptied the drawer", async () => {
    const s = await shop();
    await open(s, "cashier", 5_000n);
    const k = key();
    expect(await codeOf(spend(s, 5_000n, {}, "cashier", k))).toBe("ok");
    expect(await codeOf(spend(s, 5_000n, {}, "cashier", k))).toBe("ok");
    expect(await db.rtExpense.count()).toBe(1);
  });

  it("another person's expenseKey is not replayed to someone else", async () => {
    const s = await shop();
    await open(s, "cashier");
    await open(s, "cashier2");
    const k = key();
    expect(await codeOf(spend(s, 5_000n, {}, "cashier", k))).toBe("ok");
    expect(await codeOf(spend(s, 5_000n, {}, "cashier2", k))).not.toBe("ok");
    expect(await db.rtExpense.count()).toBe(1);
  });

  it("a closed shift is refused (SHIFT_NOT_OPEN) and a role without expense.create is FORBIDDEN", async () => {
    const s = await shop();
    const shift = await open(s);
    await closeRaw(s, shift.id);
    expect(await codeOf(spend(s, 1_000n))).toBe("SHIFT_NOT_OPEN");
    expect(await codeOf(spend(s, 1_000n, {}, "accountant"))).toBe("FORBIDDEN");
    expect(await db.rtExpense.count()).toBe(0);
  });

  it("an owner and a manager may record on their own shift", async () => {
    const s = await shop();
    await open(s, "manager");
    await open(s, "owner");
    expect(await codeOf(spend(s, 1_000n, {}, "manager"))).toBe("ok");
    expect(await codeOf(spend(s, 1_000n, {}, "owner"))).toBe("ok");
  });

  it("records on one's own shift only: the expense lands on the actor's shift, never another's", async () => {
    const s = await shop();
    const mine = await open(s, "cashier");
    const theirs = await open(s, "cashier2");
    const r = await spend(s, 1_000n, {}, "cashier2");
    if (!r.ok) throw new Error(r.code);
    expect(r.value.shiftId).toBe(theirs.id);
    expect(r.value.shiftId).not.toBe(mine.id);
    // shiftId is not an input: a stray one is refused.
    expect(await codeOf(spend(s, 1_000n, { shiftId: mine.id }, "cashier2"))).toBe("INVALID_INPUT");
  });
});

describe("voidExpense", () => {
  async function withExpense() {
    const s = await shop();
    const shift = await open(s, "cashier");
    const r = await spend(s, 5_000n);
    if (!r.ok) throw new Error(r.code);
    return { s, shift, expense: r.value };
  }

  it("a manager voids with a reason; the row stays and no longer counts", async () => {
    const { s, shift, expense } = await withExpense();
    expect(await db.$transaction((tx) => shiftExpensesTotal(tx, shift.id))).toBe(5_000n);
    const r = await voidExpense({ expenseId: expense.id, reason: "  typo " }, s.as("manager"));
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ id: expense.id, voidReason: "typo" });
    expect(r.value.voidedAt).toBeInstanceOf(Date);
    expect(await db.$transaction((tx) => shiftExpensesTotal(tx, shift.id))).toBe(0n);
    expect(await db.rtExpense.count()).toBe(1);
    expect((await db.rtExpense.findUniqueOrThrow({ where: { id: expense.id } })).voidedById).toBe(s.staff.manager!.user.id);
    expect(await db.rtAuditLog.count({ where: { businessId: s.businessId, action: "expense.void" } })).toBe(1);
  });

  it("voiding frees the drawer cash again", async () => {
    const s = await shop();
    await open(s, "cashier", 10_000n);
    const r = await spend(s, 10_000n);
    if (!r.ok) throw new Error(r.code);
    expect(await codeOf(spend(s, 1n))).toBe("EXPENSE_EXCEEDS_DRAWER");
    await voidExpense({ expenseId: r.value.id, reason: "x" }, s.as("owner"));
    expect(await codeOf(spend(s, 10_000n))).toBe("ok");
  });

  it("a cashier cannot void, not even their own", async () => {
    const { s, expense } = await withExpense();
    expect(await codeOf(voidExpense({ expenseId: expense.id, reason: "oops" }, s.as("cashier")))).toBe("FORBIDDEN");
    expect((await db.rtExpense.findUniqueOrThrow({ where: { id: expense.id } })).voidedAt).toBeNull();
  });

  it("a void needs a reason of 1 to 500 characters", async () => {
    const { s, expense } = await withExpense();
    for (const reason of ["", "   ", "x".repeat(501)]) {
      expect(await codeOf(voidExpense({ expenseId: expense.id, reason }, s.as("manager")))).toBe("INVALID_INPUT");
    }
    expect((await db.rtExpense.findUniqueOrThrow({ where: { id: expense.id } })).voidedAt).toBeNull();
  });

  it("an already voided expense is refused with EXPENSE_VOIDED and nothing changes", async () => {
    const { s, expense } = await withExpense();
    expect(await codeOf(voidExpense({ expenseId: expense.id, reason: "first" }, s.as("manager")))).toBe("ok");
    expect(await codeOf(voidExpense({ expenseId: expense.id, reason: "second" }, s.as("owner")))).toBe("EXPENSE_VOIDED");
    const row = await db.rtExpense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(row.voidReason).toBe("first");
    expect(row.voidedById).toBe(s.staff.manager!.user.id);
  });

  it("a closed shift never changes: no void after the close", async () => {
    const { s, shift, expense } = await withExpense();
    await closeRaw(s, shift.id);
    expect(await codeOf(voidExpense({ expenseId: expense.id, reason: "late" }, s.as("manager")))).toBe("SHIFT_NOT_OPEN");
    expect((await db.rtExpense.findUniqueOrThrow({ where: { id: expense.id } })).voidedAt).toBeNull();
  });

  it("an unknown expense is NOT_FOUND", async () => {
    const s = await shop();
    expect(await codeOf(voidExpense({ expenseId: "nope", reason: "x" }, s.as("manager")))).toBe("NOT_FOUND");
  });
});

describe("listShiftExpenses", () => {
  it("lists the shift's expenses newest first, voided ones included", async () => {
    const s = await shop();
    const shift = await open(s);
    const a = await spend(s, 1_000n);
    const b = await spend(s, 2_000n);
    if (!a.ok || !b.ok) throw new Error("x");
    await voidExpense({ expenseId: a.value.id, reason: "mistake" }, s.as("manager"));
    const r = await listShiftExpenses({ shiftId: shift.id }, s.as("cashier"));
    if (!r.ok) throw new Error(r.code);
    expect(r.value.map((e) => e.id)).toEqual([b.value.id, a.value.id]);
    expect(r.value[1]!.voidedAt).toBeInstanceOf(Date);
  });

  it("a cashier reads only their own shift; a manager reads any in their branches", async () => {
    const s = await shop();
    const mine = await open(s, "cashier");
    const theirs = await open(s, "cashier2");
    expect(await codeOf(listShiftExpenses({ shiftId: theirs.id }, s.as("cashier")))).toBe("FORBIDDEN");
    expect(await codeOf(listShiftExpenses({ shiftId: mine.id }, s.as("cashier")))).toBe("ok");
    expect(await codeOf(listShiftExpenses({ shiftId: theirs.id }, s.as("manager")))).toBe("ok");
    expect(await codeOf(listShiftExpenses({ shiftId: "nope" }, s.as("cashier")))).toBe("NOT_FOUND");
  });

  it("40 expenses in one shift all list", async () => {
    const s = await shop();
    const shift = await open(s, "cashier", 1_000_000n);
    for (let i = 0; i < 40; i++) expect(await codeOf(spend(s, 1_000n))).toBe("ok");
    const r = await listShiftExpenses({ shiftId: shift.id }, s.as("cashier"));
    if (!r.ok) throw new Error(r.code);
    expect(r.value.length).toBe(40);
  }, 120_000);
});
