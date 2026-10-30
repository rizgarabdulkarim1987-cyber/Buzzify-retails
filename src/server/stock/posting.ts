import type { Prisma } from "@/generated/prisma/client";
import type { Currency, RtStockDirection, RtStockDocumentKind, RtTrackingMode } from "@/generated/prisma/enums";
import { MAX_PRICE_MINOR } from "@/server/catalog/price-core";
import {
  MAX_BASE_QTY,
  QTY_SCALE,
  businessToday,
  convertMinor,
  expiryStatus,
  lineValueMinor,
  toBaseQty,
  unitCostMinor,
} from "@/server/domain/stock";
import type { Actor } from "@/server/framework/actor";
import { NotFoundError, RuleError, VersionConflictError } from "@/server/framework/errors";
import { updateVersioned } from "@/server/framework/versioned";
import { postMovements, variantAverage, type LedgerLine } from "./ledger";

/*
 * The posting core shared by the receipt actions (documents.ts), the adjustments, write-offs and
 * reversals (adjust.ts) and the opening import (Task 7). Not actions: callers run these inside their
 * own defineAction transaction with the scoped client, after their own permission check, and decide
 * what to show (postDocumentInTx returns costs; a caller without cost.view strips them).
 *
 * postDocumentInTx posts a DRAFT of any kind:
 * - OPENING / RECEIPT (the lines as typed): every line checked, equal lines merged, batches resolved
 *   from code and expiry, values from the typed costs (see documents.ts for the rules).
 * - ADJUSTMENT / WRITE_OFF (document `direction`; a WRITE_OFF is OUT): the lines name their batch
 *   (batchId: required for a tracksExpiry product, optional for another BATCH product where null is
 *   the no-batch row, refused for a non-BATCH product) and carry no cost. IN is valued at the variant's current weighted average at the
 *   location (variantAverage, read under the variant locks), or 0 with a COST_UNKNOWN warning when
 *   the variant has no stock there; OUT is valued by the ledger (average). Each line stores the
 *   value and the average cost of one entered unit in the business's currency. An archived item may
 *   go OUT (its stock can still be written off) but not IN.
 * - REVERSAL (reversesDocumentId): lines already mirror the original; the movements are the exact
 *   negation of the original's movements (postMovements exactValues), so they are refused with
 *   STOCK_NEGATIVE when the stock (or its value) is no longer there. No catalog check: a reversal
 *   corrects what was posted, whatever the item has become since.
 *
 * Nothing is committed before a refusal: every check runs before the first write, or a later
 * refusal (the ledger's) throws and rolls the caller's transaction back.
 *
 * Locks, in this order: idempotency (framework) -> `stock-doc:<id>` -> `stock:<variantId>`
 * ascending (taken here before the stock-dependent checks, and again, re-entrantly, by
 * postMovements) -> `stock-doc-number` last, then the counter row. The document is re-read under
 * its lock, so two posts of one draft write once: the second sees POSTED and gets DOCUMENT_POSTED.
 * The number comes from RtStockCounter in the same transaction, so a refused or rolled-back post
 * consumes none (gap-free per business).
 */

export type Tx = Prisma.TransactionClient;
export type LockBusiness = (name: string) => Promise<void>;

export const MAX_DOCUMENT_LINES = 500;

export const documentLock = (documentId: string) => `stock-doc:${documentId}`;
export const DOCUMENT_NUMBER_LOCK = "stock-doc-number";

// ---------------------------------------------------------------------------------------------
// Results

export type StockWarning = { lineNo: number; code: "EXPIRED" | "COST_MISSING" | "COST_UNKNOWN" };

/** Cost fields: present only for a caller with cost.view. */
export type CostFields = { currency: Currency | null; unitCostMinor: bigint | null; rateMicro: bigint | null; valueMinor: bigint };

export type PostedLine = {
  lineNo: number;
  variantId: string;
  unitId: string;
  /** Base units x 1000. */
  quantity: bigint;
  enteredQuantity: string;
  batchId: string | null;
  batchCode: string | null;
  /** YYYY-MM-DD or null. */
  expiryDate: string | null;
  /** The batch is past its expiry date in the business's today (an OPENING only): never available. */
  expired: boolean;
  /** An OPENING line without a cost, valued 0. */
  costMissing: boolean;
} & Partial<CostFields>;

