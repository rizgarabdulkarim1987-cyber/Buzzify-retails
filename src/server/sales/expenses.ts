import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { RtExpenseCategory } from "@/generated/prisma/enums";
import { money } from "@/server/catalog/price-core";
import { can } from "@/server/domain/permissions";
import { defineAction } from "@/server/framework/action";
import { ForbiddenError, NotFoundError, RuleError } from "@/server/framework/errors";
import { dinarDrawerNow, openShiftOf, shiftExpensesTotal, shiftLock } from "./shifts";

export { shiftExpensesTotal };

/*
 * Cash expenses paid from the dinar drawer (spec 2026-11-05). An expense belongs to its seller's own
 * OPEN shift and is never edited: a mistake is voided (with a reason, by shift.manage) and entered again.
 *
 * - recordExpense (expense.create: OWNER, MANAGER, CASHIER): on the actor's own open shift
 *   (SHIFT_NOT_OPEN otherwise), under the lock `shift:<id>` that a sale and the close take. amount > 0
 *   and at most the dinar drawer now (opening + cash kept - expenses not voided, the same helper the
 *   close uses): one dinar more is EXPENSE_EXCEEDS_DRAWER and nothing is written. The category OTHER
 *   needs a note. Idempotent by expenseKey (unique per business): a retry returns the expense already
 *   posted and writes nothing, even when the drawer is empty by now; another person's key is refused.
 * - voidExpense (shift.manage): an expense of an OPEN shift in the actor's branches, with a reason.
 *   A voided one stays listed and no longer counts. A closed shift never changes (SHIFT_NOT_OPEN);
 *   voiding twice is EXPENSE_VOIDED.
 * - listShiftExpenses (sale.create): the shift's expenses newest first, voided ones included; one's
 *   own shift, or any in one's branches with shift.manage.
 */

const MAX_NOTE = 500;
const id = z.string().min(1).max(64);

export const EXPENSE_CATEGORIES = ["SUPPLIES", "TRANSPORT", "UTILITIES", "CLEANING", "MAINTENANCE", "WAGES", "MEALS", "OTHER"] as const satisfies readonly RtExpenseCategory[];

export type ExpenseView = {
  id: string;
  shiftId: string;
  categoryKey: RtExpenseCategory;
  amountMinor: bigint;
  note: string | null;
  createdById: string;
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
};

const expenseSelect = {
  id: true,
  shiftId: true,
  categoryKey: true,
  amountMinor: true,
  note: true,
  expenseKey: true,
  createdById: true,
  createdAt: true,
  voidedAt: true,
  voidReason: true,
} as const;

type Row = Prisma.RtExpenseGetPayload<{ select: typeof expenseSelect }>;

const view = (r: Row): ExpenseView => ({
  id: r.id,
  shiftId: r.shiftId,
  categoryKey: r.categoryKey,
  amountMinor: r.amountMinor,
  note: r.note,
  createdById: r.createdById,
  createdAt: r.createdAt,
  voidedAt: r.voidedAt,
  voidReason: r.voidReason,
});

const note = z
  .string()
  .trim()
  .max(MAX_NOTE)
  .nullish()
  .transform((v) => (v ? v : null));

const recordInput = z
  .object({
    expenseKey: z.string().min(1).max(200),
    categoryKey: z.enum(EXPENSE_CATEGORIES),
    amountMinor: money.refine((v) => v > 0n),
    note: note.optional(),
  })
  .strict()
  .refine((v) => v.categoryKey !== "OTHER" || (v.note ?? "") !== "");

