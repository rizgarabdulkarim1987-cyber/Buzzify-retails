import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { Currency, RtShiftStatus } from "@/generated/prisma/enums";
import { money } from "@/server/catalog/price-core";
import { validRateMicro } from "@/server/domain/fx";
import { can } from "@/server/domain/permissions";
import type { Actor } from "@/server/framework/actor";
import { defineAction } from "@/server/framework/action";
import { ForbiddenError, NotFoundError, RuleError, VersionConflictError } from "@/server/framework/errors";
import { updateVersioned } from "@/server/framework/versioned";

/*
 * Cash-desk shifts (R3, spec 9 "الصندوق"). A shift belongs to one person in one branch: it opens
 * with the cash put in the drawer and closes with the cash counted. Every sale is rung up on its
 * seller's own OPEN shift (src/server/sales/sales.ts).
 *
 * - openShift (sale.create: OWNER, MANAGER, CASHIER): the branch must be one the actor reaches
 *   (NOT_FOUND otherwise) and active; the shift sits at that branch's oldest sellable location (its
 *   oldest location when none is marked sellable); a terminal, when named, must be an active one of
 *   that branch (NOT_FOUND). One OPEN shift per person per business: a second is
 *   SHIFT_ALREADY_OPEN (the lock `shift-open:<userId>` serializes two taps; the partial unique index
 *   RtShift_one_open_per_person is the backstop). The currency is the business's default currency.
 * - closeShift (sale.create): one's own shift, or anyone's in one's branches with shift.manage
 *   (OWNER, MANAGER); FORBIDDEN otherwise. Under the lock `shift:<id>` (the same lock every sale
 *   on the shift takes, so a close and a sale never interleave): a CLOSED shift is SHIFT_NOT_OPEN;
 *   expectedVersion must match (VERSION_CONFLICT). expected = opening + the cash its sales took
 *   (cash payments net of change) - its expenses not voided (src/server/sales/expenses.ts);
 *   difference = counted - expected (negative: cash is missing).
 *   A closed shift never changes.
 * - Dollars (spec 2026-11-05): a shift may carry a typed rate (usdRateMicro, IQD per 1 USD x 10^6; 100 to
 *   10,000, only when USD is in the business's enabled currencies) and opening dollars (which need a
 *   rate). setShiftRate (shift.manage, OPEN shift, expectedVersion) changes the rate; a sale stores the
 *   rate it used, so a past sale never changes. The dinar drawer moves by the dinar cash rows' kept
 *   amount and, for a dollar row, by amountMinor - tenderedMinor (minus the change given from the dinar
 *   drawer for it). The dollar drawer = opening dollars + dollars handed over. A shift with a rate
 *   closes with countedUsdMinor (required) and records expected and difference for both drawers; one
 *   without a rate closes exactly as before (countedUsdMinor refused, the dollar fields stay null).
 * - myOpenShift / shiftSummary: reads; the summary counts the shift's sales and sums them by method.
 */

type Tx = Prisma.TransactionClient;

export const shiftLock = (shiftId: string) => `shift:${shiftId}`;
const openLock = (userId: string) => `shift-open:${userId}`;
const MAX_NOTE = 500;

const id = z.string().min(1).max(64);

export type ShiftView = {
  id: string;
  branchId: string;
  locationId: string;
  terminalId: string | null;
  openedById: string;
  status: RtShiftStatus;
  currency: Currency;
  openingCashMinor: bigint;
  /** IQD per 1 USD x 10^6, or null: no dollars at this till. */
  usdRateMicro: bigint | null;
  openingUsdMinor: bigint;
  openedAt: Date;
  closedAt: Date | null;
  countedCashMinor: bigint | null;
  expectedCashMinor: bigint | null;
  differenceMinor: bigint | null;
  countedUsdMinor: bigint | null;
  expectedUsdMinor: bigint | null;
  differenceUsdMinor: bigint | null;
  version: number;
};

