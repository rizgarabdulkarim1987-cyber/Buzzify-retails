import { describe, expect, it } from "vitest";
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

/** A business with a branch, a location, an open shift and one posted sale (the parent of payments). */
async function world() {
  const { business, branches } = await createBusinessWithStaff(db);
  const branch = branches.Main!;
  const where = { businessId: business.id, branchId: branch.id };
  const location = await db.rtLocation.create({ data: { ...where, name: "المخزن" } });
  const shift = await db.rtShift.create({
    data: { ...where, locationId: location.id, openedById: "u1", currency: "IQD", openingCashMinor: 0n },
  });
  const doc = await db.rtStockDocument.create({
    data: { ...where, locationId: location.id, kind: "SALE", status: "POSTED", number: 1, postedAt: new Date(), postedById: "u1" },
  });
  const sale = await db.rtSale.create({
    data: {
      ...where, locationId: location.id, shiftId: shift.id, stockDocumentId: doc.id, number: 1, saleKey: "k1",
      currency: "IQD", totalMinor: 29000n, paidMinor: 29000n, changeMinor: 0n, lineCount: 1, cashierId: "u1",
    },
  });
  const pay = (extra: Record<string, unknown>) =>
    db.rtPayment.create({
      data: { ...where, saleId: sale.id, shiftId: shift.id, method: "CASH", currency: "IQD", amountMinor: 29000n, tenderedMinor: 29000n, ...extra } as never,
    });
  return { business, shift, where, pay };
}

describe("dollar drawer schema", () => {
  it("existing rows stay valid: a dinar-only shift and payment have no dollar fields", async () => {
    const w = await world();
    expect(w.shift).toMatchObject({ usdRateMicro: null, openingUsdMinor: 0n, countedUsdMinor: null, expectedUsdMinor: null, differenceUsdMinor: null });
    const p = await w.pay({});
    expect(p).toMatchObject({ tenderedCurrency: null, tenderedForeignMinor: null, rateMicro: null });
  });

  it("accepts a USD cash payment with its rate", async () => {
    const w = await world();
    const p = await w.pay({ tenderedCurrency: "USD", tenderedForeignMinor: 2000n, rateMicro: 1450_000000n });
    expect(p.tenderedForeignMinor).toBe(2000n);
  });

  it("refuses a CARD payment carrying dollar fields", async () => {
    const w = await world();
    const text = await failure(w.pay({ method: "CARD", tenderedCurrency: "USD", tenderedForeignMinor: 2000n, rateMicro: 1450_000000n }));
    expect(text).toContain("RtPayment_card_no_foreign");
  });

  it("refuses a USD payment without a rate, or with half the fields", async () => {
    const w = await world();
    expect(await failure(w.pay({ tenderedCurrency: "USD", tenderedForeignMinor: 2000n }))).toContain("RtPayment_foreign_together");
    expect(await failure(w.pay({ rateMicro: 1450_000000n }))).toContain("RtPayment_foreign_together");
    expect(await failure(w.pay({ tenderedForeignMinor: 2000n, rateMicro: 1450_000000n }))).toContain("RtPayment_foreign_together");
  });

  it("refuses a zero rate or zero dollars", async () => {
    const w = await world();
    expect(await failure(w.pay({ tenderedCurrency: "USD", tenderedForeignMinor: 2000n, rateMicro: 0n }))).toContain("RtPayment_foreign_positive");
    expect(await failure(w.pay({ tenderedCurrency: "USD", tenderedForeignMinor: 0n, rateMicro: 1450_000000n }))).toContain("RtPayment_foreign_positive");
  });

  it("refuses a shift with a non-positive rate or negative opening dollars", async () => {
    const w = await world();
    expect(await failure(db.rtShift.update({ where: { id: w.shift.id }, data: { usdRateMicro: 0n } }))).toContain("RtShift_usd_rate_positive");
    expect(await failure(db.rtShift.update({ where: { id: w.shift.id }, data: { openingUsdMinor: -1n } }))).toContain("RtShift_usd_opening_nonneg");
  });

  it("an open shift has no closing dollar fields", async () => {
    const w = await world();
    expect(await failure(db.rtShift.update({ where: { id: w.shift.id }, data: { countedUsdMinor: 100n } }))).toContain("RtShift_usd_closed_fields");
  });

  it("a closed shift: dollar fields all null or all set, and difference = counted - expected", async () => {
    const w = await world();
    const closed = {
      status: "CLOSED" as const, closedAt: new Date(), closedById: "u1",
      countedCashMinor: 0n, expectedCashMinor: 0n, differenceMinor: 0n,
    };
    expect(await failure(db.rtShift.update({ where: { id: w.shift.id }, data: { ...closed, countedUsdMinor: 100n } }))).toContain("RtShift_usd_closed_fields");
    expect(
      await failure(db.rtShift.update({ where: { id: w.shift.id }, data: { ...closed, countedUsdMinor: 100n, expectedUsdMinor: 90n, differenceUsdMinor: 5n } })),
    ).toContain("RtShift_usd_difference");
    const ok = await db.rtShift.update({
      where: { id: w.shift.id },
      data: { ...closed, countedUsdMinor: 100n, expectedUsdMinor: 90n, differenceUsdMinor: 10n },
    });
    expect(ok.differenceUsdMinor).toBe(10n);
  });
});
