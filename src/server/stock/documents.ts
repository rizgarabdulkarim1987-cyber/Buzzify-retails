import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { Currency, RtStockDocumentKind, type RtTrackingMode } from "@/generated/prisma/enums";
import { MAX_PRICE_MINOR } from "@/server/catalog/price-core";
import { parseMoneyText } from "@/server/domain/catalog";
import { can } from "@/server/domain/permissions";
import {
  MAX_BASE_QTY,
  QTY_SCALE,
  businessToday,
  convertMinor,
  expiryStatus,
  lineValueMinor,
  parseRate,
  toBaseQty,
} from "@/server/domain/stock";
import type { Actor } from "@/server/framework/actor";
import { defineAction } from "@/server/framework/action";
import { NotFoundError, RuleError, VersionConflictError } from "@/server/framework/errors";
import { updateVersioned } from "@/server/framework/versioned";
import { postMovements } from "./ledger";

/*
 * Stock documents: receipts (RECEIPT) and opening balances (OPENING). A document is saved as a
 * DRAFT (lines as typed, no number, no movement), and posting writes its movements through the
 * ledger, gives it the next number of the business and freezes it.
 *
 * Writes need stock.receive; reads need stock.view. Values and costs (a line's currency, unit
 * cost, rate and value) are returned only to a caller with cost.view, and the stored idempotency
 * value of a post never holds them (storedValue), so a replay shows none either (spec 3.10).
 *
 * Rules:
 * - A document is in the default location of the actor's branch: the oldest active branch the
 *   actor can reach and that branch's oldest location (R2 has one location per branch, created
 *   with the branch). Resolved when the draft is created and kept on the document.
 * - At most MAX_DOCUMENT_LINES lines, at draft save (INVALID_INPUT) and at posting.
 * - Every line is checked before anything is written. At save: the variant and unit exist in
 *   this business (NOT_FOUND), the unit is the variant's, nothing is archived, the product is not
 *   a trial item (TEST_ITEM) nor SERIAL (SERIAL_NOT_SUPPORTED), the quantity fits the unit's
 *   decimals and MAX_BASE_QTY, the cost parses in its currency, the currency is enabled, and a
 *   batch or expiry is only given for a BATCH product. At posting the same checks run again on the
 *   current catalog, plus: a RECEIPT line needs a cost (an OPENING line without one is valued 0
 *   and flagged costMissing), a cost in another currency than the business's needs a rate, a
 *   tracksExpiry product needs an expiry date, and an expiry before the business's today is
 *   refused for a RECEIPT and accepted with an EXPIRED warning for an OPENING (the batch is then
 *   expired, so never available). Refusals are STOCK_RULE with details {lineNo, reason}.
 * - Quantities are converted at posting with the unit's current factor (spec R-D). A line's value
 *   is lineValueMinor in its currency, converted to the business's default currency (convertMinor,
 *   half up), at most MAX_PRICE_MINOR.
 * - Lines with the same variant, unit, batch code, expiry date, currency, unit cost and rate are
 *   merged into one at posting (the first keeps its number; the others are deleted). Lines that
 *   differ in price stay separate lines of the same balance.
 * - An OPENING may be posted for a (location, variant) as often as needed (each adds), until that
 *   variant has a movement of any other kind at that location; then STOCK_RULE.
 *
 * Locks, in this order: idempotency (framework) -> `stock-doc:<id>` -> `stock:<variantId>`
 * ascending (taken here before the stock-dependent checks, and again, re-entrantly, by
 * postMovements) -> `stock-doc-number` last, then the counter row. The document is re-read under
 * its lock, so two posts of one draft (two tabs, two keys) write once: the second sees POSTED and
 * gets DOCUMENT_POSTED. The number comes from RtStockCounter in the same transaction, so a refused
 * or rolled-back post consumes none (gap-free per business).
 *
 * postDocumentInTx is the posting core shared with the adjustments (Task 5) and the opening import
 * (Task 7); it returns the full result with costs, and each caller decides what to show.
 */

