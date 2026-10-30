import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { Currency } from "@/generated/prisma/enums";
import { csvCell, buildExistingIndex, isRetryable } from "@/server/catalog/import/actions";
import { ALIASES, headerMatcher } from "@/server/catalog/import/mapping";
import { MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS, parseImportFile } from "@/server/catalog/import/parse";
import { currencyOf, parseBarcodeCell, skuKey, type ExistingItem } from "@/server/catalog/import/validate";
import { MAX_PRICE_MINOR } from "@/server/catalog/price-core";
import { normalizeSearchText, parseMoneyText, toAsciiDigits } from "@/server/domain/catalog";
import { can } from "@/server/domain/permissions";
import { businessToday, convertMinor, expiryStatus, lineValueMinor, parseRate } from "@/server/domain/stock";
import type { Actor } from "@/server/framework/actor";
import { defineAction, validKey, type ActionMeta, type Result } from "@/server/framework/action";
import { ForbiddenError, NotFoundError, RuleError, VersionConflictError, failure } from "@/server/framework/errors";
import { MAX_BATCH_CODE_LENGTH } from "./documents";
import {
  MAX_DOCUMENT_LINES,
  businessOf,
  checkLine,
  defaultPlace,
  documentLock,
  isoDay,
  loadCatalog,
  lockVariants,
  movedOutsideOpening,
  postDocumentInTx,
  type Business,
  type Catalog,
  type LineData,
  type LockBusiness,
  type Tx,
} from "./posting";

/*
 * The opening-stock import (spec 3.12, 3.13, 6ب.6): the catalog import's pipeline (parse, stage,
 * validate, sliced commit) for a file of `barcode|sku, quantity, unit, cost, currency, rate, batch,
 * expiry` rows. Every step needs BOTH stock.receive (the action's permission) and catalog.import (a
 * second check in the precondition, FORBIDDEN without it): OWNER and MANAGER.
 *
 * 1. stageOpeningImport: the file is parsed (same limits as the catalog import: 5 MB, 10,000 rows,
 *    200 columns, formulas never evaluated) and its rows stored raw in an RtImportBatch of kind
 *    OPENING_STOCK. A file whose sha256 matches an OPENING_STOCK batch of this business that posted
 *    at least one row (a committed row; a batch that posted nothing does not count) is refused with
 *    IMPORT_SAME_FILE, also after its documents were reversed: the stock would double.
 * 2. validateOpeningImport: a column map is applied and each row checked with the rules of a draft
 *    line at posting (posting.ts checkLine and postTypedLines): the item by barcode (the barcode's
 *    unit) or by SKU, the unit by name (else the barcode's unit, else the base unit), nothing
 *    archived, not a trial item (TEST_ITEM) nor SERIAL (SERIAL_NOT_SUPPORTED), the quantity fits the
 *    unit's decimals, the currency known and enabled, a rate for a foreign cost, a batch or expiry
 *    only for a BATCH product, an expiry for a tracksExpiry product (a past one is accepted and
 *    flagged EXPIRED), and no movement other than OPENING for the item at the location
 *    (OPENING_AFTER_MOVEMENT). A row without a cost is accepted, valued 0 and flagged COST_MISSING.
 *    A row equal to an earlier valid row in item, unit, batch, expiry and price terms is rejected
 *    DUPLICATE_IN_FILE (the catalog import's rule: the first valid row wins; quantities are not
 *    added, so what posts is exactly the rows the user sees as OK). A valid row for an item that
 *    already has stock at the location gets reason and flag HAS_STOCK and the current on-hand
 *    quantity (base x 1000, no cost), so the preview warns before the stock doubles. The location is
 *    the validating actor's default place (posting.ts defaultPlace), kept on the batch.
 * 3. commitOpeningImport: the OK rows are posted in slices of MAX_DOCUMENT_LINES (500) rows, each
 *    slice ONE OPENING document linked to the batch (importBatchId), created and posted in one
 *    transaction through postDocumentInTx (the shared posting core: no rule is duplicated here),
 *    which also marks the slice's rows COMMITTED. A retry continues with the rows not yet committed;
 *    a COMMITTED batch is a no-op (alreadyCommitted). HAS_STOCK rows are posted only with
 *    includeHasStock: true; otherwise they become SKIPPED / SKIPPED_HAS_STOCK. That choice is stored
 *    by the first slice, so a resumed commit cannot change it. Each slice re-checks its rows under the
 *    locks (the catalog may have changed since validation) and rejects the ones that fail, with the
 *    reason, before posting the rest. Without includeHasStock it also reads the stock at the location
 *    under the variant locks: a row whose item got stock since validation from anything but this
 *    batch (another file, a manual opening) is SKIPPED_HAS_STOCK too, so stock never doubles.
 *
 * Costs: the stored rows keep the parsed cost (the document needs it). Without cost.view every cell
 * of a cost column is blank in what a caller sees (rows, firstRejected, the rejected CSV): the column
 * the headers name as cost, the mapped one, and every column ever mapped as cost (`costColumns` on
 * the batch, never shrinks). Such a caller cannot un-map or move the cost column, nor map another
 * field onto a cost column (STOCK_RULE {reason: COST_COLUMN_LOCKED}). The total value is returned
 * only with cost.view; idempotency records keep no cell of the file and no value (storedValue).
 * On-hand quantities in getOpeningImport are shown only to a caller who can reach the batch's
 * location. Reads (list, get, the rejected-rows CSV) also work in
 * READ_ONLY; every write is refused there.
 *
 * Locks, in this order: idempotency (framework) -> `stock.import:<batchId>` -> `stock.import.file:
 * <sha256>` (two batches of one file commit one after the other, and the second is refused) -> per
 * slice `stock-doc:<id>` -> `stock:<variantId>` ascending (taken here before the re-checks, then
 * again re-entrantly by the posting core) -> `stock-doc-number` last (posting core).
 *
 * Only OPENING_STOCK batches exist here (a CATALOG batch is NOT_FOUND); the catalog import ignores
 * this kind.
 */

export const OPENING_SLICE_SIZE = MAX_DOCUMENT_LINES;
const TIMEOUT_MS = 60_000;
const MAX_SLICE_ATTEMPTS = 4;
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMPORT_FILE_BYTES / 3) * 4 + 4;
const PAGE_SIZE = 50;
const CHUNK = 1000;
const NOT_VALIDATED = "NOT_VALIDATED";
const DAY_MS = 86_400_000;

const batchLock = (batchId: string) => `stock.import:${batchId}`;
const fileLock = (fileHash: string) => `stock.import.file:${fileHash}`;

// ---------------------------------------------------------------------------------------------
// Columns

