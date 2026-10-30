import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { Currency, RtStockDocumentKind, type RtStockDirection } from "@/generated/prisma/enums";
import { MAX_PRICE_MINOR } from "@/server/catalog/price-core";
import { parseMoneyText } from "@/server/domain/catalog";
import { can } from "@/server/domain/permissions";
import { parseRate } from "@/server/domain/stock";
import type { Actor } from "@/server/framework/actor";
import { defineAction } from "@/server/framework/action";
import { NotFoundError, RuleError, VersionConflictError } from "@/server/framework/errors";
import { updateVersioned } from "@/server/framework/versioned";
import {
  MAX_DOCUMENT_LINES,
  businessOf,
  checkLine,
  defaultPlace,
  invalid,
  isoDay,
  loadCatalog,
  lockDraft,
  postDocumentInTx,
  withoutCosts,
  type Business,
  type LineData,
  type LockBusiness,
  type PostedDocument,
  type Tx,
} from "./posting";

/*
 * Stock documents: receipts (RECEIPT) and opening balances (OPENING). A document is saved as a
 * DRAFT (lines as typed, no number, no movement), and posting writes its movements through the
 * ledger, gives it the next number of the business and freezes it. The posting core
 * (postDocumentInTx) lives in posting.ts, shared with the adjustments (adjust.ts) and the opening
 * import (Task 7).
 *
 * Writes need stock.receive; reads need stock.view. Values and costs (a line's currency, unit
 * cost, rate and value) are returned only to a caller with cost.view, and the stored idempotency
 * value of a post never holds them (storedValue), so a replay shows none either (spec 3.10).
 * The write actions only touch an OPENING or RECEIPT that did not come from an import (STOCK_RULE
 * {reason: KIND} otherwise, checked on the locked row); reads show every kind.
 *
 * Rules:
 * - A document is in the default location of the actor's branch: the oldest active branch the
 *   actor can reach and that branch's oldest location (R2 has one location per branch, created
 *   with the branch). Resolved when the draft is created and kept on the document.
 * - At most MAX_DOCUMENT_LINES lines, at draft save (INVALID_INPUT) and at posting.
 * - Every line is checked before anything is committed. At save: the variant and unit exist in
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
 * Locks: see posting.ts (idempotency -> `stock-doc:<id>` -> `stock:<variantId>` ascending ->
 * `stock-doc-number`).
 */

export { MAX_DOCUMENT_LINES } from "./posting";
export const MAX_BATCH_CODE_LENGTH = 64;
const MAX_SUPPLIER_REF_LENGTH = 200;
const MAX_NOTE_LENGTH = 1000;
const LIST_LIMIT = 50;

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

export type { PostedDocument, PostedLine, StockWarning } from "./posting";
export { withoutCosts } from "./posting";

type CostFields = { currency: Currency | null; unitCostMinor: bigint | null; rateMicro: bigint | null; valueMinor: bigint };

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
  /** ADJUSTMENT / WRITE_OFF (and a REVERSAL of one): one of STOCK_REASONS. */
  reason: string | null;
  direction: RtStockDirection | null;
  reversesDocumentId: string | null;
  branchId: string;
  locationId: string;
  version: number;
  createdAt: Date;
  postedAt: Date | null;
  lines: DocumentLine[];
};

export type StockDocumentRow = Omit<StockDocumentView, "lines"> & { lineCount: number };

// ---------------------------------------------------------------------------------------------
// Draft lines

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

/**
 * Locks a draft the receipt actions may touch: an OPENING or a RECEIPT that did not come from an
 * import. Adjustments, write-offs and reversals (stock.adjust, posted at once) and imported
 * documents (their own flow) are refused with STOCK_RULE {reason: KIND}, so a stock.receive-only
 * role cannot edit, discard or post them. Checked on the locked row.
 */
async function lockReceiptDraft(tx: Tx, documentId: string, lockBusiness: LockBusiness) {
  const doc = await lockDraft(tx, documentId, lockBusiness);
  if ((doc.kind !== "OPENING" && doc.kind !== "RECEIPT") || doc.importBatchId !== null) {
    throw new RuleError("STOCK_RULE", { reason: "KIND" });
  }
  return doc;
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

    const doc = await lockReceiptDraft(tx, input.documentId, lockBusiness);
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
    const doc = await lockReceiptDraft(tx, input.documentId, lockBusiness);
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
    await lockReceiptDraft(tx, input.documentId, lockBusiness);
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
  reason: true,
  direction: true,
  reversesDocumentId: true,
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