type Tx = Prisma.TransactionClient;

export const MAX_DOCUMENT_LINES = 500;
export const MAX_BATCH_CODE_LENGTH = 64;
const MAX_SUPPLIER_REF_LENGTH = 200;
const MAX_NOTE_LENGTH = 1000;
const LIST_LIMIT = 50;

export const documentLock = (documentId: string) => `stock-doc:${documentId}`;
export const DOCUMENT_NUMBER_LOCK = "stock-doc-number";

// ---------------------------------------------------------------------------------------------
// Input schemas

const id = z.string().min(1).max(64);
const version = z.number().int().min(1);
/** Trimmed text; missing or blank -> null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

function isRealDate(text: string): boolean {
  const d = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

const draftLine = z
  .object({
    variantId: id,
    unitId: id,
    /** As typed in the unit (Arabic digits accepted), e.g. "2" cartons or "1.5" kg. */
    quantity: z.string().min(1).max(40),
    /** Cost of one typed unit, as typed in its currency (e.g. "2.37" USD). */
    cost: z.object({ amount: z.string().min(1).max(40), currency: z.enum(Currency) }).strict().optional(),
    /** Business currency per 1 unit of the cost's currency (e.g. "1310"); ignored for the business's own currency. */
    rate: z.string().min(1).max(40).optional(),
    batchCode: optionalText(MAX_BATCH_CODE_LENGTH),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate).optional(),
  })
  .strict();

export type DraftLineInput = z.input<typeof draftLine>;

const saveInput = z
  .object({
    documentId: id.optional(),
    expectedVersion: version.optional(),
    kind: z.enum(["OPENING", "RECEIPT"]),
    supplierRef: optionalText(MAX_SUPPLIER_REF_LENGTH),
    note: optionalText(MAX_NOTE_LENGTH),
    lines: z.array(draftLine).max(MAX_DOCUMENT_LINES),
  })
  .strict()
  .refine((v) => (v.documentId === undefined) === (v.expectedVersion === undefined));

const versionedInput = z.object({ documentId: id, expectedVersion: version }).strict();

// ---------------------------------------------------------------------------------------------
// Results

export type StockWarning = { lineNo: number; code: "EXPIRED" | "COST_MISSING" };

/** Cost fields: present only for a caller with cost.view. */
type CostFields = { currency: Currency | null; unitCostMinor: bigint | null; rateMicro: bigint | null; valueMinor: bigint };

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
  number: number;
  lines: PostedLine[];
  warnings: StockWarning[];
};

export type DocumentLine = {
  id: string;
  lineNo: number;
  variantId: string;
  unitId: string;
  quantity: bigint;
  enteredQuantity: string;
  batchId: string | null;
  batchCode: string | null;
  expiryDate: string | null;
  costMissing: boolean;
} & Partial<Omit<CostFields, "valueMinor"> & { valueMinor: bigint | null }>;

export type StockDocumentView = {
  id: string;
  kind: RtStockDocumentKind;
  status: "DRAFT" | "POSTED";
  number: number | null;
  supplierRef: string | null;
  note: string | null;
  branchId: string;
  locationId: string;
  version: number;
  createdAt: Date;
  postedAt: Date | null;
  lines: DocumentLine[];
};

export type StockDocumentRow = Omit<StockDocumentView, "lines"> & { lineCount: number };

const COST_KEYS = ["currency", "unitCostMinor", "rateMicro", "valueMinor"] as const;

