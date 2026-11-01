import type { Prisma } from "@/generated/prisma/client";
import { MAX_BASE_QTY, MAX_VALUE_MINOR, reduceValue } from "@/server/domain/stock";
import { RuleError } from "@/server/framework/errors";

/*
 * The stock ledger core. Not actions: callers (posting, reversal, import) run these inside their own
 * defineAction transaction with the scoped client, after their own permission, document and
 * idempotency checks. A throw rolls the caller's whole transaction back.
 *
 * Rules (spec sections 3.2, 3.4, 3.6 and 6b.2, 6b.8):
 * - RtStockMovement is append-only (database trigger); RtStockBalance is a cached sum of it, kept
 *   in the same transaction, one row per (location, variant, batch or none).
 * - Weighted average per (location, variant) across all its batches. An outflow from any batch
 *   takes reduceValue(total qty, total value, out qty) of the variant's totals at the location; that
 *   batch row's value drops by that amount (one batch row's value may drift, even below zero, by
 *   rounding; the total is the source of truth). The last outflow that empties the variant takes
 *   the whole remaining value, so no drift accumulates. Inflows add the caller's valueDeltaMinor;
 *   outflow values are computed here and never passed in, except with `exactValues`.
 * - exactValues (a REVERSAL only, spec 6b.3; the document must be a REVERSAL, STOCK_RULE otherwise): every outflow carries its own valueDeltaMinor (<= 0)
 *   and an inflow may too (>= 0), so a reversal restores the original values exactly instead of
 *   taking the current average. It still refuses, with STOCK_NEGATIVE, a line that would take its
 *   (location, variant, batch) quantity below zero. When the stock left is enough but its value
 *   does not fit the original values (average-cost outflows since), it refuses with STOCK_RULE
 *   {reason: REVERSAL_VALUE_MISMATCH}: the variant's TOTAL value at the location would go below
 *   zero, or (checked after all lines) its total quantity would be 0 with a value left over, which
 *   no later movement could ever clear. One batch row's value is never checked alone: a batch can
 *   sit at qty 0 with an offsetting value after average-cost outflows.
 * - A balance value (a row's or the variant's total at the location) above MAX_VALUE_MINOR, or
 *   below its negative, is refused with STOCK_RULE {reason: VALUE_TOO_LARGE} before any write
 *   (the int8 column would otherwise overflow into an internal error).
 * - No negative stock: the whole call is checked in memory (lines in order) BEFORE anything is
 *   written, so a refusal leaves nothing behind (the caller's transaction commits nothing). The
 *   balance CHECK (qty >= 0) is the backstop and is reported as STOCK_NEGATIVE too.
 * - Locks: postMovements takes lockBusiness(`stock:<variantId>`) for each distinct variant in
 *   ascending order, and nothing else. Callers take their document and idempotency locks first;
 *   the order everywhere is idempotency -> document -> stock:<variant> ascending -> document
 *   number. The framework retries nothing but an idempotency-key P2002: a deadlock (40P01) or a
 *   serialization failure (40001) reaches the caller as an internal error. So a transaction makes
 *   ONE postMovements call, or first takes lockBusiness(`stock:<id>`) itself for the union of every
 *   variant it will post, in ascending order (the advisory lock is re-entrant, so postMovements
 *   taking the same locks again is harmless). Two calls that each lock their own variants could
 *   otherwise deadlock against another transaction doing the same in another order.
 * - Missing balance rows are inserted with INSERT ... ON CONFLICT DO NOTHING (createMany with
 *   skipDuplicates) and read back. The no-batch row has a null in its unique key, which Prisma's
 *   upsert cannot select, and a caught P2002 would abort the Postgres transaction, so neither
 *   upsert nor create-and-catch is used.
 */

type Tx = Prisma.TransactionClient;

export type LedgerLine = {
  lineId: string;
  variantId: string;
  batchId: string | null;
  /** Base units x QTY_SCALE; positive in, negative out, never zero. */
  qtyDelta: bigint;
  /**
   * Inflows: >= 0, default 0. Outflows: never given (the ledger computes it), except with
   * exactValues, where it is required and <= 0.
   */
  valueDeltaMinor?: bigint;
};