export const OPENING_COLUMNS = ["barcode", "sku", "quantity", "unit", "cost", "currency", "rate", "batch", "expiry"] as const;
export type OpeningColumn = (typeof OPENING_COLUMNS)[number];
export type OpeningMapping = Record<OpeningColumn, number | null>;

// Arabic, Kurdish (Sorani) and English, normalized like the catalog's (mapping.ts headerKey).
const OPENING_ALIASES: Record<OpeningColumn, readonly string[]> = {
  barcode: ALIASES.barcode,
  sku: ALIASES.sku,
  unit: ALIASES.unit,
  currency: ALIASES.currency,
  quantity: ["quantity", "qty", "stock", "on hand", "opening qty", "opening quantity", "opening stock", "الكمية", "كمية", "العدد", "الرصيد", "الرصيد الافتتاحي", "الكمية الافتتاحية", "بڕ", "بڕی کاڵا", "ژمارە", "کۆگای سەرەتایی"],
  cost: ["cost", "unit cost", "cost price", "purchase price", "buy price", "التكلفة", "تكلفة", "الكلفة", "كلفة", "سعر الشراء", "سعر الكلفة", "تكلفة الوحدة", "تێچوو", "تێچووی یەکە", "نرخی کڕین"],
  rate: ["rate", "exchange rate", "fx rate", "usd rate", "سعر الصرف", "سعر صرف", "سعر الدولار", "نرخی گۆڕینەوە", "نرخی دۆلار"],
  batch: ["batch", "lot", "batch no", "batch number", "batch code", "lot no", "lot number", "الدفعة", "دفعة", "رقم الدفعة", "رمز الدفعة", "الوجبة", "التشغيلة", "رقم التشغيلة", "بەچ", "ژمارەی بەچ"],
  expiry: ["expiry", "expiry date", "expiration", "expiration date", "exp", "exp date", "best before", "تاريخ الانتهاء", "الانتهاء", "تاريخ الصلاحية", "انتهاء الصلاحية", "الصلاحية", "بەسەرچوون", "ڕێکەوتی بەسەرچوون", "بەرواری بەسەرچوون"],
};

/** Maps each opening column to the first header that names it. */
export const autoMapOpeningHeaders: (headers: readonly string[]) => OpeningMapping = headerMatcher(OPENING_COLUMNS, OPENING_ALIASES);

export type OpeningMappingProblem = "MISSING_IDENTIFIER" | "MISSING_QUANTITY" | "DUPLICATE_COLUMN";