function stripCosts<T extends object>(o: T): T {
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

type Business = { defaultCurrency: Currency; enabledCurrencies: Currency[]; timezone: string };

/** A line as stored on a draft (typed values, parsed). */
type LineData = {
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

type CatalogUnit = { id: string; variantId: string; factor: number; quantityScale: number; archivedAt: Date | null };
type CatalogVariant = {
  id: string;
  archivedAt: Date | null;
  product: { trackingMode: RtTrackingMode; tracksExpiry: boolean; isTestData: boolean; archivedAt: Date | null };
};
type Catalog = { variants: Map<string, CatalogVariant>; units: Map<string, CatalogUnit> };

const refuse = (lineNo: number, reason: string): never => {
  throw new RuleError("STOCK_RULE", { lineNo: String(lineNo), reason });
};
const invalid = (lineNo: number): never => {
  throw new RuleError("INVALID_INPUT", { lineNo: String(lineNo) });
};

async function loadCatalog(tx: Tx, lines: { variantId: string; unitId: string }[]): Promise<Catalog> {
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
 * The checks that hold for a draft and again at posting (see the header). Returns the line's
 * variant, unit and quantity in base units x 1000 (with the unit's current factor).
 */
function checkLine(l: LineData, catalog: Catalog, biz: Business): { variant: CatalogVariant; unit: CatalogUnit; quantity: bigint } {
  const variant = catalog.variants.get(l.variantId);
  const unit = catalog.units.get(l.unitId);
  if (!variant || !unit) throw new NotFoundError();
  if (unit.variantId !== variant.id) refuse(l.lineNo, "UNIT_NOT_OF_VARIANT");
  if (variant.product.isTestData) throw new RuleError("TEST_ITEM", { lineNo: String(l.lineNo) });
  if (variant.product.trackingMode === "SERIAL") throw new RuleError("SERIAL_NOT_SUPPORTED", { lineNo: String(l.lineNo) });
  if (variant.archivedAt || variant.product.archivedAt || unit.archivedAt) refuse(l.lineNo, "ARCHIVED");
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

/** Typed draft lines to stored values; refuses what can never post (see checkLine). */
function parseDraftLine(raw: z.infer<typeof draftLine>, lineNo: number, biz: Business): LineData {
  let currency: Currency | null = null;
  let unitCostMinor: bigint | null = null;
  let rateMicro: bigint | null = null;
  if (raw.cost) {
    currency = raw.cost.currency;
    try {
      unitCostMinor = parseMoneyText(raw.cost.amount, currency);
    } catch {
      return invalid(lineNo);
    }
    if (unitCostMinor > MAX_PRICE_MINOR) invalid(lineNo);
    if (currency !== biz.defaultCurrency && raw.rate !== undefined) {
      try {
        rateMicro = parseRate(raw.rate);
      } catch {
        return invalid(lineNo);
      }
    }
  } else if (raw.rate !== undefined) {
    invalid(lineNo);
  }
  return {
    lineNo,
    variantId: raw.variantId,
    unitId: raw.unitId,
    enteredQuantity: raw.quantity.trim(),
    batchCode: raw.batchCode,
    expiryDate: raw.expiryDate ? new Date(`${raw.expiryDate}T00:00:00.000Z`) : null,
    currency,
    unitCostMinor,
    rateMicro,
  };
}

const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

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

async function businessOf(tx: Tx): Promise<Business> {
  return tx.rtBusiness.findFirstOrThrow({ select: { defaultCurrency: true, enabledCurrencies: true, timezone: true } });
}

/** The default location of the actor's branch (see the header). */
async function defaultPlace(tx: Tx): Promise<{ branchId: string; locationId: string }> {
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
async function lockDraft(tx: Tx, documentId: string, lockBusiness: (name: string) => Promise<void>) {
  await lockBusiness(documentLock(documentId));
  const doc = await tx.rtStockDocument.findFirst({
    where: { id: documentId },
    select: { id: true, kind: true, status: true, version: true, branchId: true, locationId: true },
  });
  if (!doc) throw new NotFoundError();
  if (doc.status === "POSTED") throw new RuleError("DOCUMENT_POSTED");
  return doc;
}

// ---------------------------------------------------------------------------------------------
// Posting core

type Group = {
  first: { id: string } & LineData;
  others: string[];
  variant: CatalogVariant;
  unit: CatalogUnit;
  quantity: bigint;
};

/**
 * Posts a DRAFT document of this actor's scope: checks every line, merges equal lines, resolves
 * the batches, values the lines, writes the movements, numbers the document and marks it POSTED.
 * Runs inside the caller's action transaction (scoped tx); the caller has checked the permission.
 * `expectedVersion` (when given) must match the draft's version (VERSION_CONFLICT otherwise).
 * Returns the full result, costs included.
 */
export async function postDocumentInTx(
  tx: Tx,
  actor: Actor,
  documentId: string,
  lockBusiness: (name: string) => Promise<void>,
  expectedVersion?: number,
): Promise<PostedDocument> {
  const doc = await lockDraft(tx, documentId, lockBusiness);
  if (expectedVersion !== undefined && doc.version !== expectedVersion) throw new VersionConflictError();
  if (doc.kind !== "OPENING" && doc.kind !== "RECEIPT") throw new RuleError("STOCK_RULE", { reason: "KIND" });

  const rows = await tx.rtStockLine.findMany({
    where: { documentId },
    orderBy: { lineNo: "asc" },
    select: {
      id: true,
      lineNo: true,
      variantId: true,
      unitId: true,
      enteredQuantity: true,
      batchCode: true,
      expiryDate: true,
      currency: true,
      unitCostMinor: true,
      rateMicro: true,
    },
  });
  if (rows.length === 0) throw new RuleError("STOCK_RULE", { reason: "EMPTY" });
  if (rows.length > MAX_DOCUMENT_LINES) throw new RuleError("INVALID_INPUT");

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

  // The stock-dependent checks run under the variants' locks (postMovements takes them again).
  const variantIds = [...new Set(rows.map((r) => r.variantId))].sort();
  for (const v of variantIds) await lockBusiness(`stock:${v}`);
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
      documentId,
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

  const number = await nextDocumentNumber(tx, actor.businessId, lockBusiness);
  await updateVersioned(tx.rtStockDocument, { id: documentId, status: "DRAFT" }, doc.version, {
    status: "POSTED",
    number,
    postedAt: new Date(),
    postedById: actor.userId,
  });
  return { documentId, kind: doc.kind, number, lines, warnings };
}

/** OPENING adds while the (location, variant) has only OPENING movements; anything else refuses. */
async function refuseOpeningAfterMovement(tx: Tx, locationId: string, groups: Group[]): Promise<void> {
  const variantIds = [...new Set(groups.map((g) => g.first.variantId))];
  const moved = await tx.rtStockMovement.findMany({
    where: { locationId, variantId: { in: variantIds } },
    distinct: ["documentId", "variantId"],
    select: { documentId: true, variantId: true },
  });
  if (moved.length === 0) return;
  const others = await tx.rtStockDocument.findMany({
    where: { id: { in: [...new Set(moved.map((m) => m.documentId))] }, kind: { not: "OPENING" } },
    select: { id: true },
  });
  const blocked = new Set(moved.filter((m) => others.some((o) => o.id === m.documentId)).map((m) => m.variantId));
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

/** The next document number of the business (taken last, after the stock locks). */
async function nextDocumentNumber(tx: Tx, businessId: string, lockBusiness: (name: string) => Promise<void>): Promise<number> {
  await lockBusiness(DOCUMENT_NUMBER_LOCK);
  await tx.rtStockCounter.createMany({ data: [{ businessId }], skipDuplicates: true });
  const row = await tx.rtStockCounter.update({ where: { businessId }, data: { nextNumber: { increment: 1 } }, select: { nextNumber: true } });
  return row.nextNumber - 1;
}

// ---------------------------------------------------------------------------------------------
// Draft writing

/**
 * Writes the lines of a draft (numbered from 1 in the given order). The document must be a DRAFT
 * the caller holds the lock of (or has just created).
 */
async function writeLines(tx: Tx, actor: Actor, doc: { id: string; branchId: string }, lines: LineData[], quantities: bigint[]) {
  if (lines.length === 0) return;
  await tx.rtStockLine.createMany({
    data: lines.map((l, i) => ({
      businessId: actor.businessId,
      branchId: doc.branchId,
      documentId: doc.id,
      lineNo: l.lineNo,
      variantId: l.variantId,
      unitId: l.unitId,
      batchCode: l.batchCode,
      expiryDate: l.expiryDate,
      quantity: quantities[i]!,
      enteredQuantity: l.enteredQuantity,
      currency: l.currency,
      unitCostMinor: l.unitCostMinor,
      rateMicro: l.rateMicro,
    })),
  });
}

// ---------------------------------------------------------------------------------------------
// Actions

/** Creates a draft (no documentId) or replaces a draft's header and lines (version-checked). */
export const saveStockDraft = defineAction({
  name: "stock.document.saveDraft",
  permission: "stock.receive",
  input: saveInput,
  writes: true,
  timeoutMs: 20_000,
  async run({ actor, tx, input, lockBusiness }): Promise<{ documentId: string; version: number }> {
    const biz = await businessOf(tx);
    const lines = input.lines.map((l, i) => parseDraftLine(l, i + 1, biz));
    const catalog = await loadCatalog(tx, lines);
    const quantities = lines.map((l) => checkLine(l, catalog, biz).quantity);
    const header = { kind: input.kind, supplierRef: input.supplierRef, note: input.note };

    if (input.documentId === undefined || input.expectedVersion === undefined) {
      const place = await defaultPlace(tx);
      const doc = await tx.rtStockDocument.create({
        data: { businessId: actor.businessId, ...place, ...header },
        select: { id: true, version: true, branchId: true },
      });
      await writeLines(tx, actor, doc, lines, quantities);
      return { documentId: doc.id, version: doc.version };
    }

    const doc = await lockDraft(tx, input.documentId, lockBusiness);
    await updateVersioned(tx.rtStockDocument, { id: doc.id, status: "DRAFT" }, input.expectedVersion, header);
    await tx.rtStockLine.deleteMany({ where: { documentId: doc.id } });
    await writeLines(tx, actor, doc, lines, quantities);
    return { documentId: doc.id, version: input.expectedVersion + 1 };
  },
  audit: (input, value) => ({
    entity: "RtStockDocument",
    entityId: value.documentId,
    changes: { kind: input.kind, lines: input.lines.length, version: value.version },
  }),
});

/** Deletes a draft and its lines (version-checked); a posted document is refused. */
export const discardStockDraft = defineAction({
  name: "stock.document.discard",
  permission: "stock.receive",
  input: versionedInput,
  writes: true,
  async run({ tx, input, lockBusiness }): Promise<{ documentId: string }> {
    const doc = await lockDraft(tx, input.documentId, lockBusiness);
    const { count } = await tx.rtStockDocument.deleteMany({ where: { id: doc.id, status: "DRAFT", version: input.expectedVersion } });
    if (count === 0) throw new VersionConflictError();
    return { documentId: doc.id };
  },
  audit: (input) => ({ entity: "RtStockDocument", entityId: input.documentId, changes: { discarded: true } }),
});

/** Posts a draft (see postDocumentInTx). Costs in the result only with cost.view; never stored. */
export const postStockDocument = defineAction({
  name: "stock.document.post",
  permission: "stock.receive",
  input: versionedInput,
  writes: true,
  timeoutMs: 30_000,
  async run({ actor, tx, input, lockBusiness }): Promise<PostedDocument> {
    const posted = await postDocumentInTx(tx, actor, input.documentId, lockBusiness, input.expectedVersion);
    return can(actor.role, "cost.view") ? posted : withoutCosts(posted);
  },
  storedValue: withoutCosts,
  audit: (input, value) => ({
    entity: "RtStockDocument",
    entityId: input.documentId,
    changes: { kind: value.kind, number: value.number, lines: value.lines.length, warnings: value.warnings.length },
  }),
});

const headerSelect = {
  id: true,
  kind: true,
  status: true,
  number: true,
  supplierRef: true,
  note: true,
  branchId: true,
  locationId: true,
  version: true,
  createdAt: true,
  postedAt: true,
} as const;

/** One document with its lines; costs only with cost.view. */
export const getStockDocument = defineAction({
  name: "stock.document.get",
  permission: "stock.view",
  input: z.object({ documentId: id }).strict(),
  writes: false,
  async run({ actor, tx, input }): Promise<StockDocumentView> {
    const doc = await tx.rtStockDocument.findFirst({ where: { id: input.documentId }, select: headerSelect });
    if (!doc) throw new NotFoundError();
    const rows = await tx.rtStockLine.findMany({
      where: { documentId: doc.id },
      orderBy: { lineNo: "asc" },
      select: {
        id: true,
        lineNo: true,
        variantId: true,
        unitId: true,
        quantity: true,
        enteredQuantity: true,
        batchId: true,
        batchCode: true,
        expiryDate: true,
        currency: true,
        unitCostMinor: true,
        rateMicro: true,
        valueMinor: true,
      },
    });
    const seeCost = can(actor.role, "cost.view");
    const lines = rows.map((r): DocumentLine => {
      const line: DocumentLine = {
        id: r.id,
        lineNo: r.lineNo,
        variantId: r.variantId,
        unitId: r.unitId,
        quantity: r.quantity,
        enteredQuantity: r.enteredQuantity,
        batchId: r.batchId,
        batchCode: r.batchCode,
        expiryDate: isoDay(r.expiryDate),
        costMissing: r.unitCostMinor === null,
      };
      return seeCost ? { ...line, currency: r.currency, unitCostMinor: r.unitCostMinor, rateMicro: r.rateMicro, valueMinor: r.valueMinor } : line;
    });
    return { ...doc, lines };
  },
});

/** Documents newest first, `limit` (<= 50) per page; `cursor` is the last id of the previous page. */
export const listStockDocuments = defineAction({
  name: "stock.document.list",
  permission: "stock.view",
  input: z
    .object({
      kind: z.enum(RtStockDocumentKind).optional(),
      cursor: id.optional(),
      limit: z.number().int().min(1).max(LIST_LIMIT).default(20),
    })
    .strict(),
  writes: false,
  async run({ tx, input }): Promise<{ rows: StockDocumentRow[]; nextCursor: string | null }> {
    const where: Prisma.RtStockDocumentWhereInput[] = [];
    if (input.kind) where.push({ kind: input.kind });
    if (input.cursor) {
      const at = await tx.rtStockDocument.findFirst({ where: { id: input.cursor }, select: { id: true, createdAt: true } });
      if (!at) throw new NotFoundError();
      where.push({ OR: [{ createdAt: { lt: at.createdAt } }, { createdAt: at.createdAt, id: { lt: at.id } }] });
    }
    const found = await tx.rtStockDocument.findMany({
      where: { AND: where },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      select: headerSelect,
    });
    const page = found.slice(0, input.limit);
    const counts = page.length
      ? await tx.rtStockLine.groupBy({ by: ["documentId"], where: { documentId: { in: page.map((d) => d.id) } }, _count: { _all: true } })
      : [];
    const countOf = new Map(counts.map((c) => [c.documentId, c._count._all]));
    return {
      rows: page.map((d) => ({ ...d, lineCount: countOf.get(d.id) ?? 0 })),
      nextCursor: found.length > input.limit ? page[page.length - 1]!.id : null,
    };
  },
});