/** Records a cash expense on the actor's open shift (see the header). */
export const recordExpense = defineAction({
  name: "expense.record",
  permission: "expense.create",
  input: recordInput,
  writes: true,
  async run({ actor, tx, input, lockBusiness }): Promise<ExpenseView> {
    const found = await openShiftOf(tx, actor);
    if (!found) throw new RuleError("SHIFT_NOT_OPEN");
    await lockBusiness(shiftLock(found.id));
    const shift = await tx.rtShift.findFirst({ where: { id: found.id, status: "OPEN" }, select: { id: true, branchId: true, currency: true, openingCashMinor: true } });
    if (!shift) throw new RuleError("SHIFT_NOT_OPEN");

    // Already saved under this key: return it, write nothing (before the drawer check, so a retry never fails).
    const existing = await tx.rtExpense.findFirst({ where: { expenseKey: input.expenseKey }, select: expenseSelect });
    if (existing) {
      if (existing.createdById !== actor.userId || existing.shiftId !== shift.id) throw new RuleError("INVALID_INPUT");
      return view(existing);
    }

    if (input.amountMinor > (await dinarDrawerNow(tx, shift))) throw new RuleError("EXPENSE_EXCEEDS_DRAWER");
    const row = await tx.rtExpense.create({
      data: {
        businessId: actor.businessId,
        branchId: shift.branchId,
        shiftId: shift.id,
        categoryKey: input.categoryKey,
        amountMinor: input.amountMinor,
        currency: shift.currency,
        note: input.note ?? null,
        expenseKey: input.expenseKey,
        createdById: actor.userId,
      },
      select: expenseSelect,
    });
    return view(row);
  },
  audit: (_input, value) => ({
    entity: "RtExpense",
    entityId: value.id,
    changes: { shiftId: value.shiftId, categoryKey: value.categoryKey, amountMinor: value.amountMinor, note: value.note },
  }),
});

const voidInput = z.object({ expenseId: id, reason: z.string().trim().min(1).max(MAX_NOTE) }).strict();

/** Voids an expense of an OPEN shift with a reason (shift.manage). */
export const voidExpense = defineAction({
  name: "expense.void",
  permission: "shift.manage",
  input: voidInput,
  writes: true,
  async run({ actor, tx, input, lockBusiness }): Promise<ExpenseView> {
    const first = await tx.rtExpense.findFirst({ where: { id: input.expenseId }, select: { id: true, shiftId: true } });
    if (!first) throw new NotFoundError();
    // The shift's lock first (a sale, a record and the close take it), then read everything again.
    await lockBusiness(shiftLock(first.shiftId));
    const shift = await tx.rtShift.findFirst({ where: { id: first.shiftId }, select: { status: true } });
    if (!shift) throw new NotFoundError();
    if (shift.status !== "OPEN") throw new RuleError("SHIFT_NOT_OPEN");
    const row = await tx.rtExpense.findFirst({ where: { id: first.id }, select: expenseSelect });
    if (!row) throw new NotFoundError();
    if (row.voidedAt !== null) throw new RuleError("EXPENSE_VOIDED");
    const updated = await tx.rtExpense.update({
      where: { id: row.id },
      data: { voidedAt: new Date(), voidedById: actor.userId, voidReason: input.reason },
      select: expenseSelect,
    });
    return view(updated);
  },
  audit: (input, value) => ({
    entity: "RtExpense",
    entityId: value.id,
    changes: { shiftId: value.shiftId, amountMinor: value.amountMinor, voidReason: input.reason },
  }),
});

/** The expenses of one shift, newest first (voided ones included): one's own shift, or any in one's branches with shift.manage. */
export const listShiftExpenses = defineAction({
  name: "expense.list",
  permission: "sale.create",
  input: z.object({ shiftId: id }).strict(),
  writes: false,
  async run({ actor, tx, input }): Promise<ExpenseView[]> {
    const shift = await tx.rtShift.findFirst({ where: { id: input.shiftId }, select: { openedById: true } });
    if (!shift) throw new NotFoundError();
    if (shift.openedById !== actor.userId && !can(actor.role, "shift.manage")) throw new ForbiddenError();
    const rows = await tx.rtExpense.findMany({ where: { shiftId: input.shiftId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: expenseSelect });
    return rows.map(view);
  },
});