export type PostMovementsInput = {
  businessId: string;
  documentId: string;
  branchId: string;
  locationId: string;
  lines: LedgerLine[];
  /** A REVERSAL's exact negation: the caller's values on outflows too (see the header). */
  exactValues?: boolean;
};

/** The value written for each line, in the order of the input lines. */
export type PostedMovement = { lineId: string; valueDeltaMinor: bigint };

type Amount = { qty: bigint; valueMinor: bigint };

export type BalanceMismatch = {
  locationId: string;
  variantId: string;
  batchId: string | null;
  /** null: no balance row although movements exist. */
  stored: Amount | null;
  /** null: a balance row without any movement. */
  computed: Amount | null;
};

const keyOf = (variantId: string, batchId: string | null) => `${variantId}|${batchId ?? ""}`;

/**
 * The balance CHECK (qty >= 0), as Prisma surfaces it (SQLSTATE 23514 naming the constraint).
 * Called from a catch block, so it never throws itself: a meta that JSON cannot carry (a bigint, a
 * cycle) is read as text where it can be and otherwise ignored.
 */
export function isNegativeBalance(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const message = (err as { message?: unknown }).message;
  let meta = "";
  try {
    meta = JSON.stringify((err as { meta?: unknown }).meta ?? null, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) ?? "";
  } catch {
    meta = "";
  }
  return `${typeof message === "string" ? message : ""} ${meta}`.includes("RtStockBalance_qty_nonneg");
}

function assertLines(lines: LedgerLine[], exactValues: boolean): void {
  for (const l of lines) {
    if (l.qtyDelta === 0n) throw new RuleError("INVALID_INPUT");
    if (l.qtyDelta > MAX_BASE_QTY || -l.qtyDelta > MAX_BASE_QTY) throw new RuleError("INVALID_INPUT");
    if (l.qtyDelta > 0n) {
      if (l.valueDeltaMinor !== undefined && l.valueDeltaMinor < 0n) throw new RuleError("INVALID_INPUT");
    } else if (exactValues) {
      if (l.valueDeltaMinor === undefined || l.valueDeltaMinor > 0n) throw new RuleError("INVALID_INPUT");
    } else if (l.valueDeltaMinor !== undefined) {
      throw new RuleError("INVALID_INPUT");
    }
  }
}

/**
 * Writes one movement per line at one location and updates the balances, all or nothing, and
 * returns the value written for each line. STOCK_NEGATIVE when an outflow exceeds its (location,
 * variant, batch) balance at that point of the call; STOCK_RULE {reason: REVERSAL_VALUE_MISMATCH}
 * (exactValues) when the variant's total value would go below zero, or its quantity to 0 with a
 * value left; STOCK_RULE {reason: VALUE_TOO_LARGE} for a balance value beyond MAX_VALUE_MINOR; INVALID_INPUT for a zero quantity, a quantity above MAX_BASE_QTY, a
 * negative inflow value, or a value on an outflow (missing or positive with exactValues);
 * STOCK_RULE {reason: EXACT_VALUES_NOT_REVERSAL} for exactValues on a document that is not a REVERSAL. Callers
 * validate their lines (variant, batch of that variant, line of that document and variant) before
 * calling: a reference the foreign keys refuse is an internal error.
 */