export type PostedDocument = {
  documentId: string;
  kind: RtStockDocumentKind;
  /** ADJUSTMENT / WRITE_OFF only. */
  direction: RtStockDirection | null;
  /** REVERSAL only: the document it negates. */
  reversesDocumentId: string | null;
  number: number;
  lines: PostedLine[];
  warnings: StockWarning[];
};

const COST_KEYS = ["currency", "unitCostMinor", "rateMicro", "valueMinor"] as const;

export function stripCosts<T extends object>(o: T): T {
  const out = { ...o } as Record<string, unknown>;
  for (const k of COST_KEYS) delete out[k];
  return out as T;
}

/** The post result without any cost field (what a caller without cost.view, and the idempotency row, get). */
export function withoutCosts(p: PostedDocument): PostedDocument {
  return { ...p, lines: p.lines.map(stripCosts) };
}

// ---------------------------------------------------------------------------------------------
// Line checks

export type Business = { defaultCurrency: Currency; enabledCurrencies: Currency[]; timezone: string };

/** A line as stored on a draft (typed values, parsed). */
export type LineData = {
  lineNo: number;
  variantId: string;
  unitId: string;
  enteredQuantity: string;
  batchCode: string | null;
  expiryDate: Date | null;
  currency: Currency | null;
  unitCostMinor: bigint | null;
  rateMicro: bigint | null;
};

export type CatalogUnit = { id: string; variantId: string; factor: number; quantityScale: number; archivedAt: Date | null };
export type CatalogVariant = {
  id: string;
  archivedAt: Date | null;
  product: { trackingMode: RtTrackingMode; tracksExpiry: boolean; isTestData: boolean; archivedAt: Date | null };
};
export type Catalog = { variants: Map<string, CatalogVariant>; units: Map<string, CatalogUnit> };

export const refuse = (lineNo: number, reason: string): never => {
  throw new RuleError("STOCK_RULE", { lineNo: String(lineNo), reason });
};
export const invalid = (lineNo: number): never => {
  throw new RuleError("INVALID_INPUT", { lineNo: String(lineNo) });
};

export async function loadCatalog(tx: Tx, lines: { variantId: string; unitId: string }[]): Promise<Catalog> {
  const variantIds = [...new Set(lines.map((l) => l.variantId))];
  const unitIds = [...new Set(lines.map((l) => l.unitId))];
  const [variants, units] = await Promise.all([
    tx.rtVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, archivedAt: true, product: { select: { trackingMode: true, tracksExpiry: true, isTestData: true, archivedAt: true } } },
    }),
    tx.rtUnit.findMany({
      where: { id: { in: unitIds } },
      select: { id: true, variantId: true, factor: true, quantityScale: true, archivedAt: true },
    }),
  ]);
  return { variants: new Map(variants.map((v) => [v.id, v])), units: new Map(units.map((u) => [u.id, u])) };
}

/**
 * The checks that hold for a draft and again at posting (see documents.ts). Returns the line's
 * variant, unit and quantity in base units x 1000 (with the unit's current factor). `allowArchived`
 * lets an outflow take stock of an archived item.
 */
export function checkLine(
  l: LineData,
  catalog: Catalog,
  biz: Business,
  opts: { allowArchived?: boolean } = {},
): { variant: CatalogVariant; unit: CatalogUnit; quantity: bigint } {
  const variant = catalog.variants.get(l.variantId);
  const unit = catalog.units.get(l.unitId);
  if (!variant || !unit) throw new NotFoundError();
  if (unit.variantId !== variant.id) refuse(l.lineNo, "UNIT_NOT_OF_VARIANT");
  if (variant.product.isTestData) throw new RuleError("TEST_ITEM", { lineNo: String(l.lineNo) });
  if (variant.product.trackingMode === "SERIAL") throw new RuleError("SERIAL_NOT_SUPPORTED", { lineNo: String(l.lineNo) });
  if (!opts.allowArchived && (variant.archivedAt || variant.product.archivedAt || unit.archivedAt)) refuse(l.lineNo, "ARCHIVED");
  let quantity: bigint;
  try {
    quantity = toBaseQty(l.enteredQuantity, unit);
  } catch (err) {
    if (err instanceof RuleError) return invalid(l.lineNo);
    throw err;
  }
  if (l.currency !== null && !biz.enabledCurrencies.includes(l.currency)) refuse(l.lineNo, "CURRENCY_NOT_ENABLED");
  if ((l.batchCode !== null || l.expiryDate !== null) && variant.product.trackingMode !== "BATCH") refuse(l.lineNo, "BATCH_NOT_TRACKED");
  return { variant, unit, quantity };
}