/** barcode or sku, and quantity, must be mapped; no file column may feed two targets. */
export function validateOpeningMapping(mapping: OpeningMapping): OpeningMappingProblem[] {
  const problems: OpeningMappingProblem[] = [];
  const mapped = (c: OpeningColumn) => mapping[c] !== null;
  if (!mapped("barcode") && !mapped("sku")) problems.push("MISSING_IDENTIFIER");
  if (!mapped("quantity")) problems.push("MISSING_QUANTITY");
  const used = OPENING_COLUMNS.filter(mapped).map((c) => mapping[c]);
  if (new Set(used).size !== used.length) problems.push("DUPLICATE_COLUMN");
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Inputs and shared pieces

const id = z.string().min(1).max(64);
const column = z.number().int().min(0).max(199).nullable();
const mappingInput = z
  .partialRecord(z.enum(OPENING_COLUMNS), column)
  .transform((m): OpeningMapping => Object.fromEntries(OPENING_COLUMNS.map((c) => [c, m[c] ?? null])) as OpeningMapping);

/**
 * What the batch keeps in its `mapping` column: the column map, the location the rows go to, every
 * column that was ever mapped as cost (only grows: they stay hidden from callers without cost.view
 * whatever a later validation maps), and the HAS_STOCK choice once the first slice stored it.
 */
type StoredMapping = { columns: OpeningMapping; branchId: string; locationId: string; costColumns?: number[]; includeHasStock?: boolean };

export type RowFlag = "HAS_STOCK" | "EXPIRED" | "COST_MISSING";

/** A validated row as stored (`normalized`): the draft line it becomes, with its flags. */
type StoredRow = {
  variantId: string;
  unitId: string;
  quantity: string;
  batchCode: string | null;
  /** YYYY-MM-DD */
  expiryDate: string | null;
  currency: Currency | null;
  unitCostMinor: string | null;
  rateMicro: string | null;
  flags: RowFlag[];
  /** On-hand base quantity x 1000 at validation (HAS_STOCK rows only). */
  onHand: string | null;
};

const json = (v: unknown) => v as Prisma.InputJsonValue;

function chunks<T>(list: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** The second permission of every step (the first, stock.receive, is the action's). */
async function needsCatalogImport({ actor }: { actor: Actor }): Promise<void> {
  if (!can(actor.role, "catalog.import")) throw new ForbiddenError();
}

async function findBatch(tx: Tx, batchId: string) {
  const batch = await tx.rtImportBatch.findFirst({
    where: { id: batchId, kind: "OPENING_STOCK" },
    select: { id: true, status: true, fileName: true, fileHash: true, columns: true, mapping: true, stats: true, version: true, createdAt: true, createdById: true },
  });
  if (!batch) throw new NotFoundError();
  return batch;
}

type Batch = Awaited<ReturnType<typeof findBatch>>;

const storedMapping = (batch: Batch): StoredMapping | null => (batch.mapping as StoredMapping | null) ?? null;
const headersOf = (batch: Batch) => (Array.isArray(batch.columns) ? batch.columns.map((c) => (typeof c === "string" ? c : "")) : []);
const cellsOf = (raw: Prisma.JsonValue) => (Array.isArray(raw) ? raw.map((c) => (typeof c === "string" ? c : "")) : []);

/**
 * The columns that hold (or held) costs: the one the headers name as cost (autoMapOpeningHeaders),
 * the one mapped as cost now, and every one mapped as cost before. Hidden without cost.view.
 */
function costColumnsOf(headers: readonly string[], mapping: StoredMapping | null): Set<number> {
  const out = new Set<number>(mapping?.costColumns ?? []);
  const auto = autoMapOpeningHeaders(headers).cost;
  if (auto !== null) out.add(auto);
  if (mapping && mapping.columns.cost !== null) out.add(mapping.columns.cost);
  return out;
}

/** The file's cells as shown to this caller: every cost column (costColumnsOf) is blank without cost.view. */
function shownCells(cells: string[], hidden: ReadonlySet<number>, seeCost: boolean): string[] {
  if (seeCost || hidden.size === 0) return cells;
  return cells.map((c, i) => (hidden.has(i) ? "" : c));
}

async function hasCommittedRows(tx: Tx, batchIds: string[]): Promise<boolean> {
  if (batchIds.length === 0) return false;
  return (await tx.rtImportRow.findFirst({ where: { batchId: { in: batchIds }, status: "COMMITTED" }, select: { id: true } })) !== null;
}

/**
 * Refuses (IMPORT_SAME_FILE, naming the earlier batch) when another OPENING_STOCK batch of this
 * file posted at least one row (a committed row; a batch that posted nothing does not block).
 * Reversing its documents does not lift this (ruling): its rows stay committed.
 */
async function refuseSameFile(tx: Tx, fileHash: string, exceptBatchId: string | null): Promise<void> {
  const same = await tx.rtImportBatch.findMany({
    where: { kind: "OPENING_STOCK", fileHash, ...(exceptBatchId ? { id: { not: exceptBatchId } } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  for (const b of same) {
    if (await hasCommittedRows(tx, [b.id])) throw new RuleError("IMPORT_SAME_FILE", { batchId: b.id });
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Stage

export type StagedOpeningImport = { batchId: string; headers: string[]; suggestedMapping: OpeningMapping; rowCount: number };

export const stageOpeningImport = defineAction({
  name: "stock.import.stage",
  permission: "stock.receive",
  precondition: needsCatalogImport,
  writes: true,
  timeoutMs: TIMEOUT_MS,
  input: z
    .object({
      fileName: z.string().trim().min(1).max(255),
      // A hard cap well above the real limit; the real limit gives IMPORT_TOO_LARGE in run.
      contentBase64: z.string().max(MAX_BASE64_LENGTH * 2),
    })
    .strict(),
  async run({ actor, tx, input, lockBusiness }): Promise<StagedOpeningImport> {
    if (input.contentBase64.length > MAX_BASE64_LENGTH) throw new RuleError("IMPORT_TOO_LARGE");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64)) throw new RuleError("IMPORT_UNREADABLE");
    const bytes = new Uint8Array(Buffer.from(input.contentBase64, "base64"));
    const parsed = parseImportFile(bytes, input.fileName);
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    await lockBusiness(fileLock(fileHash));
    await refuseSameFile(tx, fileHash, null);
    const width = parsed.headers.length;

    const numeric = new Map<number, number[]>();
    for (const k of parsed.numericCells) {
      const [r, c] = k.split(":").map(Number) as [number, number];
      if (c < width) numeric.set(r, [...(numeric.get(r) ?? []), c]);
    }
    const batch = await tx.rtImportBatch.create({
      data: {
        businessId: actor.businessId,
        kind: "OPENING_STOCK",
        fileName: input.fileName,
        fileHash,
        columns: parsed.headers,
        stats: { total: parsed.rows.length },
        createdById: actor.userId,
      },
      select: { id: true },
    });
    const rows = parsed.rows.map((cells, i) => ({
      businessId: actor.businessId,
      batchId: batch.id,
      rowNumber: i + 1,
      raw: cells.slice(0, width),
      status: "SKIPPED" as const,
      reason: NOT_VALIDATED,
      numericCols: (numeric.get(i + 1) ?? []).sort((a, b) => a - b),
    }));
    for (const part of chunks(rows)) await tx.rtImportRow.createMany({ data: part });
    return { batchId: batch.id, headers: parsed.headers, suggestedMapping: autoMapOpeningHeaders(parsed.headers), rowCount: rows.length };
  },
  // The idempotency row keeps no file content (headers are re-read with getOpeningImport).
  storedValue: (value) => ({ ...value, headers: [] }),
  audit: (input, value) => ({
    entity: "RtImportBatch",
    entityId: value.batchId,
    changes: { kind: "OPENING_STOCK", fileName: input.fileName, rows: value.rowCount, columns: value.headers.length },
  }),
});

// ---------------------------------------------------------------------------------------------
// Row checks

class Reject extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Opening rows accept a past expiry; DD/MM/YYYY, YYYY-MM-DD (also with / or .), or an xlsx date number. */
function parseExpiry(text: string, numericCell: boolean): Date {
  const t = toAsciiDigits(text).trim();
  let y: number, m: number, d: number;
  let match: RegExpExecArray | null;
  if (numericCell && /^\d+(?:\.\d+)?$/.test(t)) {
    // Excel's day number (1900 system): day 1 is 1900-01-01, with its 1900-02-29 bug, so day 0 is 1899-12-30 from day 61 on.
    const serial = Math.floor(Number(t));
    if (serial < 61 || serial > 2_958_465) throw new Reject("BAD_EXPIRY");
    return new Date(Date.UTC(1899, 11, 30) + serial * DAY_MS);
  }
  if ((match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t))) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else throw new Reject("BAD_EXPIRY");
  const date = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || y > 2200 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw new Reject("BAD_EXPIRY");
  return date;
}

/** First pass, from the cells and the catalog index only: the draft line the row stands for. */
function readRow(
  cells: readonly string[],
  rowNumber: number,
  mapping: OpeningMapping,
  index: ReadonlyMap<string, ExistingItem>,
  biz: Business,
  numericCols: ReadonlySet<number>,
): LineData {
  const get = (c: OpeningColumn) => (mapping[c] === null ? "" : (cells[mapping[c]!] ?? "").trim());

  const rawBarcode = get("barcode");
  const sku = get("sku");
  let barcode: string | null = null;
  if (rawBarcode !== "") {
    const read = parseBarcodeCell(rawBarcode, mapping.barcode !== null && numericCols.has(mapping.barcode));
    if ("reason" in read) throw new Reject(read.reason);
    barcode = read.code;
  }
  if (barcode === null && sku === "") throw new Reject("MISSING_IDENTIFIER");

  // The item: by barcode (its unit), else by SKU.
  const byBarcode = barcode !== null ? index.get(barcode) : undefined;
  const bySku = sku !== "" ? index.get(skuKey(sku)) : undefined;
  if (barcode !== null && !byBarcode) throw new Reject("UNKNOWN_ITEM");
  if (byBarcode && sku !== "" && sku !== byBarcode.sku) throw new Reject(bySku ? "CONFLICTING_MATCH" : "SKU_MISMATCH");
  const item = byBarcode ?? bySku;
  if (!item) throw new Reject("UNKNOWN_ITEM");
  if (item.archived) throw new Reject("ARCHIVED");

  // The unit: by name, else the barcode's unit, else the base unit (first of the active units).
  const unitName = get("unit");
  let unitId: string | undefined;
  if (unitName !== "") unitId = item.units.find((u) => normalizeSearchText(u.name) === normalizeSearchText(unitName))?.unitId;
  else unitId = byBarcode?.unit?.unitId ?? item.units[0]?.unitId;
  if (!unitId) throw new Reject("UNKNOWN_UNIT");

  const quantity = get("quantity");
  if (quantity === "") throw new Reject("MISSING_QUANTITY");

  let currency: Currency | null = null;
  let unitCostMinor: bigint | null = null;
  let rateMicro: bigint | null = null;
  const cost = get("cost");
  if (cost !== "") {
    const curText = get("currency");
    currency = curText === "" ? biz.defaultCurrency : currencyOf(curText);
    if (currency === null) throw new Reject("UNKNOWN_CURRENCY");
    try {
      unitCostMinor = parseMoneyText(cost, currency);
    } catch {
      throw new Reject("BAD_COST");
    }
    if (unitCostMinor > MAX_PRICE_MINOR) throw new Reject("BAD_COST");
    const rate = get("rate");
    if (currency !== biz.defaultCurrency && rate !== "") {
      try {
        rateMicro = parseRate(rate);
      } catch {
        throw new Reject("BAD_RATE");
      }
    }
  }

  const batchCode = get("batch");
  if (batchCode.length > MAX_BATCH_CODE_LENGTH) throw new Reject("BAD_BATCH");
  const expiry = get("expiry");
  const expiryDate = expiry === "" ? null : parseExpiry(expiry, mapping.expiry !== null && numericCols.has(mapping.expiry));

  return {
    lineNo: rowNumber,
    variantId: item.variantId,
    unitId,
    enteredQuantity: quantity,
    batchCode: batchCode === "" ? null : batchCode,
    expiryDate,
    currency,
    unitCostMinor,
    rateMicro,
  };
}

/** A posting refusal (posting.ts checkLine) as a row reason. */
function reasonOf(err: unknown): string {
  if (err instanceof RuleError) {
    if (err.code === "STOCK_RULE") return err.details?.reason ?? "STOCK_RULE";
    if (err.code === "INVALID_INPUT") return "BAD_QUANTITY";
    return err.code; // TEST_ITEM, SERIAL_NOT_SUPPORTED
  }
  if (err instanceof NotFoundError) return "UNKNOWN_ITEM";
  throw err;
}

/**
 * Second pass, against the current catalog: the checks the posting core makes for an OPENING line
 * (checkLine, RATE_REQUIRED, EXPIRY_REQUIRED, the value cap, OPENING_AFTER_MOVEMENT), as a reason
 * instead of a refusal of the whole document. Run at validation and again, under the locks, by each
 * commit slice.
 */
function checkRow(l: LineData, catalog: Catalog, biz: Business, today: Date, moved: ReadonlySet<string>): { quantity: bigint; flags: RowFlag[] } {
  let checked: ReturnType<typeof checkLine>;
  try {
    checked = checkLine(l, catalog, biz);
  } catch (err) {
    throw new Reject(reasonOf(err));
  }
  if (l.currency !== null && l.currency !== biz.defaultCurrency && l.rateMicro === null) throw new Reject("RATE_REQUIRED");
  if (checked.variant.product.tracksExpiry && l.expiryDate === null) throw new Reject("EXPIRY_REQUIRED");
  if (moved.has(l.variantId)) throw new Reject("OPENING_AFTER_MOVEMENT");
  if (l.unitCostMinor !== null && l.currency !== null) {
    let value: bigint;
    try {
      value = convertMinor(lineValueMinor(l.unitCostMinor, l.enteredQuantity, checked.unit), l.currency, biz.defaultCurrency, l.currency === biz.defaultCurrency ? null : l.rateMicro);
    } catch {
      throw new Reject("VALUE_TOO_LARGE");
    }
    if (value > MAX_PRICE_MINOR) throw new Reject("VALUE_TOO_LARGE");
  }
  const flags: RowFlag[] = [];
  if (expiryStatus(l.expiryDate, today, 0) === "EXPIRED") flags.push("EXPIRED");
  if (l.unitCostMinor === null) flags.push("COST_MISSING");
  return { quantity: checked.quantity, flags };
}

/** Equal lines (variant, unit, batch, expiry and price terms): the posting core would merge them. */
const duplicateKey = (l: LineData, biz: Business) =>
  JSON.stringify([
    l.variantId,
    l.unitId,
    l.batchCode,
    isoDay(l.expiryDate),
    l.currency,
    l.unitCostMinor?.toString() ?? null,
    l.currency === biz.defaultCurrency ? null : (l.rateMicro?.toString() ?? null),
  ]);

async function catalogOf(tx: Tx, lines: { variantId: string; unitId: string }[]): Promise<Catalog> {
  const out: Catalog = { variants: new Map(), units: new Map() };
  for (const part of chunks(lines)) {
    const c = await loadCatalog(tx, part);
    for (const [k, v] of c.variants) out.variants.set(k, v);
    for (const [k, v] of c.units) out.units.set(k, v);
  }
  return out;
}

async function movedOf(tx: Tx, locationId: string, variantIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunks([...new Set(variantIds)])) for (const v of await movedOutsideOpening(tx, locationId, part)) out.add(v);
  return out;
}

const toStored = (l: LineData, flags: RowFlag[], onHand: bigint | null): StoredRow => ({
  variantId: l.variantId,
  unitId: l.unitId,
  quantity: l.enteredQuantity,
  batchCode: l.batchCode,
  expiryDate: isoDay(l.expiryDate),
  currency: l.currency,
  unitCostMinor: l.unitCostMinor?.toString() ?? null,
  rateMicro: l.rateMicro?.toString() ?? null,
  flags,
  onHand: onHand === null ? null : onHand.toString(),
});

const fromStored = (s: StoredRow, lineNo: number): LineData => ({
  lineNo,
  variantId: s.variantId,
  unitId: s.unitId,
  enteredQuantity: s.quantity,
  batchCode: s.batchCode,
  expiryDate: s.expiryDate ? new Date(`${s.expiryDate}T00:00:00.000Z`) : null,
  currency: s.currency,
  unitCostMinor: s.unitCostMinor === null ? null : BigInt(s.unitCostMinor),
  rateMicro: s.rateMicro === null ? null : BigInt(s.rateMicro),
});

// ---------------------------------------------------------------------------------------------
// 2. Validate

export type OpeningSummary = { total: number; ok: number; hasStock: number; rejected: number; skipped: number; expired: number; costMissing: number };
export type RejectedPreview = { rowNumber: number; reason: string; raw: string[] };
export type HasStockPreview = { rowNumber: number; variantId: string; onHand: bigint };
export type ValidatedOpeningImport = {
  summary: OpeningSummary;
  /** The first PAGE_SIZE rejected rows (cells shown as getOpeningImport shows them). */
  firstRejected: RejectedPreview[];
  /** The first PAGE_SIZE rows of items that already have stock, with the on-hand quantity (base x 1000). */
  hasStock: HasStockPreview[];
  /** Pass to commitOpeningImport as expectedVersion. */
  version: number;
};

type RowResult = { rowNumber: number; status: "OK" | "REJECTED" | "SKIPPED"; reason: string | null; normalized: StoredRow | null; variantId: string | null; unitId: string | null };

export const validateOpeningImport = defineAction({
  name: "stock.import.validate",
  permission: "stock.receive",
  precondition: needsCatalogImport,
  writes: true,
  timeoutMs: TIMEOUT_MS,
  input: z.object({ batchId: id, mapping: mappingInput }).strict(),
  async run({ actor, tx, input, lockBusiness }): Promise<ValidatedOpeningImport> {
    await lockBusiness(batchLock(input.batchId));
    const batch = await findBatch(tx, input.batchId);
    if (batch.status === "COMMITTED" || (await hasCommittedRows(tx, [batch.id]))) throw new RuleError("IMPORT_ALREADY_COMMITTED");
    const width = headersOf(batch).length;
    const mapping = input.mapping;
    if (OPENING_COLUMNS.some((c) => mapping[c] !== null && mapping[c]! >= width)) throw new RuleError("INVALID_INPUT");
    const problems = validateOpeningMapping(mapping);
    if (problems.length > 0) throw new RuleError("INVALID_INPUT", { problems: problems.join(",") });
    const previous = storedMapping(batch);
    const seeCost = can(actor.role, "cost.view");
    const hiddenBefore = costColumnsOf(headersOf(batch), previous);
    if (!seeCost) {
      // Without cost.view the cost column cannot be un-mapped or moved (that would show it in clear),
      // and no other field may read a cost column: STOCK_RULE {reason: COST_COLUMN_LOCKED}.
      const locked = previous?.columns.cost ?? autoMapOpeningHeaders(headersOf(batch)).cost;
      const misuse = OPENING_COLUMNS.some((c) => c !== "cost" && mapping[c] !== null && hiddenBefore.has(mapping[c]!));
      if ((locked !== null && mapping.cost !== locked) || misuse) throw new RuleError("STOCK_RULE", { reason: "COST_COLUMN_LOCKED" });
    }

    const place = await defaultPlace(tx);
    const biz = await businessOf(tx);
    const today = businessToday(new Date(), biz.timezone);
    const stored = await tx.rtImportRow.findMany({ where: { batchId: batch.id }, orderBy: { rowNumber: "asc" }, select: { rowNumber: true, raw: true, numericCols: true } });
    const cells = stored.map((r) => cellsOf(r.raw));

    // Only the identifiers this file names are looked up.
    const barcodes: string[] = [];
    const skus: string[] = [];
    cells.forEach((row, i) => {
      const b = mapping.barcode === null ? "" : (row[mapping.barcode] ?? "").trim();
      if (b !== "") {
        const read = parseBarcodeCell(b, stored[i]!.numericCols.includes(mapping.barcode!));
        if ("code" in read) barcodes.push(read.code);
      }
      const s = mapping.sku === null ? "" : (row[mapping.sku] ?? "").trim();
      if (s !== "") skus.push(s);
    });
    const index = await buildExistingIndex(tx, barcodes, skus);

    // First pass: the cells.
    const results: RowResult[] = [];
    const lines = new Map<number, LineData>();
    stored.forEach((r, i) => {
      const row = cells[i]!;
      const base = { rowNumber: r.rowNumber, normalized: null, variantId: null, unitId: null };
      if (row.every((c) => c.trim() === "")) {
        results.push({ ...base, status: "SKIPPED", reason: "EMPTY_ROW" });
        return;
      }
      try {
        lines.set(r.rowNumber, readRow(row, r.rowNumber, mapping, index, biz, new Set(r.numericCols)));
        results.push({ ...base, status: "OK", reason: null });
      } catch (err) {
        if (!(err instanceof Reject)) throw err;
        results.push({ ...base, status: "REJECTED", reason: err.reason });
      }
    });

    // Second pass: the catalog rules, duplicates, and the stock already there.
    const all = [...lines.values()];
    const catalog = await catalogOf(tx, all);
    const moved = await movedOf(tx, place.locationId, all.map((l) => l.variantId));
    const onHand = new Map<string, bigint>();
    for (const part of chunks([...new Set(all.map((l) => l.variantId))])) {
      const sums = await tx.rtStockBalance.groupBy({ by: ["variantId"], where: { locationId: place.locationId, variantId: { in: part } }, _sum: { qty: true } });
      for (const s of sums) if ((s._sum.qty ?? 0n) > 0n) onHand.set(s.variantId, s._sum.qty!);
    }
    const claimed = new Set<string>();
    for (const r of results) {
      const l = lines.get(r.rowNumber);
      if (r.status !== "OK" || !l) continue;
      try {
        const { flags } = checkRow(l, catalog, biz, today, moved);
        const k = duplicateKey(l, biz);
        if (claimed.has(k)) throw new Reject("DUPLICATE_IN_FILE");
        claimed.add(k);
        const have = onHand.get(l.variantId) ?? null;
        if (have !== null) flags.unshift("HAS_STOCK");
        Object.assign(r, { reason: have !== null ? "HAS_STOCK" : null, normalized: toStored(l, flags, have), variantId: l.variantId, unitId: l.unitId });
      } catch (err) {
        if (!(err instanceof Reject)) throw err;
        Object.assign(r, { status: "REJECTED", reason: err.reason });
      }
    }

    // Rows are rewritten in bulk (delete + multi-row insert): one UPDATE per row would not fit 10,000 rows.
    await tx.rtImportRow.deleteMany({ where: { batchId: batch.id } });
    const data = results.map((r, i) => ({
      businessId: actor.businessId,
      batchId: batch.id,
      rowNumber: r.rowNumber,
      raw: json(cells[i]),
      numericCols: stored[i]!.numericCols,
      status: r.status,
      reason: r.reason,
      matchedVariantId: r.variantId,
      matchedUnitId: r.unitId,
      normalized: r.normalized ? json(r.normalized) : undefined,
    }));
    for (const part of chunks(data)) await tx.rtImportRow.createMany({ data: part });

    const summary: OpeningSummary = { total: results.length, ok: 0, hasStock: 0, rejected: 0, skipped: 0, expired: 0, costMissing: 0 };
    for (const r of results) {
      if (r.status === "OK") summary.ok += 1;
      else if (r.status === "REJECTED") summary.rejected += 1;
      else summary.skipped += 1;
      if (r.normalized?.flags.includes("HAS_STOCK")) summary.hasStock += 1;
      if (r.normalized?.flags.includes("EXPIRED")) summary.expired += 1;
      if (r.normalized?.flags.includes("COST_MISSING")) summary.costMissing += 1;
    }
    const costColumns = [...new Set([...hiddenBefore, ...(mapping.cost !== null ? [mapping.cost] : [])])].sort((a, b) => a - b);
    const saved: StoredMapping = { columns: mapping, branchId: place.branchId, locationId: place.locationId, costColumns };
    await tx.rtImportBatch.updateMany({
      where: { id: batch.id },
      data: { status: "VALIDATED", mapping: json(saved), stats: json(summary), version: { increment: 1 } },
    });
    const hidden = costColumnsOf(headersOf(batch), saved);
    return {
      summary,
      firstRejected: results
        .filter((r) => r.status === "REJECTED")
        .slice(0, PAGE_SIZE)
        .map((r) => ({ rowNumber: r.rowNumber, reason: r.reason ?? "", raw: shownCells(cells[r.rowNumber - 1] ?? [], hidden, seeCost) })),
      hasStock: results
        .filter((r) => r.reason === "HAS_STOCK")
        .slice(0, PAGE_SIZE)
        .map((r) => ({ rowNumber: r.rowNumber, variantId: r.variantId!, onHand: BigInt(r.normalized!.onHand!) })),
      version: batch.version + 1,
    };
  },
  // The idempotency row keeps no cells of the file (and so no cost): a replay returns counts and reasons.
  storedValue: (value) => ({ ...value, firstRejected: value.firstRejected.map((r) => ({ ...r, raw: [] })) }),
  audit: (input, value) => ({ entity: "RtImportBatch", entityId: input.batchId, changes: { mapping: input.mapping, summary: value.summary } }),
});

// ---------------------------------------------------------------------------------------------
// 3. Commit

/** After commit (counts only; `posted` rows are in `documents` documents). */
export type OpeningCommitStats = { total: number; posted: number; skipped: number; skippedHasStock: number; rejected: number; documents: number };
export type ImportDocument = { documentId: string; number: number | null };

export type OpeningSliceResult =
  | { done: false; posted: number; rejected: number; skipped: number; documentId: string | null; number: number | null }
  | {
      done: true;
      stats: OpeningCommitStats;
      alreadyCommitted: boolean;
      documents: ImportDocument[];
      /** Total value of the posted lines (business currency, minor units); only with cost.view, never stored. */
      valueMinor?: bigint;
    };

const commitInput = z
  .object({
    batchId: id,
    /** Post the rows of items that already have stock (HAS_STOCK); default: skip them (SKIPPED_HAS_STOCK). */
    includeHasStock: z.boolean().default(false),
    /** The batch version validateOpeningImport returned: a re-validation since then gives VERSION_CONFLICT. */
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict();

/**
 * One slice: up to OPENING_SLICE_SIZE OK rows, in row order, posted as one OPENING document.
 * Exported for tests (a crash after one slice); commitOpeningImport is the entry point.
 */
export const commitOpeningSlice = defineAction({
  name: "stock.import.commit",
  permission: "stock.receive",
  precondition: needsCatalogImport,
  writes: true,
  timeoutMs: TIMEOUT_MS,
  input: commitInput,
  async run({ actor, tx, input, lockBusiness }): Promise<OpeningSliceResult> {
    try {
      return await runSlice(actor, tx, input, lockBusiness);
    } catch (err) {
      if (isRetryable(err)) throw new RuleError("VERSION_CONFLICT", { retry: "true" });
      throw err;
    }
  },
  storedValue: (value) => {
    if (!value.done) return value;
    const { valueMinor: _value, ...rest } = value;
    void _value;
    return rest;
  },
  audit: (input, value) => ({
    entity: "RtImportBatch",
    entityId: input.batchId,
    changes: value.done
      ? { done: true, stats: value.stats, alreadyCommitted: value.alreadyCommitted }
      : { done: false, posted: value.posted, rejected: value.rejected, skipped: value.skipped, documentId: value.documentId, number: value.number },
  }),
});

/**
 * The HAS_STOCK choice, stored once by the first slice (on the batch, and on the rows flagged at
 * validation: post (UPDATE), or SKIPPED_HAS_STOCK); later slices and resumed calls use the stored one.
 */
async function hasStockChoice(tx: Tx, batchId: string, mapping: StoredMapping, include: boolean): Promise<boolean> {
  if (mapping.includeHasStock !== undefined) return mapping.includeHasStock;
  await tx.rtImportBatch.updateMany({ where: { id: batchId }, data: { mapping: json({ ...mapping, includeHasStock: include }) } });
  await tx.rtImportRow.updateMany({
    where: { batchId, status: "OK", reason: "HAS_STOCK", resolution: null },
    // The column allows the catalog's two choices: UPDATE (post it) or SKIP.
    data: include ? { resolution: "UPDATE" } : { status: "SKIPPED", reason: "SKIPPED_HAS_STOCK", resolution: "SKIP" },
  });
  return include;
}

/**
 * The variants (of `variantIds`) that have stock at the location now that did not come from this
 * batch's own documents: an earlier slice of this import does not count, an OPENING posted by
 * someone else since validation does. Call under the variants' locks.
 */
async function stockedElsewhere(tx: Tx, batchId: string, locationId: string, variantIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(variantIds)];
  const balances = await tx.rtStockBalance.groupBy({ by: ["variantId"], where: { locationId, variantId: { in: ids } }, _sum: { qty: true } });
  const own = (await importDocuments(tx, batchId)).map((d) => d.documentId);
  const mine = new Map<string, bigint>();
  if (own.length > 0) {
    const moves = await tx.rtStockMovement.groupBy({ by: ["variantId"], where: { locationId, documentId: { in: own }, variantId: { in: ids } }, _sum: { qtyDelta: true } });
    for (const m of moves) mine.set(m.variantId, m._sum.qtyDelta ?? 0n);
  }
  return new Set(balances.filter((b) => (b._sum.qty ?? 0n) - (mine.get(b.variantId) ?? 0n) > 0n).map((b) => b.variantId));
}

async function importDocuments(tx: Tx, batchId: string): Promise<ImportDocument[]> {
  const docs = await tx.rtStockDocument.findMany({
    where: { importBatchId: batchId },
    orderBy: [{ number: "asc" }, { id: "asc" }],
    select: { id: true, number: true },
  });
  return docs.map((d) => ({ documentId: d.id, number: d.number }));
}

async function finished(actor: Actor, tx: Tx, batchId: string, stats: OpeningCommitStats, alreadyCommitted: boolean): Promise<OpeningSliceResult> {
  const documents = await importDocuments(tx, batchId);
  if (!can(actor.role, "cost.view")) return { done: true, stats, alreadyCommitted, documents };
  const sum = await tx.rtStockLine.aggregate({ where: { documentId: { in: documents.map((d) => d.documentId) } }, _sum: { valueMinor: true } });
  return { done: true, stats, alreadyCommitted, documents, valueMinor: sum._sum.valueMinor ?? 0n };
}

async function finalStats(tx: Tx, batchId: string): Promise<OpeningCommitStats> {
  const rows = await tx.rtImportRow.groupBy({ by: ["status", "reason"], where: { batchId }, _count: { _all: true } });
  const s: OpeningCommitStats = { total: 0, posted: 0, skipped: 0, skippedHasStock: 0, rejected: 0, documents: 0 };
  for (const r of rows) {
    const n = r._count._all;
    s.total += n;
    if (r.status === "COMMITTED") s.posted += n;
    else if (r.status === "REJECTED") s.rejected += n;
    else s.skipped += n;
    if (r.reason === "SKIPPED_HAS_STOCK") s.skippedHasStock += n;
  }
  s.documents = await tx.rtStockDocument.count({ where: { importBatchId: batchId } });
  return s;
}

type Pending = { id: string; rowNumber: number; normalized: StoredRow };

async function runSlice(actor: Actor, tx: Tx, input: z.infer<typeof commitInput>, lockBusiness: LockBusiness): Promise<OpeningSliceResult> {
  await lockBusiness(batchLock(input.batchId));
  const batch = await findBatch(tx, input.batchId);
  if (batch.status === "COMMITTED") return finished(actor, tx, batch.id, batch.stats as unknown as OpeningCommitStats, true);
  if (batch.status !== "VALIDATED") throw new RuleError("IMPORT_NOT_VALIDATED");
  if (input.expectedVersion !== undefined && input.expectedVersion !== batch.version) throw new VersionConflictError();
  await lockBusiness(fileLock(batch.fileHash));
  await refuseSameFile(tx, batch.fileHash, batch.id);
  const mapping = storedMapping(batch);
  if (!mapping) throw new RuleError("IMPORT_NOT_VALIDATED");
  const includeHasStock = await hasStockChoice(tx, batch.id, mapping, input.includeHasStock);

  const rows = (await tx.rtImportRow.findMany({
    where: { batchId: batch.id, status: "OK" },
    orderBy: { rowNumber: "asc" },
    take: OPENING_SLICE_SIZE,
    select: { id: true, rowNumber: true, normalized: true },
  })) as unknown as Pending[];

  if (rows.length === 0) {
    const stats = await finalStats(tx, batch.id);
    await tx.rtImportBatch.updateMany({ where: { id: batch.id }, data: { status: "COMMITTED", stats: json(stats), version: { increment: 1 } } });
    return finished(actor, tx, batch.id, stats, false);
  }

  // The location the batch was validated for, still in this actor's scope.
  const location = await tx.rtLocation.findFirst({ where: { id: mapping.locationId, branchId: mapping.branchId }, select: { id: true } });
  if (!location) throw new NotFoundError();

  // Locks: the new document's, then the variants' (before the catalog is read), as the posting core.
  const documentId = randomUUID();
  await lockBusiness(documentLock(documentId));
  // A line's number is its row number in the file, so warnings and the document point at the row.
  const lines = rows.map((r) => fromStored(r.normalized, r.rowNumber));
  await lockVariants(lines.map((l) => l.variantId), lockBusiness);
  const biz = await businessOf(tx);
  const today = businessToday(new Date(), biz.timezone);
  const catalog = await catalogOf(tx, lines);
  const moved = await movedOf(tx, mapping.locationId, lines.map((l) => l.variantId));
  // Stock that arrived since validation (another file, a manual opening): without includeHasStock
  // such rows are skipped like the ones flagged at validation, so the stock never doubles.
  const stocked = includeHasStock ? new Set<string>() : await stockedElsewhere(tx, batch.id, mapping.locationId, lines.map((l) => l.variantId));

  // Re-checked under the locks: a row the catalog no longer allows is rejected with its reason.
  const live: { row: Pending; line: LineData; quantity: bigint }[] = [];
  const rejected = new Map<string, string[]>();
  const skipped: string[] = [];
  rows.forEach((row, i) => {
    try {
      const quantity = checkRow(lines[i]!, catalog, biz, today, moved).quantity;
      if (stocked.has(lines[i]!.variantId)) skipped.push(row.id);
      else live.push({ row, line: lines[i]!, quantity });
    } catch (err) {
      if (!(err instanceof Reject)) throw err;
      rejected.set(err.reason, [...(rejected.get(err.reason) ?? []), row.id]);
    }
  });
  for (const [reason, ids] of rejected) await tx.rtImportRow.updateMany({ where: { id: { in: ids } }, data: { status: "REJECTED", reason } });
  if (skipped.length > 0) {
    await tx.rtImportRow.updateMany({ where: { id: { in: skipped } }, data: { status: "SKIPPED", reason: "SKIPPED_HAS_STOCK", resolution: "SKIP" } });
  }
  const rejectedCount = rows.length - live.length - skipped.length;
  if (live.length === 0) return { done: false, posted: 0, rejected: rejectedCount, skipped: skipped.length, documentId: null, number: null };

  await tx.rtStockDocument.create({
    data: {
      id: documentId,
      businessId: actor.businessId,
      branchId: mapping.branchId,
      locationId: mapping.locationId,
      kind: "OPENING",
      importBatchId: batch.id,
      note: batch.fileName.slice(0, 1000),
    },
    select: { id: true },
  });
  await tx.rtStockLine.createMany({
    data: live.map(({ line, quantity }) => ({
      businessId: actor.businessId,
      branchId: mapping.branchId,
      documentId,
      lineNo: line.lineNo,
      variantId: line.variantId,
      unitId: line.unitId,
      batchCode: line.batchCode,
      expiryDate: line.expiryDate,
      quantity,
      enteredQuantity: line.enteredQuantity,
      currency: line.currency,
      unitCostMinor: line.unitCostMinor,
      rateMicro: line.rateMicro,
    })),
  });
  const posted = await postDocumentInTx(tx, actor, documentId, lockBusiness);
  await tx.rtImportRow.updateMany({ where: { id: { in: live.map((l) => l.row.id) } }, data: { status: "COMMITTED", reason: "POSTED" } });
  return { done: false, posted: live.length, rejected: rejectedCount, skipped: skipped.length, documentId, number: posted.number };
}

export type OpeningCommitResult = { stats: OpeningCommitStats; alreadyCommitted: boolean; documents: ImportDocument[]; valueMinor?: bigint };

/**
 * Posts a validated batch slice by slice (see the top comment). Each slice is its own idempotent
 * write, keyed from the caller's key and the slice number, so repeating the call with the same key
 * replays the finished slices and continues; a new key continues from the rows not yet posted. A
 * slice that hit a deadlock is retried.
 */
export async function commitOpeningImport(raw: unknown, meta: ActionMeta): Promise<Result<OpeningCommitResult>> {
  if (!commitInput.safeParse(raw).success || !validKey(meta.idempotencyKey)) return failure("INVALID_INPUT");
  const base = createHash("sha256").update(meta.idempotencyKey).digest("hex").slice(0, 40);
  const maxSlices = Math.ceil(MAX_IMPORT_ROWS / OPENING_SLICE_SIZE) + 2;
  for (let n = 1; n <= maxSlices; n += 1) {
    let r: Result<OpeningSliceResult> | undefined;
    for (let attempt = 1; attempt <= MAX_SLICE_ATTEMPTS; attempt += 1) {
      r = await commitOpeningSlice(raw, { ...meta, idempotencyKey: `opening-commit:${base}:${n}` });
      if (r.ok || r.code !== "VERSION_CONFLICT" || r.details?.retry !== "true") break;
    }
    if (!r!.ok) return r as Result<never>;
    const v = r!.value;
    if (v.done) {
      const { done: _done, ...result } = v;
      void _done;
      return { ok: true, value: result };
    }
  }
  return failure("VERSION_CONFLICT", { retry: "true" });
}

// ---------------------------------------------------------------------------------------------
// Reads

export type OpeningImportRow = {
  rowNumber: number;
  status: string;
  reason: string | null;
  flags: RowFlag[];
  /** HAS_STOCK rows: the on-hand quantity at validation (base x 1000). */
  onHand: bigint | null;
  variantId: string | null;
  /** The file's cells; the cost column is blank without cost.view. */
  raw: string[];
};

/** One batch with a page of its rows (PAGE_SIZE), optionally of one status. */
export const getOpeningImport = defineAction({
  name: "stock.import.get",
  permission: "stock.receive",
  precondition: needsCatalogImport,
  writes: false,
  input: z
    .object({
      batchId: id,
      status: z.enum(["OK", "REJECTED", "SKIPPED", "COMMITTED"]).optional(),
      page: z.number().int().min(0).max(1_000).default(0),
    })
    .strict(),
  async run({ actor, tx, input }) {
    const batch = await findBatch(tx, input.batchId);
    const mapping = storedMapping(batch);
    const seeCost = can(actor.role, "cost.view");
    const hidden = costColumnsOf(headersOf(batch), mapping);
    // On-hand quantities are of the batch's location: shown only when this caller can reach it.
    const seeStock =
      mapping !== null && (await tx.rtLocation.findFirst({ where: { id: mapping.locationId, branchId: mapping.branchId }, select: { id: true } })) !== null;
    const where = { batchId: batch.id, ...(input.status ? { status: input.status } : {}) };
    const found = await tx.rtImportRow.findMany({
      where,
      orderBy: { rowNumber: "asc" },
      skip: input.page * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { rowNumber: true, status: true, reason: true, raw: true, normalized: true, matchedVariantId: true },
    });
    const rows = found.map((r): OpeningImportRow => {
      const n = r.normalized as StoredRow | null;
      return {
        rowNumber: r.rowNumber,
        status: r.status,
        reason: r.reason,
        flags: n?.flags ?? [],
        onHand: seeStock && n?.onHand ? BigInt(n.onHand) : null,
        variantId: r.matchedVariantId,
        raw: shownCells(cellsOf(r.raw), hidden, seeCost),
      };
    });
    return {
      id: batch.id,
      fileName: batch.fileName,
      status: batch.status,
      stats: batch.stats,
      version: batch.version,
      createdAt: batch.createdAt,
      createdById: batch.createdById,
      headers: headersOf(batch),
      mapping: mapping?.columns ?? null,
      rows,
      rowCount: await tx.rtImportRow.count({ where }),
      postedRows: await tx.rtImportRow.count({ where: { batchId: batch.id, status: "COMMITTED" } }),
      documents: await importDocuments(tx, batch.id),
    };
  },
});

/** The business's opening-stock batches, newest first, PAGE_SIZE per page; counts only. */
export const listOpeningImports = defineAction({
  name: "stock.import.list",
  permission: "stock.receive",
  precondition: needsCatalogImport,
  writes: false,
  input: z.object({ page: z.number().int().min(0).max(10_000).default(0) }).strict().default({ page: 0 }),
  async run({ tx, input }) {
    const batches = await tx.rtImportBatch.findMany({
      where: { kind: "OPENING_STOCK" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: input.page * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { id: true, fileName: true, status: true, stats: true, createdAt: true, createdById: true },
    });
    const counts = await tx.rtImportRow.groupBy({
      by: ["batchId"],
      where: { batchId: { in: batches.map((b) => b.id) }, status: "COMMITTED" },
      _count: { _all: true },
    });
    const posted = new Map(counts.map((c) => [c.batchId, c._count._all]));
    return batches.map((b) => ({ ...b, postedRows: posted.get(b.id) ?? 0 }));
  },
});

/** UTF-8 CSV (with BOM) of the REJECTED rows: the file's columns plus `reason`; formula-looking cells neutralized. */
export const downloadOpeningRejected = defineAction({
  name: "stock.import.rejected",
  permission: "stock.receive",
  precondition: needsCatalogImport,
  writes: false,
  timeoutMs: TIMEOUT_MS,
  input: z.object({ batchId: id }).strict(),
  async run({ actor, tx, input }): Promise<string> {
    const batch = await findBatch(tx, input.batchId);
    const hidden = costColumnsOf(headersOf(batch), storedMapping(batch));
    const seeCost = can(actor.role, "cost.view");
    const headers = headersOf(batch);
    const rows = await tx.rtImportRow.findMany({
      where: { batchId: batch.id, status: "REJECTED" },
      orderBy: { rowNumber: "asc" },
      select: { raw: true, reason: true },
    });
    const lines = [[...headers, "reason"].map(csvCell).join(",")];
    for (const r of rows) {
      const raw = shownCells(cellsOf(r.raw), hidden, seeCost);
      lines.push([...headers.map((_, i) => raw[i] ?? ""), r.reason ?? ""].map(csvCell).join(","));
    }
    return `﻿${lines.join("\r\n")}\r\n`;
  },
});
