import { parseAmount } from "./cart";
import type { Currency } from "./cart";

/*
 * The expense panel's pure part (no React): the eight categories, what the wire carries, and when
 * Save is ready. Money is the numpad's ASCII text in the browser and a digit string on the wire.
 */

export const EXPENSE_CATEGORIES = ["SUPPLIES", "TRANSPORT", "UTILITIES", "CLEANING", "MAINTENANCE", "WAGES", "MEALS", "OTHER"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export type ExpenseDto = {
  id: string;
  categoryKey: ExpenseCategory;
  amountMinor: string;
  note: string | null;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
};

export const MAX_EXPENSE_NOTE = 500;

export type ExpenseForm = { amountText: string; category: ExpenseCategory | null; note: string };

/**
 * What Save needs: an amount above zero, a category, and a note when the category is "Other".
 * `needsNote` is true while that note is still missing (the panel says so next to the field).
 */
export function expenseState(form: ExpenseForm, currency: Currency): { amount: bigint | null; needsNote: boolean; ready: boolean } {
  const parsed = form.amountText.trim() === "" ? null : parseAmount(form.amountText.replace(/\.$/, ""), currency);
  const amount = parsed !== null && parsed > 0n ? parsed : null;
  const needsNote = form.category === "OTHER" && form.note.trim() === "";
  return { amount, needsNote, ready: amount !== null && form.category !== null && !needsNote };
}

/** The total of the expenses not voided, as a digit string. */
export function activeTotal(list: readonly ExpenseDto[]): bigint {
  return list.reduce((sum, e) => (e.voidedAt === null ? sum + BigInt(e.amountMinor) : sum), 0n);
}