export const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** A base quantity back to the typed unit's text, e.g. 1750 grams of a 3-decimal kg -> "1.75". */
function formatQty(base: bigint, unit: CatalogUnit): string {
  const pow = 10n ** BigInt(unit.quantityScale);
  const scaled = (base * pow) / (BigInt(unit.factor) * QTY_SCALE);
  const int = scaled / pow;
  const frac = (scaled % pow).toString().padStart(unit.quantityScale, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : `${int}`;
}

// ---------------------------------------------------------------------------------------------
// Shared pieces

export async function businessOf(tx: Tx): Promise<Business> {
  return tx.rtBusiness.findFirstOrThrow({ select: { defaultCurrency: true, enabledCurrencies: true, timezone: true } });
}

/**
 * The default location of the actor's branch: the oldest active branch the actor can reach and
 * that branch's oldest location (R2 has one location per branch, created with the branch).
 */
export async function defaultPlace(tx: Tx): Promise<{ branchId: string; locationId: string }> {
  const branch = await tx.rtBranch.findFirst({ where: { active: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
  if (!branch) throw new RuleError("STOCK_RULE", { reason: "NO_LOCATION" });
  const location = await tx.rtLocation.findFirst({
    where: { branchId: branch.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!location) throw new RuleError("STOCK_RULE", { reason: "NO_LOCATION" });
  return { branchId: branch.id, locationId: location.id };
}

/** Locks the document and reads it; NOT_FOUND outside the actor's scope, DOCUMENT_POSTED once posted. */
export async function lockDraft(tx: Tx, documentId: string, lockBusiness: LockBusiness) {
  await lockBusiness(documentLock(documentId));
  const doc = await tx.rtStockDocument.findFirst({
    where: { id: documentId },
    select: {
      id: true,
      kind: true,
      status: true,
      version: true,
      branchId: true,
      locationId: true,
      direction: true,
      reversesDocumentId: true,
      importBatchId: true,
    },
  });
  if (!doc) throw new NotFoundError();
  if (doc.status === "POSTED") throw new RuleError("DOCUMENT_POSTED");
  return doc;
}

type LockedDoc = Awaited<ReturnType<typeof lockDraft>>;

/** The next document number of the business (taken last, after the stock locks). */
async function nextDocumentNumber(tx: Tx, businessId: string, lockBusiness: LockBusiness): Promise<number> {
  await lockBusiness(DOCUMENT_NUMBER_LOCK);
  await tx.rtStockCounter.createMany({ data: [{ businessId }], skipDuplicates: true });
  const row = await tx.rtStockCounter.update({ where: { businessId }, data: { nextNumber: { increment: 1 } }, select: { nextNumber: true } });
  return row.nextNumber - 1;
}

const lockVariants = async (variantIds: string[], lockBusiness: LockBusiness) => {
  for (const v of [...new Set(variantIds)].sort()) await lockBusiness(`stock:${v}`);
};

// ---------------------------------------------------------------------------------------------
// Posting core

type Posting = { lines: PostedLine[]; warnings: StockWarning[] };

/**
 * Posts a DRAFT document of this actor's scope (see the header for each kind): writes its
 * movements, numbers it and marks it POSTED. Runs inside the caller's action transaction (scoped
 * tx); the caller has checked the permission and which kinds it may post. `expectedVersion` (when
 * given) must match the draft's version (VERSION_CONFLICT otherwise). Returns the full result,
 * costs included.
 */
export async function postDocumentInTx(
  tx: Tx,
  actor: Actor,
  documentId: string,
  lockBusiness: LockBusiness,
  expectedVersion?: number,
): Promise<PostedDocument> {
  const doc = await lockDraft(tx, documentId, lockBusiness);
  if (expectedVersion !== undefined && doc.version !== expectedVersion) throw new VersionConflictError();

  let posting: Posting;
  switch (doc.kind) {
    case "OPENING":
    case "RECEIPT":
      posting = await postTypedLines(tx, actor, doc, lockBusiness);
      break;
    case "ADJUSTMENT":
    case "WRITE_OFF":
      posting = await postAdjustmentLines(tx, actor, doc, lockBusiness);
      break;
    case "REVERSAL":
      posting = await postReversalLines(tx, actor, doc, lockBusiness);
      break;
  }

  const number = await nextDocumentNumber(tx, actor.businessId, lockBusiness);
  await updateVersioned(tx.rtStockDocument, { id: documentId, status: "DRAFT" }, doc.version, {
    status: "POSTED",
    number,
    postedAt: new Date(),
    postedById: actor.userId,
  });
  return {
    documentId,
    kind: doc.kind,
    direction: doc.direction,
    reversesDocumentId: doc.reversesDocumentId,
    number,
    lines: posting.lines,
    warnings: posting.warnings,
  };
}

const lineSelect = {
  id: true,
  lineNo: true,
  variantId: true,
  unitId: true,
  enteredQuantity: true,
  batchId: true,
  batchCode: true,
  expiryDate: true,
  currency: true,
  unitCostMinor: true,
  rateMicro: true,
  quantity: true,
  valueMinor: true,
} as const;

async function readLines(tx: Tx, documentId: string) {
  const rows = await tx.rtStockLine.findMany({ where: { documentId }, orderBy: { lineNo: "asc" }, select: lineSelect });
  if (rows.length === 0) throw new RuleError("STOCK_RULE", { reason: "EMPTY" });
  if (rows.length > MAX_DOCUMENT_LINES) throw new RuleError("INVALID_INPUT");
  return rows;
}

type Group = {
  first: { id: string } & LineData;
  others: string[];
  variant: CatalogVariant;
  unit: CatalogUnit;
  quantity: bigint;
};

/** OPENING / RECEIPT: the rules of documents.ts. */
async function postTypedLines(tx: Tx, actor: Actor, doc: LockedDoc, lockBusiness: LockBusiness): Promise<Posting> {
  const rows = await readLines(tx, doc.id);
  // Variant locks first: a catalog edit (unit factor, tracking flags) takes the same locks, so what we
  // read next is not changed under us.
  await lockVariants(rows.map((r) => r.variantId), lockBusiness);
  const biz = await businessOf(tx);
  const catalog = await loadCatalog(tx, rows);
  const today = businessToday(new Date(), biz.timezone);

  // Every line checked before any write; equal lines grouped.
  const groups = new Map<string, Group>();
  for (const l of rows) {
    const { variant, unit, quantity } = checkLine(l, catalog, biz);
    if (doc.kind === "RECEIPT" && l.unitCostMinor === null) refuse(l.lineNo, "COST_REQUIRED");
    if (l.currency !== null && l.currency !== biz.defaultCurrency && l.rateMicro === null) refuse(l.lineNo, "RATE_REQUIRED");
    if (variant.product.tracksExpiry && l.expiryDate === null) refuse(l.lineNo, "EXPIRY_REQUIRED");
    if (doc.kind === "RECEIPT" && expiryStatus(l.expiryDate, today, 0) === "EXPIRED") refuse(l.lineNo, "EXPIRED");
    const key = JSON.stringify([
      l.variantId,
      l.unitId,
      l.batchCode,
      isoDay(l.expiryDate),
      l.currency,
      l.unitCostMinor?.toString() ?? null,
      l.currency === biz.defaultCurrency ? null : (l.rateMicro?.toString() ?? null),
    ]);
    const g = groups.get(key);
    if (g) {
      g.quantity += quantity;
      g.others.push(l.id);
      if (g.quantity > MAX_BASE_QTY) invalid(g.first.lineNo);
    } else {
      groups.set(key, { first: l, others: [], variant, unit, quantity });
    }
  }

  // The stock-dependent checks run under the variants' locks (taken above; postMovements takes them again).
  if (doc.kind === "OPENING") await refuseOpeningAfterMovement(tx, doc.locationId, [...groups.values()]);

  const batchIds = await resolveBatches(tx, actor.businessId, [...groups.values()]);

  const lines: PostedLine[] = [];
  const warnings: StockWarning[] = [];
  for (const g of groups.values()) {
    const l = g.first;
    const enteredQuantity = g.others.length > 0 ? formatQty(g.quantity, g.unit) : l.enteredQuantity;
    let valueMinor = 0n;
    if (l.unitCostMinor !== null && l.currency !== null) {
      const rate = l.currency === biz.defaultCurrency ? null : l.rateMicro;
      try {
        valueMinor = convertMinor(lineValueMinor(l.unitCostMinor, enteredQuantity, g.unit), l.currency, biz.defaultCurrency, rate);
      } catch (err) {
        if (err instanceof RuleError) return invalid(l.lineNo);
        throw err;
      }
      if (valueMinor > MAX_PRICE_MINOR) invalid(l.lineNo);
    }
    const batchId = batchIds.get(batchKey(l.variantId, l.batchCode, l.expiryDate)) ?? null;
    const expired = expiryStatus(l.expiryDate, today, 0) === "EXPIRED";
    const costMissing = l.unitCostMinor === null;
    if (expired) warnings.push({ lineNo: l.lineNo, code: "EXPIRED" });
    if (costMissing) warnings.push({ lineNo: l.lineNo, code: "COST_MISSING" });
    lines.push({
      lineNo: l.lineNo,
      variantId: l.variantId,
      unitId: l.unitId,
      quantity: g.quantity,
      enteredQuantity,
      batchId,
      batchCode: l.batchCode,
      expiryDate: isoDay(l.expiryDate),
      expired,
      costMissing,
      currency: l.currency,
      unitCostMinor: l.unitCostMinor,
      rateMicro: l.currency === biz.defaultCurrency ? null : l.rateMicro,
      valueMinor,
    });
  }

  // Writes: merged lines, then each line's resolved quantity, batch and value, then the ledger.
  const merged = [...groups.values()].flatMap((g) => g.others);
  if (merged.length > 0) await tx.rtStockLine.deleteMany({ where: { id: { in: merged } } });
  const groupList = [...groups.values()];
  for (let i = 0; i < groupList.length; i++) {
    const p = lines[i]!;
    await tx.rtStockLine.update({
      where: { id: groupList[i]!.first.id },
      data: { quantity: p.quantity, enteredQuantity: p.enteredQuantity, batchId: p.batchId, valueMinor: p.valueMinor, rateMicro: p.rateMicro },
    });
  }
  await postMovements(
    tx,
    {
      businessId: actor.businessId,
      documentId: doc.id,
      branchId: doc.branchId,
      locationId: doc.locationId,
      lines: groupList.map((g, i) => ({
        lineId: g.first.id,
        variantId: g.first.variantId,
        batchId: lines[i]!.batchId,
        qtyDelta: g.quantity,
        valueDeltaMinor: lines[i]!.valueMinor,
      })),
    },
    lockBusiness,
  );
  return { lines, warnings };
}

/** Half-up share of `value` for `qty` out of `total` (total > 0). */
function shareOf(value: bigint, qty: bigint, total: bigint): bigint {
  return (value * qty * 2n + total) / (total * 2n);
}

/**
 * ADJUSTMENT / WRITE_OFF: the lines name their batch (checked by the action that created them:
 * required for a tracksExpiry product, optional for another BATCH product, of the line's variant)
 * and carry no cost; see the header for values.
 */
async function postAdjustmentLines(tx: Tx, actor: Actor, doc: LockedDoc, lockBusiness: LockBusiness): Promise<Posting> {
  const direction = doc.direction;
  if (direction === null || (doc.kind === "WRITE_OFF" && direction !== "OUT")) throw new Error("postAdjustmentLines: bad direction");
  const rows = await readLines(tx, doc.id);
  await lockVariants(rows.map((r) => r.variantId), lockBusiness); // before reading the catalog, as in postTypedLines
  const biz = await businessOf(tx);
  const catalog = await loadCatalog(tx, rows);
  const checked = rows.map((l) => {
    // batchCode/expiryDate are copied from the named batch; the batch itself is checked here.
    const c = checkLine(l, catalog, biz, { allowArchived: direction === "OUT" });
    const batch = c.variant.product.trackingMode === "BATCH";
    if (batch && c.variant.product.tracksExpiry && l.batchId === null) refuse(l.lineNo, "BATCH_REQUIRED");
    if (!batch && l.batchId !== null) refuse(l.lineNo, "BATCH_NOT_TRACKED");
    return c;
  });

  // IN: the average under the locks, before this document (several IN lines of one variant all
  // take the same average). OUT: the ledger's value.
  const warnings: StockWarning[] = [];
  const inValues: bigint[] = [];
  if (direction === "IN") {
    const averages = new Map<string, { qty: bigint; valueMinor: bigint }>();
    for (let i = 0; i < rows.length; i++) {
      const l = rows[i]!;
      let avg = averages.get(l.variantId);
      if (!avg) {
        avg = await variantAverage(tx, doc.locationId, l.variantId);
        averages.set(l.variantId, avg);
      }
      if (avg.qty === 0n) warnings.push({ lineNo: l.lineNo, code: "COST_UNKNOWN" });
      const value = avg.qty === 0n ? 0n : shareOf(avg.valueMinor, checked[i]!.quantity, avg.qty);
      if (value > MAX_PRICE_MINOR) invalid(l.lineNo);
      inValues.push(value);
    }
  }

  const posted = await postMovements(
    tx,
    {
      businessId: actor.businessId,
      documentId: doc.id,
      branchId: doc.branchId,
      locationId: doc.locationId,
      lines: rows.map((l, i): LedgerLine => {
        const qty = checked[i]!.quantity;
        return direction === "IN"
          ? { lineId: l.id, variantId: l.variantId, batchId: l.batchId, qtyDelta: qty, valueDeltaMinor: inValues[i]! }
          : { lineId: l.id, variantId: l.variantId, batchId: l.batchId, qtyDelta: -qty };
      }),
    },
    lockBusiness,
  );

  const lines: PostedLine[] = [];
  for (let i = 0; i < rows.length; i++) {
    const l = rows[i]!;
    const { quantity, unit } = checked[i]!;
    const valueMinor = posted[i]!.valueDeltaMinor < 0n ? -posted[i]!.valueDeltaMinor : posted[i]!.valueDeltaMinor;
    const cost = unitCostMinor(quantity, valueMinor, unit.factor);
    await tx.rtStockLine.update({
      where: { id: l.id },
      data: { quantity, valueMinor, currency: biz.defaultCurrency, unitCostMinor: cost, rateMicro: null },
    });
    lines.push({
      lineNo: l.lineNo,
      variantId: l.variantId,
      unitId: l.unitId,
      quantity,
      enteredQuantity: l.enteredQuantity,
      batchId: l.batchId,
      batchCode: l.batchCode,
      expiryDate: isoDay(l.expiryDate),
      expired: false,
      costMissing: false,
      currency: biz.defaultCurrency,
      unitCostMinor: cost,
      rateMicro: null,
      valueMinor,
    });
  }
  return { lines, warnings };
}

/**
 * REVERSAL: the lines were copied from the original's lines (same numbers); every movement of the
 * original is negated exactly onto the reversal line of the same number.
 */
async function postReversalLines(tx: Tx, actor: Actor, doc: LockedDoc, lockBusiness: LockBusiness): Promise<Posting> {
  const originalId = doc.reversesDocumentId;
  if (originalId === null) throw new Error("postReversalLines: no original document");
  const rows = await readLines(tx, doc.id);
  const [originalLines, originalMoves] = await Promise.all([
    tx.rtStockLine.findMany({ where: { documentId: originalId }, select: { id: true, lineNo: true } }),
    tx.rtStockMovement.findMany({
      where: { documentId: originalId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { lineId: true, variantId: true, batchId: true, qtyDelta: true, valueDeltaMinor: true },
    }),
  ]);
  if (originalMoves.length === 0) throw new RuleError("STOCK_RULE", { reason: "EMPTY" });
  const lineNoOf = new Map(originalLines.map((l) => [l.id, l.lineNo]));
  const reversalLineOf = new Map(rows.map((r) => [r.lineNo, r.id]));
  await postMovements(
    tx,
    {
      businessId: actor.businessId,
      documentId: doc.id,
      branchId: doc.branchId,
      locationId: doc.locationId,
      exactValues: true,
      lines: originalMoves.map((m) => {
        const lineId = reversalLineOf.get(lineNoOf.get(m.lineId) ?? -1);
        if (!lineId) throw new Error("postReversalLines: a movement has no mirrored line");
        return { lineId, variantId: m.variantId, batchId: m.batchId, qtyDelta: -m.qtyDelta, valueDeltaMinor: -m.valueDeltaMinor };
      }),
    },
    lockBusiness,
  );
  const lines = rows.map(
    (l): PostedLine => ({
      lineNo: l.lineNo,
      variantId: l.variantId,
      unitId: l.unitId,
      quantity: l.quantity,
      enteredQuantity: l.enteredQuantity,
      batchId: l.batchId,
      batchCode: l.batchCode,
      expiryDate: isoDay(l.expiryDate),
      expired: false,
      costMissing: l.unitCostMinor === null,
      currency: l.currency,
      unitCostMinor: l.unitCostMinor,
      rateMicro: l.rateMicro,
      valueMinor: l.valueMinor ?? 0n,
    }),
  );
  return { lines, warnings: [] };
}

/**
 * OPENING adds while the (location, variant) has only OPENING movements; anything else refuses.
 * Bounded: the OPENING documents of the location, then one SQL GROUP BY variantId over the
 * movements of any other document, so at most one row per variant comes back (Prisma's `distinct`
 * would be applied in memory after reading every movement).
 */
async function refuseOpeningAfterMovement(tx: Tx, locationId: string, groups: Group[]): Promise<void> {
  const variantIds = [...new Set(groups.map((g) => g.first.variantId))];
  const openings = await tx.rtStockDocument.findMany({ where: { locationId, kind: "OPENING", status: "POSTED" }, select: { id: true } });
  const moved = await tx.rtStockMovement.groupBy({
    by: ["variantId"],
    where: { locationId, variantId: { in: variantIds }, documentId: { notIn: openings.map((o) => o.id) } },
  });
  if (moved.length === 0) return;
  const blocked = new Set(moved.map((m) => m.variantId));
  const first = groups.find((g) => blocked.has(g.first.variantId));
  if (first) refuse(first.first.lineNo, "OPENING_AFTER_MOVEMENT");
}

const batchKey = (variantId: string, code: string | null, expiry: Date | null) => JSON.stringify([variantId, code, isoDay(expiry)]);

/**
 * The batch of every line that names a code or an expiry date (none for a line with neither),
 * created when missing. INSERT ... ON CONFLICT DO NOTHING then a read: the unique key has NULLs
 * (NULLS NOT DISTINCT), which Prisma's upsert cannot select, and a caught P2002 would abort the
 * transaction.
 */
async function resolveBatches(tx: Tx, businessId: string, groups: Group[]): Promise<Map<string, string>> {
  const wanted = new Map<string, { variantId: string; code: string | null; expiryDate: Date | null }>();
  for (const g of groups) {
    const l = g.first;
    if (l.batchCode === null && l.expiryDate === null) continue;
    wanted.set(batchKey(l.variantId, l.batchCode, l.expiryDate), { variantId: l.variantId, code: l.batchCode, expiryDate: l.expiryDate });
  }
  const out = new Map<string, string>();
  if (wanted.size === 0) return out;
  const keys = [...wanted.values()];
  await tx.rtBatch.createMany({ data: keys.map((k) => ({ businessId, ...k })), skipDuplicates: true });
  const found = await tx.rtBatch.findMany({
    where: { OR: keys.map((k) => ({ variantId: k.variantId, code: k.code, expiryDate: k.expiryDate })) },
    select: { id: true, variantId: true, code: true, expiryDate: true },
  });
  for (const b of found) out.set(batchKey(b.variantId, b.code, b.expiryDate), b.id);
  if (out.size !== wanted.size) throw new Error("resolveBatches: a batch is missing after insert");
  return out;
}