export type ShiftSummary = {
  shift: ShiftView;
  salesCount: number;
  /** Sum of the sales' totals. */
  totalMinor: bigint;
  /** What the sales moved in the dinar drawer: dinar cash kept, minus the change given for dollar payments. */
  cashMinor: bigint;
  cardMinor: bigint;
  /** Dollars (USD cents) handed over by the sales. */
  usdTenderedMinor: bigint;
  /** The dinar value of those dollars (sum of the dollar payments' tendered dinars). cashMinor + usdDinarMinor + cardMinor = totalMinor. */
  usdDinarMinor: bigint;
  /** The shift's expenses that are not voided (dinars, paid from the dinar drawer). */
  expensesMinor: bigint;
  /** opening + cashMinor - expensesMinor: what the dinar drawer should hold now (or held at close). */
  expectedCashMinor: bigint;
  /** openingUsdMinor + usdTenderedMinor while the shift has a rate, else null. */
  expectedUsdMinor: bigint | null;
};

const shiftSelect = {
  id: true,
  branchId: true,
  locationId: true,
  terminalId: true,
  openedById: true,
  status: true,
  currency: true,
  openingCashMinor: true,
  usdRateMicro: true,
  openingUsdMinor: true,
  openedAt: true,
  closedAt: true,
  countedCashMinor: true,
  expectedCashMinor: true,
  differenceMinor: true,
  countedUsdMinor: true,
  expectedUsdMinor: true,
  differenceUsdMinor: true,
  version: true,
} as const;

/** The actor's OPEN shift in this business (scoped to the actor's branches), or null. */
export async function openShiftOf(tx: Tx, actor: Actor): Promise<ShiftView | null> {
  return tx.rtShift.findFirst({ where: { openedById: actor.userId, status: "OPEN" }, select: shiftSelect });
}

/** Totals of the shift's sales (count, total) and payments (dinar drawer movement, dollars, card). */
export async function shiftTotals(
  tx: Tx,
  shiftId: string,
): Promise<{ salesCount: number; totalMinor: bigint; cashMinor: bigint; cardMinor: bigint; usdTenderedMinor: bigint; usdDinarMinor: bigint }> {
  const [sales, pays] = await Promise.all([
    tx.rtSale.aggregate({ where: { shiftId }, _count: { _all: true }, _sum: { totalMinor: true } }),
    tx.rtPayment.groupBy({
      by: ["method", "tenderedCurrency"],
      where: { shiftId },
      _sum: { amountMinor: true, tenderedMinor: true, tenderedForeignMinor: true },
    }),
  ]);
  let cashMinor = 0n;
  let cardMinor = 0n;
  let usdTenderedMinor = 0n;
  let usdDinarMinor = 0n;
  for (const p of pays) {
    const amount = p._sum.amountMinor ?? 0n;
    if (p.method === "CARD") cardMinor += amount;
    else if (p.tenderedCurrency === "USD") {
      // Kept - handed over = minus the change given (from the dinar drawer) against this payment.
      const tendered = p._sum.tenderedMinor ?? 0n;
      cashMinor += amount - tendered;
      usdDinarMinor += tendered;
      usdTenderedMinor += p._sum.tenderedForeignMinor ?? 0n;
    } else cashMinor += amount;
  }
  return { salesCount: sales._count._all, totalMinor: sales._sum.totalMinor ?? 0n, cashMinor, cardMinor, usdTenderedMinor, usdDinarMinor };
}

/** The sum of the shift's expenses that are not voided (dinars). */
export async function shiftExpensesTotal(tx: Tx, shiftId: string): Promise<bigint> {
  const sum = await tx.rtExpense.aggregate({ where: { shiftId, voidedAt: null }, _sum: { amountMinor: true } });
  return sum._sum.amountMinor ?? 0n;
}

/**
 * What the dinar drawer holds (or should hold) now: opening + the cash the sales moved - the expenses not
 * voided. The one place this is computed: recording an expense, the summary and the close all use it.
 */
