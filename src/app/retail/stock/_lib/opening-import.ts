import type { Messages } from "@/messages";

/*
 * The opening-stock import wizard's rules, for the browser. The column list and the mapping check
 * mirror src/server/stock/import.ts (OPENING_COLUMNS, validateOpeningMapping), which imports
 * node:crypto and so cannot reach a client component; the server checks the mapping again.
 */

export const OPENING_FIELDS = ["barcode", "sku", "quantity", "unit", "cost", "currency", "rate", "batch", "expiry"] as const;
export type OpeningField = (typeof OPENING_FIELDS)[number];
export type OpeningMappingDto = Record<OpeningField, number | null>;
export type OpeningMappingProblem = "MISSING_IDENTIFIER" | "MISSING_QUANTITY" | "DUPLICATE_COLUMN";

export const COST_FIELD = "cost" satisfies OpeningField;

/** barcode or sku, and quantity, must be mapped; no file column may feed two fields. */
export function mappingProblems(mapping: OpeningMappingDto): OpeningMappingProblem[] {
  const problems: OpeningMappingProblem[] = [];
  const mapped = (c: OpeningField) => mapping[c] !== null;
  if (!mapped("barcode") && !mapped("sku")) problems.push("MISSING_IDENTIFIER");
  if (!mapped("quantity")) problems.push("MISSING_QUANTITY");
  const used = OPENING_FIELDS.filter(mapped).map((c) => mapping[c]);
  if (new Set(used).size !== used.length) problems.push("DUPLICATE_COLUMN");
  return problems;
}

/**
 * A mapping change as a role without cost.view may make it: the cost field keeps its column, and
 * no other field may take a column that holds costs (`hidden`, by default the cost column). A role
 * with cost.view changes anything.
 */
export function lockedMapping(next: OpeningMappingDto, base: OpeningMappingDto, canSeeCost: boolean, hidden: readonly number[] = base.cost === null ? [] : [base.cost]): OpeningMappingDto {
  if (canSeeCost) return next;
  const out = { ...next, cost: base.cost };
  for (const f of OPENING_FIELDS) {
    if (f !== COST_FIELD && out[f] !== null && hidden.includes(out[f]!)) out[f] = base[f];
  }
  return out;
}

export type OpeningRowStatus = "OK" | "REJECTED" | "SKIPPED" | "COMMITTED";
export type OpeningFlag = "HAS_STOCK" | "EXPIRED" | "COST_MISSING";

/** One stored row as the browser receives it (the cost cells are blank without cost.view). */
export type OpeningRowDto = {
  rowNumber: number;
  status: OpeningRowStatus;
  reason: string | null;
  flags: OpeningFlag[];
  /** On hand at validation (base x 1000), only when the server returned it. */
  onHand: string | null;
  raw: string[];
};
export type OpeningRowsPage = { rows: OpeningRowDto[]; rowCount: number; postedRows: number };

export type OpeningSummaryDto = { total: number; ok: number; hasStock: number; rejected: number; skipped: number; expired: number; costMissing: number };
export type OpeningStatsDto = { total: number; posted: number; skipped: number; skippedHasStock: number; rejected: number; documents: number };

export const OPENING_ROWS_PER_PAGE = 50;

/** The reason of a row in words, or null when there is none to show (or the code is unknown here). */
export function rowReasonText(t: Messages, reason: string | null): string | null {
  if (!reason || reason === "NOT_VALIDATED") return null;
  const reasons = t.stock.openingImport.reasons as Record<string, string>;
  return Object.hasOwn(reasons, reason) ? reasons[reason]! : null;
}

/** A row's status in words, with its reason after it when it has one ("Rejected · No item has this barcode"). */
export function rowStatusText(t: Messages, row: { status: string; reason: string | null }): string {
  const statuses = t.stock.openingImport.rowStatus as Record<string, string>;
  const status = Object.hasOwn(statuses, row.status) ? statuses[row.status]! : statuses.REJECTED!;
  const reason = row.status === "OK" && row.reason === "HAS_STOCK" ? null : rowReasonText(t, row.reason);
  return reason && reason !== status ? `${status} · ${reason}` : status;
}

export const isRowStatus = (v: unknown): v is OpeningRowStatus => v === "OK" || v === "REJECTED" || v === "SKIPPED" || v === "COMMITTED";

/** A row from getOpeningImport for the browser (the on-hand quantity as digits). */
export function rowDto(r: { rowNumber: number; status: string; reason: string | null; flags: string[]; onHand: bigint | null; raw: string[] }): OpeningRowDto {
  return {
    rowNumber: r.rowNumber,
    status: isRowStatus(r.status) ? r.status : "REJECTED",
    reason: r.reason,
    flags: r.flags.filter((f): f is OpeningRowDto["flags"][number] => f === "HAS_STOCK" || f === "EXPIRED" || f === "COST_MISSING"),
    onHand: r.onHand === null ? null : r.onHand.toString(),
    raw: r.raw,
  };
}