export async function postMovements(
  tx: Tx,
  p: PostMovementsInput,
  lockBusiness: (name: string) => Promise<void>,
): Promise<PostedMovement[]> {
  const exactValues = p.exactValues === true;
  assertLines(p.lines, exactValues);
  if (p.lines.length === 0) return [];
  if (exactValues) {
    // Only a reversal may set its own outflow values (checked before any lock or write).
    const doc = await tx.rtStockDocument.findFirst({ where: { id: p.documentId }, select: { kind: true } });
    if (doc?.kind !== "REVERSAL") throw new RuleError("STOCK_RULE", { reason: "EXACT_VALUES_NOT_REVERSAL" });
  }
  const variantIds = [...new Set(p.lines.map((l) => l.variantId))].sort();
  for (const v of variantIds) await lockBusiness(`stock:${v}`);

  // Under the locks, the current rows of these variants at the location (every batch).
  const where = { businessId: p.businessId, locationId: p.locationId, variantId: { in: variantIds } };
  const existing = await tx.rtStockBalance.findMany({ where, select: { variantId: true, batchId: true, qty: true, valueMinor: true } });
  const rows = new Map<string, Amount>();
  const totals = new Map<string, Amount>();
  for (const r of existing) {
    rows.set(keyOf(r.variantId, r.batchId), { qty: r.qty, valueMinor: r.valueMinor });
    const t = totals.get(r.variantId) ?? { qty: 0n, valueMinor: 0n };
    totals.set(r.variantId, { qty: t.qty + r.qty, valueMinor: t.valueMinor + r.valueMinor });
  }

  // Run the lines in memory first: every refusal happens before the first write.
  const deltas = new Map<string, { variantId: string; batchId: string | null } & Amount>();
  const movements = p.lines.map((l) => {
    const key = keyOf(l.variantId, l.batchId);
    const row = rows.get(key) ?? { qty: 0n, valueMinor: 0n };
    const total = totals.get(l.variantId) ?? { qty: 0n, valueMinor: 0n };
    let value: bigint;
    if (l.qtyDelta < 0n) {
      if (row.qty + l.qtyDelta < 0n) throw new RuleError("STOCK_NEGATIVE");
      if (exactValues) {
        value = l.valueDeltaMinor!;
        if (total.valueMinor + value < 0n) throw new RuleError("STOCK_RULE", { reason: "REVERSAL_VALUE_MISMATCH" });
      } else {
        value = -reduceValue(total.qty, total.valueMinor, -l.qtyDelta);
      }
    } else {
      value = l.valueDeltaMinor ?? 0n;
    }
    const nextRow = { qty: row.qty + l.qtyDelta, valueMinor: row.valueMinor + value };
    const nextTotal = { qty: total.qty + l.qtyDelta, valueMinor: total.valueMinor + value };
    for (const v of [nextRow.valueMinor, nextTotal.valueMinor]) {
      if (v > MAX_VALUE_MINOR || -v > MAX_VALUE_MINOR) throw new RuleError("STOCK_RULE", { reason: "VALUE_TOO_LARGE" });
    }
    rows.set(key, nextRow);
    totals.set(l.variantId, nextTotal);
    const d = deltas.get(key) ?? { variantId: l.variantId, batchId: l.batchId, qty: 0n, valueMinor: 0n };
    deltas.set(key, { ...d, qty: d.qty + l.qtyDelta, valueMinor: d.valueMinor + value });
    return {
      businessId: p.businessId,
      branchId: p.branchId,
      locationId: p.locationId,
      documentId: p.documentId,
      lineId: l.lineId,
      variantId: l.variantId,
      batchId: l.batchId,
      qtyDelta: l.qtyDelta,
      valueDeltaMinor: value,
    };
  });

  // A reversal never leaves a variant empty with a value: nothing could take that value out again.
  if (exactValues) {
    for (const v of variantIds) {
      const t = totals.get(v);
      if (t && t.qty === 0n && t.valueMinor !== 0n) throw new RuleError("STOCK_RULE", { reason: "REVERSAL_VALUE_MISMATCH" });
    }
  }

  // The first movement of a variant marks it (R-Q), once: the catalog locks read this business-level
  // marker. Under the variant locks, so a catalog edit and a first posting serialize. No version bump.
  await tx.rtVariant.updateMany({ where: { id: { in: variantIds }, stockStartedAt: null }, data: { stockStartedAt: new Date() } });

  try {
    const missing = [...deltas.values()].filter((d) => !existing.some((r) => r.variantId === d.variantId && r.batchId === d.batchId));
    if (missing.length > 0) {
      await tx.rtStockBalance.createMany({
        data: missing.map((d) => ({
          businessId: p.businessId,
          branchId: p.branchId,
          locationId: p.locationId,
          variantId: d.variantId,
          batchId: d.batchId,
          qty: 0n,
          valueMinor: 0n,
        })),
        skipDuplicates: true,
      });
    }
    const ids = new Map(
      (await tx.rtStockBalance.findMany({ where, select: { id: true, variantId: true, batchId: true } })).map((r) => [
        keyOf(r.variantId, r.batchId),
        r.id,
      ]),
    );
    for (const [key, d] of deltas) {
      if (d.qty === 0n && d.valueMinor === 0n) continue;
      await tx.rtStockBalance.update({
        where: { id: ids.get(key)! },
        data: { qty: { increment: d.qty }, valueMinor: { increment: d.valueMinor } },
      });
    }
    await tx.rtStockMovement.createMany({ data: movements });
  } catch (err) {
    if (isNegativeBalance(err)) throw new RuleError("STOCK_NEGATIVE");
    throw err;
  }
  return movements.map((m) => ({ lineId: m.lineId, valueDeltaMinor: m.valueDeltaMinor }));
}