export function expectedDinarMinor(openingCashMinor: bigint, cashMinor: bigint, expensesMinor: bigint): bigint {
  return openingCashMinor + cashMinor - expensesMinor;
}

/** The dinar drawer of an open shift right now (see expectedDinarMinor). */
export async function dinarDrawerNow(tx: Tx, shift: { id: string; openingCashMinor: bigint }): Promise<bigint> {
  const [t, expensesMinor] = await Promise.all([shiftTotals(tx, shift.id), shiftExpensesTotal(tx, shift.id)]);
  return expectedDinarMinor(shift.openingCashMinor, t.cashMinor, expensesMinor);
}

async function summaryOf(tx: Tx, shift: ShiftView): Promise<ShiftSummary> {
  const [t, expensesMinor] = await Promise.all([shiftTotals(tx, shift.id), shiftExpensesTotal(tx, shift.id)]);
  return {
    shift,
    ...t,
    expensesMinor,
    expectedCashMinor: expectedDinarMinor(shift.openingCashMinor, t.cashMinor, expensesMinor),
    expectedUsdMinor: shift.usdRateMicro === null ? null : shift.openingUsdMinor + t.usdTenderedMinor,
  };
}

/** IQD per 1 USD x 10^6: a bigint or a string of digits. Its range is checked by validRateMicro. */
const rateInput = z.union([z.bigint(), z.string().regex(/^\d{1,19}$/).transform((v) => BigInt(v))]);

const openInput = z
  .object({
    branchId: id,
    terminalId: id.nullish().transform((v) => v ?? null),
    openingCashMinor: money,
    openingUsdMinor: money.optional(),
    usdRateMicro: rateInput.optional(),
  })
  .strict();

/** Opens the actor's shift in a branch with the cash in the drawer (see the header). */
export const openShift = defineAction({
  name: "shift.open",
  permission: "sale.create",
  input: openInput,
  writes: true,
  async run({ actor, tx, input, lockBusiness }): Promise<ShiftView> {
    await lockBusiness(openLock(actor.userId));
    const branch = await tx.rtBranch.findFirst({ where: { id: input.branchId, active: true }, select: { id: true } });
    if (!branch) throw new NotFoundError();
    const location =
      (await tx.rtLocation.findFirst({ where: { branchId: branch.id, sellable: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } })) ??
      (await tx.rtLocation.findFirst({ where: { branchId: branch.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } }));
    if (!location) throw new RuleError("STOCK_RULE", { reason: "NO_LOCATION" });
    if (input.terminalId !== null) {
      const terminal = await tx.rtTerminal.findFirst({ where: { id: input.terminalId, branchId: branch.id, active: true }, select: { id: true } });
      if (!terminal) throw new NotFoundError();
    }
    // Seen through the actor's branches only: a shift left open in a branch the actor lost access
    // to is caught by the partial unique index instead (an internal error; a manager closes it).
    if (await openShiftOf(tx, actor)) throw new RuleError("SHIFT_ALREADY_OPEN");
    const biz = await tx.rtBusiness.findFirstOrThrow({ select: { defaultCurrency: true, enabledCurrencies: true } });
    const openingUsdMinor = input.openingUsdMinor ?? 0n;
    if (input.usdRateMicro !== undefined) {
      if (!biz.enabledCurrencies.includes("USD") || !validRateMicro(input.usdRateMicro)) throw new RuleError("INVALID_INPUT");
    } else if (openingUsdMinor > 0n) {
      throw new RuleError("INVALID_INPUT");
    }
    return tx.rtShift.create({
      data: {
        businessId: actor.businessId,
        branchId: branch.id,
        locationId: location.id,
        terminalId: input.terminalId,
        openedById: actor.userId,
        currency: biz.defaultCurrency,
        openingCashMinor: input.openingCashMinor,
        openingUsdMinor,
        usdRateMicro: input.usdRateMicro ?? null,
      },
      select: shiftSelect,
    });
  },
  audit: (input, value) => ({
    entity: "RtShift",
    entityId: value.id,
    changes: {
      branchId: value.branchId,
      terminalId: value.terminalId,
      openingCashMinor: input.openingCashMinor,
      openingUsdMinor: value.openingUsdMinor,
      usdRateMicro: value.usdRateMicro,
    },
  }),
});

