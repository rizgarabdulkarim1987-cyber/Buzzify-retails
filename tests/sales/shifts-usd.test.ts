import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSale } from "@/server/sales/sales";
import { closeShift, openShift, setShiftRate, shiftSummary } from "@/server/sales/shifts";
import { postStockDocument, saveStockDraft } from "@/server/stock/documents";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

const { db } = useTestDb();

const DAY = 86_400_000;
const RATE = 1450_000000n;
const key = () => randomUUID();

/** An active business that takes dollars (USD enabled), Main branch, an owner, a manager, a cashier, and one 29,250 dinar item in stock. */
async function shop(usdEnabled = true) {
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
  await db.rtBusiness.update({ where: { id: businessId }, data: { status: "ACTIVE", enabledCurrencies: usdEnabled ? ["IQD", "USD"] : ["IQD"] } });
  await db.rtSubscription.create({
    data: { businessId, planCode: "basic", status: "ACTIVE", currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 30 * DAY) },
  });
  const location = await db.rtLocation.create({ data: { businessId, branchId: w.branches.Main!.id, name: "المخزن" } });
  const list = await db.rtPriceList.create({ data: { businessId, name: "الأسعار", kind: "DEFAULT" } });
  const as = (who: string, k = key()) => ({ userId: w.staff[who]!.user.id, businessId, idempotencyKey: k });
  const product = await db.rtProduct.create({ data: { businessId, nameAr: "حليب" } });
  const variant = await db.rtVariant.create({ data: { businessId, productId: product.id, sku: "S-1" } });
  const piece = await db.rtUnit.create({ data: { businessId, variantId: variant.id, name: "حبة", factor: 1, isBase: true } });
  await db.rtPrice.create({ data: { businessId, unitId: piece.id, priceListId: list.id, currency: "IQD", amountMinor: 29_250n, validFrom: new Date(Date.now() - DAY) } });
  const d = await saveStockDraft(
    { kind: "RECEIPT", lines: [{ variantId: variant.id, unitId: piece.id, quantity: "50", cost: { amount: "600", currency: "IQD" } }] },
    as("owner"),
  );
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

const open = (s: Shop, extra: Record<string, unknown> = {}, who = "cashier") =>
  openShift({ branchId: s.branchId, openingCashMinor: 50_000n, ...extra } as never, s.as(who));
const codeOf = async (p: Promise<{ ok: boolean; code?: string }>) => {
  const r = await p;
  return r.ok ? "ok" : r.code;
};
const usd = (usdMinor: bigint, amountMinor: bigint) => ({ method: "CASH", currency: "USD", usdMinor, amountMinor });
const cash = (amountMinor: bigint) => ({ method: "CASH", amountMinor });

describe("opening a shift with dollars", () => {
  it("stores the rate and the opening dollars", async () => {
    const s = await shop();
    const r = await open(s, { openingUsdMinor: 10_000n, usdRateMicro: RATE });
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ usdRateMicro: RATE, openingUsdMinor: 10_000n, countedUsdMinor: null, expectedUsdMinor: null, differenceUsdMinor: null });
  });

  it("without dollars the shift is as before: no rate, zero opening dollars", async () => {
    const s = await shop();
    const r = await open(s);
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ usdRateMicro: null, openingUsdMinor: 0n });
  });

  it("refuses a rate of 0, 99 or 20000, opening dollars without a rate, and a rate when USD is off", async () => {
    const s = await shop();
    for (const bad of [0n, 99_000000n, 20_000_000000n]) {
      expect(await codeOf(open(s, { usdRateMicro: bad }))).toBe("INVALID_INPUT");
    }
    expect(await codeOf(open(s, { openingUsdMinor: 500n }))).toBe("INVALID_INPUT");
    expect(await db.rtShift.count()).toBe(0);
    const off = await shop(false);
    expect(await codeOf(open(off, { usdRateMicro: RATE }))).toBe("INVALID_INPUT");
  });
});

describe("changing the rate", () => {
  it("a cashier cannot; a manager can, the version bumps and the stale one conflicts", async () => {
    const s = await shop();
    const r = await open(s, { usdRateMicro: RATE });
    if (!r.ok) throw new Error(r.code);
    const shift = r.value;
    expect(await codeOf(setShiftRate({ shiftId: shift.id, usdRateMicro: 1500_000000n, expectedVersion: shift.version }, s.as("cashier")))).toBe("FORBIDDEN");
    const m = await setShiftRate({ shiftId: shift.id, usdRateMicro: 1500_000000n, expectedVersion: shift.version }, s.as("manager"));
    if (!m.ok) throw new Error(m.code);
    expect(m.value).toMatchObject({ usdRateMicro: 1500_000000n, version: shift.version + 1 });
    expect(await codeOf(setShiftRate({ shiftId: shift.id, usdRateMicro: 1400_000000n, expectedVersion: shift.version }, s.as("manager")))).toBe("VERSION_CONFLICT");
    expect(await codeOf(setShiftRate({ shiftId: shift.id, usdRateMicro: 0n, expectedVersion: shift.version + 1 }, s.as("manager")))).toBe("INVALID_INPUT");
  });

  it("refused on a closed shift, and when USD is off", async () => {
    const s = await shop();
    const r = await open(s, { usdRateMicro: RATE });
    if (!r.ok) throw new Error(r.code);
    const c = await closeShift({ shiftId: r.value.id, countedCashMinor: 50_000n, countedUsdMinor: 0n, expectedVersion: r.value.version }, s.as("cashier"));
    if (!c.ok) throw new Error(c.code);
    expect(await codeOf(setShiftRate({ shiftId: r.value.id, usdRateMicro: 1500_000000n, expectedVersion: c.value.shift.version }, s.as("manager")))).toBe("SHIFT_NOT_OPEN");
  });
});

