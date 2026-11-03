// Pure sale rules (R3). No framework or database imports beyond RuleError.
// Money: BigInt minor units. Quantities: base units x 1000 (as the stock ledger). Rounding half up.
import { RuleError } from "@/server/framework/errors";
import { expiryStatus } from "./stock";

export type PaymentMethod = "CASH" | "CARD";
export type PaymentInput = { method: PaymentMethod; amountMinor: bigint };

/** What a sale's payments come to. Cash change is given from cash only. */
export type Settlement = {
  /** Cash handed over (sum of the cash entries). */
  cashTenderedMinor: bigint;
  /** Cash kept: tendered - change. */
  cashKeptMinor: bigint;
  cardMinor: bigint;
  /** cash tendered + card. */
  paidMinor: bigint;
  changeMinor: bigint;
};

/**
 * Settles the payments against the total (spec 9: cash, card or mixed; the change only on the cash
 * part). Refusals: an entry of 0 or less is INVALID_INPUT; card above the total is PAYMENT_RULE
 * (reason CARD_OVER_TOTAL); cash handed over while the card already covers the total is
 * PAYMENT_RULE (reason CASH_NOT_NEEDED: the whole cash would be change); cash + card below the
 * total is PAYMENT_SHORT. A total of 0 settles with no payment at all.
 */
export function settlePayments(totalMinor: bigint, payments: readonly PaymentInput[]): Settlement {
  if (totalMinor < 0n) throw new RuleError("INVALID_INPUT");
  let cash = 0n;
  let card = 0n;
  for (const p of payments) {
    if (p.amountMinor <= 0n) throw new RuleError("INVALID_INPUT");
    if (p.method === "CASH") cash += p.amountMinor;
    else card += p.amountMinor;
  }
  if (card > totalMinor) throw new RuleError("PAYMENT_RULE", { reason: "CARD_OVER_TOTAL" });
  if (cash + card < totalMinor) throw new RuleError("PAYMENT_SHORT", { totalMinor: totalMinor.toString() });
  if (cash > 0n && card === totalMinor) throw new RuleError("PAYMENT_RULE", { reason: "CASH_NOT_NEEDED" });
  const change = cash + card - totalMinor;
  return { cashTenderedMinor: cash, cashKeptMinor: cash - change, cardMinor: card, paidMinor: cash + card, changeMinor: change };
}

/** One stock row a sale may take from: a batch (or the no-batch row) at the shift's location. */
export type StockRow = {
  batchId: string | null;
  /** Base units x 1000 on hand. */
  qty: bigint;
  /** The batch's expiry (date-only, UTC midnight) or null. */
  expiryDate: Date | null;
  /** Tie-break for batches with the same expiry (older first). */
  createdAt: Date | null;
};

export type Allocation = { batchId: string | null; qty: bigint };

/**
 * FEFO (first expired, first out; spec 10 "الماركت"): takes `qty` from the rows, the batch that
 * expires first first; batches without a date after the dated ones, the no-batch row last. An
 * expired batch is never sold. When the rows that are not expired cannot cover `qty`:
 * STOCK_EXPIRED if the expired ones would have, STOCK_NEGATIVE otherwise (both carry lineNo).
 * `rows` is not changed; the caller subtracts the result before picking the next line of the
 * same item.
 */
export function pickFefo(rows: readonly StockRow[], qty: bigint, today: Date, lineNo: number): Allocation[] {
  if (qty <= 0n) throw new RuleError("INVALID_INPUT");
  const usable = rows.filter((r) => r.qty > 0n && expiryStatus(r.expiryDate, today, 0) !== "EXPIRED");
  const rank = (r: StockRow) => (r.batchId === null ? 2 : r.expiryDate === null ? 1 : 0);
  usable.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const ea = a.expiryDate?.getTime() ?? 0;
    const eb = b.expiryDate?.getTime() ?? 0;
    if (ea !== eb) return ea - eb;
    const ca = a.createdAt?.getTime() ?? 0;
    const cb = b.createdAt?.getTime() ?? 0;
    if (ca !== cb) return ca - cb;
    return (a.batchId ?? "") < (b.batchId ?? "") ? -1 : 1;
  });
  const out: Allocation[] = [];
  let left = qty;
  for (const r of usable) {
    if (left === 0n) break;
    const take = r.qty < left ? r.qty : left;
    out.push({ batchId: r.batchId, qty: take });
    left -= take;
  }
  if (left > 0n) {
    const all = rows.reduce((s, r) => s + (r.qty > 0n ? r.qty : 0n), 0n);
    throw new RuleError(all >= qty ? "STOCK_EXPIRED" : "STOCK_NEGATIVE", { lineNo: String(lineNo) });
  }
  return out;
}
