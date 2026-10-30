import type { Messages } from "@/messages";
import { toBaseQty } from "@/server/domain/stock";
import type { AdjustMode, AdjustReason, StockFailure } from "./types";

/*
 * The adjust dialog's own checks, run before anything is sent so a missing reason or note is said
 * at once. The server checks all of it again (it is the authority); these only spare a round trip.
 */

const REASONS: Readonly<Record<AdjustMode, readonly AdjustReason[]>> = {
  // Adding stock is a count correction or an explained exception; "lost" only takes stock out.
  IN: ["COUNT_FIX", "OTHER"],
  OUT: ["LOST", "COUNT_FIX", "OTHER"],
  WRITE_OFF: ["DAMAGED", "EXPIRED", "OTHER"],
};

/** The reasons offered for a kind of movement, in the order shown. */
export function reasonsFor(mode: AdjustMode): readonly AdjustReason[] {
  return REASONS[mode];
}

export type AdjustProblem = "UNIT_REQUIRED" | "QUANTITY_REQUIRED" | "BAD_QUANTITY" | "BATCH_REQUIRED" | "REASON_REQUIRED" | "NOTE_REQUIRED";

export type AdjustForm = {
  mode: AdjustMode;
  unitId: string;
  /** The chosen unit's rules, when known: the quantity must fit them. */
  unit?: { factor: number; quantityScale: number };
  quantity: string;
  /** needed: the product tracks expiry (a batch must be picked). chosen: "" for the no-batch row, null for none picked. */
  batch: { needed: boolean; chosen: string | null };
  reason: string;
  note: string;
};

/** What is wrong with the form, in the order the fields appear; empty when it can be sent. */
export function checkAdjustForm(f: AdjustForm): AdjustProblem[] {
  const out: AdjustProblem[] = [];
  if (f.unitId === "") out.push("UNIT_REQUIRED");
  if (f.quantity.trim() === "") out.push("QUANTITY_REQUIRED");
  else if (f.unit && !quantityFits(f.quantity, f.unit)) out.push("BAD_QUANTITY");
  if (f.batch.needed && (f.batch.chosen === null || f.batch.chosen === "")) out.push("BATCH_REQUIRED");
  const reason = (REASONS[f.mode] as readonly string[]).includes(f.reason) ? f.reason : null;
  if (reason === null) out.push("REASON_REQUIRED");
  if (reason === "OTHER" && f.note.trim() === "") out.push("NOTE_REQUIRED");
  return out;
}

/** Does the typed quantity fit the unit (above zero, no more decimals than it allows, not too large)? */
export function quantityFits(text: string, unit: { factor: number; quantityScale: number }): boolean {
  try {
    toBaseQty(text, unit);
    return true;
  } catch {
    return false;
  }
}

/**
 * The text for a refusal in the interface language. A STOCK_RULE says why when the server named
 * the reason (a known one); otherwise its general message. Every other code has its message in t.errors.
 */
export function stockFailureMessage(t: Messages, f: StockFailure): string {
  switch (f.code) {
    case "INTERNAL":
      return t.internalError;
    case "BAD_QUANTITY":
      return t.stock.adjust.problems.BAD_QUANTITY;
    case "STOCK_RULE": {
      const reason = f.details?.reason;
      const known = t.stock.ruleReasons as Readonly<Record<string, string>>;
      return reason && Object.hasOwn(known, reason) ? known[reason]! : t.errors.STOCK_RULE;
    }
    case "BAD_BARCODE":
    case "BAD_PRICE":
    case "BAD_NAME":
    case "BAD_FACTOR":
    case "BAD_DATE":
    case "BAD_NUMBER":
    case "BAD_OPTIONS":
      return t.errors.INVALID_INPUT;
    default:
      return t.errors[f.code];
  }
}

/** True when the data on screen is out of date (offer a reload). */
export function isStaleFailure(f: StockFailure): boolean {
  return f.code === "NOT_FOUND" || f.code === "VERSION_CONFLICT" || (f.code === "STOCK_RULE" && (f.details?.reason === "BATCH_NOT_OF_VARIANT" || f.details?.reason === "UNIT_NOT_OF_VARIANT"));
}
