import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { Currency, RtShiftStatus } from "@/generated/prisma/enums";
import { money } from "@/server/catalog/price-core";
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
 *   (cash payments net of change); difference = counted - expected (negative: cash is missing).
 *   A closed shift never changes.
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
  openedAt: Date;
  closedAt: Date | null;
  countedCashMinor: bigint | null;
  expectedCashMinor: bigint | null;
  differenceMinor: bigint | null;
  version: number;
};

export type ShiftSummary = {
  shift: ShiftView;
  salesCount: number;
  /** Sum of the sales' totals. */
  totalMinor: bigint;
  /** Cash kept by the sales (net of change). */
  cashMinor: bigint;
  cardMinor: bigint;
  /** opening + cashMinor: what the drawer should hold now (or held at close). */
  expectedCashMinor: bigint;
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
  openedAt: true,
  closedAt: true,
  countedCashMinor: true,
  expectedCashMinor: true,
  differenceMinor: true,
  version: true,
} as const;

/** The actor's OPEN shift in this business (scoped to the actor's branches), or null. */
export async function openShiftOf(tx: Tx, actor: Actor): Promise<ShiftView | null> {
  return tx.rtShift.findFirst({ where: { openedById: actor.userId, status: "OPEN" }, select: shiftSelect });
}

/** Totals of the shift's sales (count, total) and payments (cash net of change, card). */
export async function shiftTotals(tx: Tx, shiftId: string): Promise<{ salesCount: number; totalMinor: bigint; cashMinor: bigint; cardMinor: bigint }> {
  const [sales, pays] = await Promise.all([
    tx.rtSale.aggregate({ where: { shiftId }, _count: { _all: true }, _sum: { totalMinor: true } }),
    tx.rtPayment.groupBy({ by: ["method"], where: { shiftId }, _sum: { amountMinor: true } }),
  ]);
  const sumOf = (m: "CASH" | "CARD") => pays.find((p) => p.method === m)?._sum.amountMinor ?? 0n;
  return { salesCount: sales._count._all, totalMinor: sales._sum.totalMinor ?? 0n, cashMinor: sumOf("CASH"), cardMinor: sumOf("CARD") };
}

async function summaryOf(tx: Tx, shift: ShiftView): Promise<ShiftSummary> {
  const t = await shiftTotals(tx, shift.id);
  return { shift, ...t, expectedCashMinor: shift.openingCashMinor + t.cashMinor };
}

const openInput = z
  .object({
    branchId: id,
    terminalId: id.nullish().transform((v) => v ?? null),
    openingCashMinor: money,
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
    const biz = await tx.rtBusiness.findFirstOrThrow({ select: { defaultCurrency: true } });
    return tx.rtShift.create({
      data: {
        businessId: actor.businessId,
        branchId: branch.id,
        locationId: location.id,
        terminalId: input.terminalId,
        openedById: actor.userId,
        currency: biz.defaultCurrency,
        openingCashMinor: input.openingCashMinor,
      },
      select: shiftSelect,
    });
  },
  audit: (input, value) => ({
    entity: "RtShift",
    entityId: value.id,
    changes: { branchId: value.branchId, terminalId: value.terminalId, openingCashMinor: input.openingCashMinor },
  }),
});

const closeInput = z
  .object({
    shiftId: id,
    countedCashMinor: money,
    note: z
      .string()
      .trim()
      .max(MAX_NOTE)
      .nullish()
      .transform((v) => (v ? v : null)),
    expectedVersion: z.number().int().min(1),
  })
  .strict();

export type ClosedShift = ShiftSummary & { differenceMinor: bigint };

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
    const t = await shiftTotals(tx, shift.id);
    const expectedCashMinor = shift.openingCashMinor + t.cashMinor;
    const differenceMinor = input.countedCashMinor - expectedCashMinor;
    const closedAt = new Date();
    await updateVersioned(tx.rtShift, { id: shift.id, status: "OPEN" }, input.expectedVersion, {
      status: "CLOSED",
      closedAt,
      closedById: actor.userId,
      countedCashMinor: input.countedCashMinor,
      expectedCashMinor,
      differenceMinor,
      closeNote: input.note,
    });
    const closed: ShiftView = {
      ...shift,
      status: "CLOSED",
      closedAt,
      countedCashMinor: input.countedCashMinor,
      expectedCashMinor,
      differenceMinor,
      version: shift.version + 1,
    };
    return { shift: closed, ...t, expectedCashMinor, differenceMinor };
  },
  audit: (_input, value) => ({
    entity: "RtShift",
    entityId: value.shift.id,
    changes: {
      countedCashMinor: value.shift.countedCashMinor,
      expectedCashMinor: value.expectedCashMinor,
      differenceMinor: value.differenceMinor,
      salesCount: value.salesCount,
    },
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