/** The variant's totals at the location across every batch (the weighted average is value / qty). */
export async function variantAverage(tx: Tx, locationId: string, variantId: string): Promise<{ qty: bigint; valueMinor: bigint }> {
  const sum = await tx.rtStockBalance.aggregate({ where: { locationId, variantId }, _sum: { qty: true, valueMinor: true } });
  return { qty: sum._sum.qty ?? 0n, valueMinor: sum._sum.valueMinor ?? 0n };
}

/**
 * Recomputes every balance of the business from its movements and compares it with the stored
 * rows: wrong numbers, a missing row and a row without movements are all mismatches. With fix,
 * the stored rows are corrected (updated, created, deleted) and the mismatches found are returned.
 *
 * A maintenance function: pass a client that sees the whole business, i.e. a scoped tx of an actor
 * with every branch, or the base client in a script (the filter on businessId is explicit, so both
 * work). A branch-limited client sees, and repairs, only its branches. It takes no lock: run the
 * fix when nothing is posting, or inside a transaction that holds the variants' stock locks.
 */
export async function rebuildBalances(
  tx: Tx,
  businessId: string,
  opts: { fix: boolean },
): Promise<{ mismatches: BalanceMismatch[] }> {
  const sums = await tx.rtStockMovement.groupBy({
    by: ["branchId", "locationId", "variantId", "batchId"],
    where: { businessId },
    _sum: { qtyDelta: true, valueDeltaMinor: true },
  });
  const stored = await tx.rtStockBalance.findMany({
    where: { businessId },
    select: { id: true, locationId: true, variantId: true, batchId: true, qty: true, valueMinor: true },
  });
  const rowKey = (r: { locationId: string; variantId: string; batchId: string | null }) =>
    `${r.locationId}|${keyOf(r.variantId, r.batchId)}`;
  const storedByKey = new Map(stored.map((r) => [rowKey(r), r]));

  const mismatches: BalanceMismatch[] = [];
  const fixes: (() => Promise<unknown>)[] = [];
  for (const s of sums) {
    const computed = { qty: s._sum.qtyDelta ?? 0n, valueMinor: s._sum.valueDeltaMinor ?? 0n };
    const key = rowKey(s);
    const row = storedByKey.get(key);
    storedByKey.delete(key);
    const at = { locationId: s.locationId, variantId: s.variantId, batchId: s.batchId };
    if (!row) {
      mismatches.push({ ...at, stored: null, computed });
      fixes.push(() => tx.rtStockBalance.create({ data: { businessId, branchId: s.branchId, ...at, ...computed } }));
    } else if (row.qty !== computed.qty || row.valueMinor !== computed.valueMinor) {
      mismatches.push({ ...at, stored: { qty: row.qty, valueMinor: row.valueMinor }, computed });
      fixes.push(() => tx.rtStockBalance.update({ where: { id: row.id }, data: computed }));
    }
  }
  for (const row of storedByKey.values()) {
    mismatches.push({
      locationId: row.locationId,
      variantId: row.variantId,
      batchId: row.batchId,
      stored: { qty: row.qty, valueMinor: row.valueMinor },
      computed: null,
    });
    fixes.push(() => tx.rtStockBalance.delete({ where: { id: row.id } }));
  }
  if (opts.fix) for (const f of fixes) await f();
  return { mismatches };
}