const closeInput = z
  .object({
    shiftId: id,
    countedCashMinor: money,
    /** Required when the shift has a dollar rate; refused when it has none. */
    countedUsdMinor: money.optional(),
    note: z
      .string()
      .trim()
      .max(MAX_NOTE)
      .nullish()
      .transform((v) => (v ? v : null)),
    expectedVersion: z.number().int().min(1),
  })
  .strict();

export type ClosedShift = ShiftSummary & { differenceMinor: bigint; differenceUsdMinor: bigint | null };

/** Closes a shift with the counted cash; returns the day summary and the difference (see the header). */
export const closeShift = defineAction({
  name: "shift.close",
  permission: "sale.create",
  input: closeInput,
  writes: true,
  async run({ actor, tx, input, lockBusiness }): Promise<ClosedShift> {
    await lockBusiness(shiftLock(input.shiftId));
    const shift = await tx.rtShift.findFirst({ where: { id: input.shiftId }, select: shiftSelect });
    if (!shift) throw new NotFoundError();
    if (shift.openedById !== actor.userId && !can(actor.role, "shift.manage")) throw new ForbiddenError();
    if (shift.status !== "OPEN") throw new RuleError("SHIFT_NOT_OPEN");
    if (shift.version !== input.expectedVersion) throw new VersionConflictError();
    if ((shift.usdRateMicro !== null) !== (input.countedUsdMinor !== undefined)) {
      throw new RuleError("INVALID_INPUT", { field: "countedUsdMinor" });
    }
    const [t, expensesMinor] = await Promise.all([shiftTotals(tx, shift.id), shiftExpensesTotal(tx, shift.id)]);
    const expectedCashMinor = expectedDinarMinor(shift.openingCashMinor, t.cashMinor, expensesMinor);
    const differenceMinor = input.countedCashMinor - expectedCashMinor;
    const countedUsdMinor = input.countedUsdMinor ?? null;
    const expectedUsdMinor = countedUsdMinor === null ? null : shift.openingUsdMinor + t.usdTenderedMinor;
    const differenceUsdMinor = countedUsdMinor === null ? null : countedUsdMinor - expectedUsdMinor!;
    const closedAt = new Date();
    await updateVersioned(tx.rtShift, { id: shift.id, status: "OPEN" }, input.expectedVersion, {
      status: "CLOSED",
      closedAt,
      closedById: actor.userId,
      countedCashMinor: input.countedCashMinor,
      expectedCashMinor,
      differenceMinor,
      countedUsdMinor,
      expectedUsdMinor,
      differenceUsdMinor,
      closeNote: input.note,
    });
    const closed: ShiftView = {
      ...shift,
      status: "CLOSED",
      closedAt,
      countedCashMinor: input.countedCashMinor,
      expectedCashMinor,
      differenceMinor,
      countedUsdMinor,
      expectedUsdMinor,
      differenceUsdMinor,
      version: shift.version + 1,
    };
    return { shift: closed, ...t, expensesMinor, expectedCashMinor, differenceMinor, expectedUsdMinor, differenceUsdMinor };
  },
  audit: (_input, value) => ({
    entity: "RtShift",
    entityId: value.shift.id,
    changes: {
      countedCashMinor: value.shift.countedCashMinor,
      expectedCashMinor: value.expectedCashMinor,
      differenceMinor: value.differenceMinor,
      countedUsdMinor: value.shift.countedUsdMinor,
      expectedUsdMinor: value.expectedUsdMinor,
      differenceUsdMinor: value.differenceUsdMinor,
      salesCount: value.salesCount,
      expensesMinor: value.expensesMinor,
    },
  }),
});