describe("closing with two drawers", () => {
  it("expected dollars = opening + dollars taken; the dinar drawer is net of change given for a dollar sale", async () => {
    const s = await shop();
    const r = await open(s, { openingUsdMinor: 10_000n, usdRateMicro: RATE });
    if (!r.ok) throw new Error(r.code);
    const shift = r.value;
    // A: 50 dollars for 29,250: 72,500 handed over, 43,250 change from the dinar drawer.
    expect((await s.sell([usd(5000n, 72_500n)])).ok).toBe(true);
    // B: dinars only, 30,000 for 29,250: change 750.
    expect((await s.sell([cash(30_000n)])).ok).toBe(true);
    // C: 10 dollars + 15,000 dinars: exact 29,500? 14,500 + 15,000 = 29,500, change 250 off the dinar row.
    expect((await s.sell([usd(1000n, 14_500n), cash(15_000n)])).ok).toBe(true);

    const sum = await shiftSummary({ shiftId: shift.id }, s.as("cashier"));
    if (!sum.ok) throw new Error(sum.code);
    // dinar drawer: -43,250 (change A) + 29,250 (B kept) + 14,750 (C IQD kept) = 750
    expect(sum.value).toMatchObject({
      salesCount: 3,
      totalMinor: 87_750n,
      cashMinor: 750n,
      cardMinor: 0n,
      usdTenderedMinor: 6000n,
      usdDinarMinor: 87_000n,
      expectedCashMinor: 50_750n,
      expectedUsdMinor: 16_000n,
    });
    // Every dinar of the sales is in exactly one of the three: drawer movement, dollars (dinar value), card.
    expect(sum.value.cashMinor + sum.value.usdDinarMinor + sum.value.cardMinor).toBe(sum.value.totalMinor);

    const c = await closeShift({ shiftId: shift.id, countedCashMinor: 50_700n, countedUsdMinor: 15_900n, expectedVersion: shift.version }, s.as("cashier"));
    if (!c.ok) throw new Error(c.code);
    expect(c.value).toMatchObject({ expectedCashMinor: 50_750n, differenceMinor: -50n, expectedUsdMinor: 16_000n, differenceUsdMinor: -100n });
    const row = await db.rtShift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(row).toMatchObject({ status: "CLOSED", countedUsdMinor: 15_900n, expectedUsdMinor: 16_000n, differenceUsdMinor: -100n, differenceMinor: -50n });
  });

  it("the dollars counted are required when the shift has a rate, and refused when it has none", async () => {
    const s = await shop();
    const r = await open(s, { usdRateMicro: RATE });
    if (!r.ok) throw new Error(r.code);
    expect(await codeOf(closeShift({ shiftId: r.value.id, countedCashMinor: 50_000n, expectedVersion: r.value.version }, s.as("cashier")))).toBe("INVALID_INPUT");
    const plain = await shop();
    const p = await open(plain);
    if (!p.ok) throw new Error(p.code);
    expect(await codeOf(closeShift({ shiftId: p.value.id, countedCashMinor: 50_000n, countedUsdMinor: 0n, expectedVersion: p.value.version }, plain.as("cashier")))).toBe("INVALID_INPUT");
  });

  it("a shift that never had a rate closes exactly as before, with the dollar fields null", async () => {
    const s = await shop();
    const r = await open(s);
    if (!r.ok) throw new Error(r.code);
    expect((await s.sell([cash(30_000n)])).ok).toBe(true);
    const c = await closeShift({ shiftId: r.value.id, countedCashMinor: 79_250n, expectedVersion: r.value.version }, s.as("cashier"));
    if (!c.ok) throw new Error(c.code);
    expect(c.value).toMatchObject({ expectedCashMinor: 79_250n, differenceMinor: 0n });
    expect(c.value.shift).toMatchObject({ expectedUsdMinor: null, countedUsdMinor: null, differenceUsdMinor: null });
    const row = await db.rtShift.findUniqueOrThrow({ where: { id: r.value.id } });
    expect(row).toMatchObject({ countedUsdMinor: null, expectedUsdMinor: null, differenceUsdMinor: null });
  });
});