const rateActionInput = z.object({ shiftId: id, usdRateMicro: rateInput, expectedVersion: z.number().int().min(1) }).strict();

/** Changes the dollar rate of an OPEN shift (shift.manage). Past sales keep the rate they used. */
export const setShiftRate = defineAction({
  name: "shift.rate",
  permission: "shift.manage",
  input: rateActionInput,
  writes: true,
  async run({ tx, input, lockBusiness }): Promise<ShiftView> {
    await lockBusiness(shiftLock(input.shiftId));
    const shift = await tx.rtShift.findFirst({ where: { id: input.shiftId }, select: shiftSelect });
    if (!shift) throw new NotFoundError();
    if (shift.status !== "OPEN") throw new RuleError("SHIFT_NOT_OPEN");
    if (shift.version !== input.expectedVersion) throw new VersionConflictError();
    const biz = await tx.rtBusiness.findFirstOrThrow({ select: { enabledCurrencies: true } });
    if (!biz.enabledCurrencies.includes("USD") || !validRateMicro(input.usdRateMicro)) throw new RuleError("INVALID_INPUT");
    await updateVersioned(tx.rtShift, { id: shift.id, status: "OPEN" }, input.expectedVersion, { usdRateMicro: input.usdRateMicro });
    return { ...shift, usdRateMicro: input.usdRateMicro, version: shift.version + 1 };
  },
  audit: (input, value) => ({
    entity: "RtShift",
    entityId: value.id,
    changes: { usdRateMicro: input.usdRateMicro, version: value.version },
  }),
});

/** The actor's open shift with its running summary, or null when none is open. */
export const myOpenShift = defineAction({
  name: "shift.mine",
  permission: "sale.create",
  input: z.object({}).strict(),
  writes: false,
  async run({ actor, tx }): Promise<ShiftSummary | null> {
    const shift = await openShiftOf(tx, actor);
    return shift ? summaryOf(tx, shift) : null;
  },
});

/**
 * What the till page needs first: the business currency (sales are in it), the actor's open shift summary
 * (or null), whether the business takes dollars, and the dollar rate of the business's last closed shift
 * (the open-shift form pre-fills it; the server stores only what the form sends).
 */
export const tillState = defineAction({
  name: "shift.till",
  permission: "sale.create",
  input: z.object({}).strict(),
  writes: false,
  async run({ actor, tx }): Promise<{ currency: Currency; open: ShiftSummary | null; usdEnabled: boolean; lastUsdRateMicro: bigint | null }> {
    const biz = await tx.rtBusiness.findFirstOrThrow({ select: { defaultCurrency: true, enabledCurrencies: true } });
    const shift = await openShiftOf(tx, actor);
    const usdEnabled = biz.enabledCurrencies.includes("USD");
    const last = usdEnabled
      ? await tx.rtShift.findFirst({ where: { status: "CLOSED", usdRateMicro: { not: null } }, orderBy: { closedAt: "desc" }, select: { usdRateMicro: true } })
      : null;
    return { currency: biz.defaultCurrency, open: shift ? await summaryOf(tx, shift) : null, usdEnabled, lastUsdRateMicro: last?.usdRateMicro ?? null };
  },
});

/** One shift's summary: one's own, or any in one's branches with shift.manage. */
export const shiftSummary = defineAction({
  name: "shift.summary",
  permission: "sale.create",
  input: z.object({ shiftId: id }).strict(),
  writes: false,
  async run({ actor, tx, input }): Promise<ShiftSummary> {
    const shift = await tx.rtShift.findFirst({ where: { id: input.shiftId }, select: shiftSelect });
    if (!shift) throw new NotFoundError();
    if (shift.openedById !== actor.userId && !can(actor.role, "shift.manage")) throw new ForbiddenError();
    return summaryOf(tx, shift);
  },
});
