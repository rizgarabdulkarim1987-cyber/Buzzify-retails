import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { ImportRowStatus } from "@/generated/prisma/enums";
import { normalizeBarcode, normalizeSearchText } from "@/server/domain/catalog";
import type { Currency } from "@/server/domain/money";
import { can } from "@/server/domain/permissions";
import { defineAction, validKey, type ActionMeta, type Result } from "@/server/framework/action";
import { NotFoundError, RuleError, VersionConflictError, failure } from "@/server/framework/errors";
import { applyPrice, ensureDefaultLists } from "../price-core";
import {
  TAXONOMY_LOCK,
  assertMayMarkTrial,
  insertProductsCore,
  nextSkusCore,
  productLock,
  refreshSearchText,
  type NewCatalogItem,
} from "../products";
import { KNOWN_COLUMNS, autoMapHeaders, validateMapping, type KnownColumn, type Mapping } from "./mapping";
import { MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS, parseImportFile } from "./parse";
import {
  serializeRowResult,
  skuKey,
  validateRows,
  type BusinessCurrencies,
  type DiffEntry,
  type ExistingIndex,
  type ExistingItem,
  type ExistingUnit,
  type SerializedRowResult,
} from "./validate";

/*
 * The catalog import, in three steps the UI walks through (all need catalog.import: OWNER, MANAGER):
 *
 * 1. stageImport: the file (base64) is parsed and every data row is stored raw (cells up to the
 *    header width) in RtImportRow with status SKIPPED / reason NOT_VALIDATED (the row status enum
 *    has no "pending" value; NOT_VALIDATED marks a row that no validation has looked at yet). Only
 *    the sha256 of the file is kept, never the bytes.
 * 2. validateImport: a column mapping is applied, the rows are checked against the catalog
 *    (validateRows) and each row gets OK / CHANGED (with the diff) / SKIPPED / REJECTED (with the
 *    reason). Allowed again with another mapping until the first row is committed.
 * 3. commitImport: OK rows become new products; CHANGED rows are applied only where the user chose
 *    UPDATE (onChange: one choice for all, or per row number; a row with no choice is SKIPPED).
 *    The work runs in slices of SLICE_SIZE rows, each slice ONE transaction that also records its
 *    rows as COMMITTED, so a retry after a crash or a timeout continues with the rows not yet
 *    committed and never creates anything twice. Committing a COMMITTED batch again is a no-op.
 *
 * An UPDATE always changes the names, the category and the brand given in the file; a price change
 * needs price.change too: without it everything else is updated and the row keeps reason
 * PRICE_NOT_PERMITTED. A price change closes the current DEFAULT price and opens a new one
 * (applyPrice, append-only). The SKU never changes.
 *
 * Locks, always in this order (the catalog's global order): idempotency (framework), the batch
 * (`catalog.import:<id>`, serializes validate/commit/delete of one batch), "catalog.taxonomy",
 * the product locks of the rows being updated in sorted id order, then the SKU counter row.
 * Barcodes are inserted in code order. A deadlock (40P01), a serialization failure (40001) or a
 * code/SKU that someone committed after our check (unique violation) rolls the slice back and is
 * reported as VERSION_CONFLICT with details.retry = "true"; commitImport retries such a slice a
 * few times, and the retry's checks (made inside the slice, under the locks) then reject only the
 * affected row (BARCODE_TAKEN / SKU_TAKEN).
 *
 * Every step is audited with counts only (never cells or file bytes). Reads (list, get, the
 * rejected-rows file, presets) work in READ_ONLY; every write is refused there.
 *
 * Only batches of kind CATALOG exist for these actions (findBatch, the list, the same-file look-up):
 * an OPENING_STOCK batch (src/server/stock/import.ts) is NOT_FOUND here, so it can never be
 * validated or committed as catalog rows.
 */

type Tx = Prisma.TransactionClient;

export const SLICE_SIZE = 100;
/** Base64 of MAX_IMPORT_FILE_BYTES plus padding; longer text is refused before it is decoded. */
export const MAX_BASE64_LENGTH = Math.ceil(MAX_IMPORT_FILE_BYTES / 3) * 4 + 4;
export const PAGE_SIZE = 50;
export const MAX_PRESETS = 50;
export const STALE_BATCH_DAYS = 7;
const CHUNK = 1000;
const TIMEOUT_MS = 60_000;
const MAX_SLICE_ATTEMPTS = 4;
const DEFAULT_BASE_UNIT = "حبة";
const NOT_VALIDATED = "NOT_VALIDATED";

const batchLock = (batchId: string) => `catalog.import:${batchId}`;
const PRESET_LOCK = "catalog.import.presets";

const id = z.string().min(1).max(64);
const column = z.number().int().min(0).max(199).nullable();
const mappingInput = z
  .partialRecord(z.enum(KNOWN_COLUMNS), column)
  .transform((m): Mapping => Object.fromEntries(KNOWN_COLUMNS.map((c) => [c, m[c] ?? null])) as Mapping);
const choice = z.enum(["UPDATE", "SKIP"]);
const onChange = z.union([
  choice,
  z
    .record(z.string().regex(/^[1-9]\d{0,4}$/), choice)
    .refine((r) => Object.keys(r).length <= MAX_IMPORT_ROWS),
]);

function chunks<T>(list: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * A CATALOG batch of this business (NOT_FOUND otherwise). Every step and list of this file only
 * sees CATALOG batches; the opening-stock import (src/server/stock/import.ts) only its own kind.
 */
async function findBatch(tx: Tx, batchId: string) {
  const batch = await tx.rtImportBatch.findFirst({
    where: { id: batchId, kind: "CATALOG" },
    select: { id: true, status: true, fileName: true, fileHash: true, columns: true, mapping: true, stats: true, isTestData: true, version: true, createdAt: true, createdById: true },
  });
  if (!batch) throw new NotFoundError();
  return batch;
}

async function hasCommittedRows(tx: Tx, batchId: string): Promise<boolean> {
  const row = await tx.rtImportRow.findFirst({ where: { batchId, status: "COMMITTED" }, select: { id: true } });
  return row !== null;
}

// ---------------------------------------------------------------------------------------------
// 1. Stage

export type StagedImport = {
  batchId: string;
  headers: string[];
  suggestedMapping: Mapping;
  rowCount: number;
  /** A COMMITTED batch of this business with the same file contents (the UI can warn). */
  sameFileBatchId: string | null;
};

export const stageImport = defineAction({
  name: "catalog.import.stage",
  permission: "catalog.import",
  writes: true,
  timeoutMs: TIMEOUT_MS,
  input: z
    .object({
      fileName: z.string().trim().min(1).max(255),
      // A hard cap well above the real limit; the real limit gives IMPORT_TOO_LARGE in run.
      contentBase64: z.string().max(MAX_BASE64_LENGTH * 2),
      /** Trial items (an import started from the setup wizard): the products it creates get isTestData. */
      isTestData: z.boolean().default(false),
    })
    .strict(),
  async run({ actor, tx, input }): Promise<StagedImport> {
    assertMayMarkTrial(actor, input.isTestData);
    if (input.contentBase64.length > MAX_BASE64_LENGTH) throw new RuleError("IMPORT_TOO_LARGE");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64)) throw new RuleError("IMPORT_UNREADABLE");
    const bytes = new Uint8Array(Buffer.from(input.contentBase64, "base64"));
    const parsed = parseImportFile(bytes, input.fileName);
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    const width = parsed.headers.length;

    const numeric = new Map<number, number[]>();
    for (const key of parsed.numericCells) {
      const [r, c] = key.split(":").map(Number) as [number, number];
      if (c < width) numeric.set(r, [...(numeric.get(r) ?? []), c]);
    }

    const sameFile = await tx.rtImportBatch.findFirst({
      where: { fileHash, status: "COMMITTED", kind: "CATALOG" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const batch = await tx.rtImportBatch.create({
      data: {
        businessId: actor.businessId,
        fileName: input.fileName,
        fileHash,
        columns: parsed.headers,
        stats: { total: parsed.rows.length },
        isTestData: input.isTestData,
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
    return {
      batchId: batch.id,
      headers: parsed.headers,
      suggestedMapping: autoMapHeaders(parsed.headers),
      rowCount: rows.length,
      sameFileBatchId: sameFile?.id ?? null,
    };
  },
  // The idempotency row keeps no file content (headers are re-read with getImportBatch).
  storedValue: (value) => ({ ...value, headers: [] }),
  audit: (input, value) => ({
    entity: "RtImportBatch",
    entityId: value.batchId,
    changes: { fileName: input.fileName, rows: value.rowCount, columns: value.headers.length, sameFileBatchId: value.sameFileBatchId },
  }),
});

// ---------------------------------------------------------------------------------------------
// 2. Validate

/** Current DEFAULT price per currency of each unit (effective now). Chunked `in` look-ups. */
async function effectivePrices(tx: Tx, unitIds: readonly string[]): Promise<Map<string, Partial<Record<Currency, bigint>>>> {
  const prices = new Map<string, Partial<Record<Currency, bigint>>>();
  const now = new Date();
  for (const part of chunks([...new Set(unitIds)])) {
    const found = await tx.rtPrice.findMany({
      where: { unitId: { in: part }, priceList: { kind: "DEFAULT" }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
      select: { unitId: true, currency: true, amountMinor: true },
    });
    for (const p of found) prices.set(p.unitId, { ...(prices.get(p.unitId) ?? {}), [p.currency]: p.amountMinor });
  }
  return prices;
}

/**
 * What the catalog holds for the barcodes and SKUs of the file, with bounded queries (chunked
 * `in` look-ups, one level per query). A barcode key carries the unit that owns the code; every
 * key carries the variant's active units (a SKU match picks the unit of the row's factor), each
 * with its DEFAULT prices. `archived` covers an archived barcode, unit, variant or product (the
 * code stays reserved).
 */
export async function buildExistingIndex(tx: Tx, barcodes: readonly string[], skus: readonly string[]): Promise<Map<string, ExistingItem>> {
  const codes: { code: string; unitId: string; archived: boolean }[] = [];
  for (const part of chunks([...new Set(barcodes)])) {
    const found = await tx.rtBarcode.findMany({ where: { code: { in: part } }, select: { code: true, unitId: true, archivedAt: true } });
    for (const f of found) codes.push({ code: f.code, unitId: f.unitId, archived: f.archivedAt !== null });
  }
  const skuRows: { id: string; sku: string }[] = [];
  for (const part of chunks([...new Set(skus)])) {
    skuRows.push(...(await tx.rtVariant.findMany({ where: { sku: { in: part } }, select: { id: true, sku: true } })));
  }

  const unitSelect = { id: true, variantId: true, name: true, factor: true, archivedAt: true } as const;
  type UnitRow = { id: string; variantId: string; name: string; factor: number; archivedAt: Date | null };
  const codeUnits = new Map<string, UnitRow>();
  for (const part of chunks([...new Set(codes.map((c) => c.unitId))])) {
    for (const u of await tx.rtUnit.findMany({ where: { id: { in: part } }, select: unitSelect })) codeUnits.set(u.id, u);
  }
  const variantIds = [...new Set([...[...codeUnits.values()].map((u) => u.variantId), ...skuRows.map((v) => v.id)])];
  const activeUnits: UnitRow[] = [];
  for (const part of chunks(variantIds)) {
    activeUnits.push(
      ...(await tx.rtUnit.findMany({
        where: { variantId: { in: part }, archivedAt: null },
        orderBy: [{ isBase: "desc" }, { factor: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: unitSelect,
      })),
    );
  }

  type VariantInfo = Omit<ExistingItem, "variantId" | "unit" | "units">;
  const variants = new Map<string, VariantInfo>();
  for (const part of chunks(variantIds)) {
    const found = await tx.rtVariant.findMany({
      where: { id: { in: part } },
      select: {
        id: true,
        sku: true,
        archivedAt: true,
        product: {
          select: {
            id: true,
            nameAr: true,
            nameCkb: true,
            nameEn: true,
            archivedAt: true,
            category: { select: { nameAr: true } },
            brand: { select: { nameAr: true } },
          },
        },
      },
    });
    for (const v of found) {
      variants.set(v.id, {
        productId: v.product.id,
        archived: v.archivedAt !== null || v.product.archivedAt !== null,
        sku: v.sku,
        nameAr: v.product.nameAr,
        nameCkb: v.product.nameCkb,
        nameEn: v.product.nameEn,
        categoryName: v.product.category?.nameAr ?? null,
        brandName: v.product.brand?.nameAr ?? null,
      });
    }
  }

  const prices = await effectivePrices(tx, [...codeUnits.keys(), ...activeUnits.map((u) => u.id)]);
  const asExisting = (u: UnitRow): ExistingUnit => ({ unitId: u.id, name: u.name, factor: u.factor, prices: prices.get(u.id) ?? {} });
  const unitsOf = new Map<string, ExistingUnit[]>();
  for (const u of activeUnits) unitsOf.set(u.variantId, [...(unitsOf.get(u.variantId) ?? []), asExisting(u)]);

  const index = new Map<string, ExistingItem>();
  const item = (variantId: string, unit: UnitRow | null, extraArchived: boolean): ExistingItem | null => {
    const v = variants.get(variantId);
    if (!v) return null;
    return { ...v, variantId, archived: v.archived || extraArchived, unit: unit ? asExisting(unit) : null, units: unitsOf.get(variantId) ?? [] };
  };
  for (const c of codes) {
    const unit = codeUnits.get(c.unitId);
    const found = unit ? item(unit.variantId, unit, c.archived || unit.archivedAt !== null) : null;
    if (found) index.set(c.code, found);
  }
  for (const v of skuRows) {
    const found = item(v.id, null, false);
    if (found) index.set(skuKey(v.sku), found);
  }
  return index;
}

async function currenciesOf(tx: Tx): Promise<BusinessCurrencies> {
  const biz = await tx.rtBusiness.findFirst({ select: { defaultCurrency: true, enabledCurrencies: true } });
  if (!biz) throw new NotFoundError();
  return { default: biz.defaultCurrency, enabled: biz.enabledCurrencies };
}

export type ImportSummary = { ok: number; changed: number; skipped: number; rejected: number; total: number };
export type RejectedPreview = { rowNumber: number; reason: string; raw: string[] };
export type ValidatedImport = { summary: ImportSummary; firstRejected: RejectedPreview[]; /** Pass to commitImport as expectedVersion. */ version: number };

export const validateImport = defineAction({
  name: "catalog.import.validate",
  permission: "catalog.import",
  writes: true,
  timeoutMs: TIMEOUT_MS,
  input: z.object({ batchId: id, mapping: mappingInput }).strict(),
  async run({ actor, tx, input, lockBusiness }): Promise<ValidatedImport> {
    await lockBusiness(batchLock(input.batchId));
    const batch = await findBatch(tx, input.batchId);
    if (batch.status === "COMMITTED" || (await hasCommittedRows(tx, batch.id))) throw new RuleError("IMPORT_ALREADY_COMMITTED");
    const width = Array.isArray(batch.columns) ? batch.columns.length : 0;
    const mapping = input.mapping;
    if (KNOWN_COLUMNS.some((c) => mapping[c] !== null && mapping[c]! >= width)) throw new RuleError("INVALID_INPUT");
    const check = validateMapping(mapping);
    if (!check.ok) throw new RuleError("INVALID_INPUT", { problems: check.problems.join(",") });

    const stored = await tx.rtImportRow.findMany({
      where: { batchId: batch.id },
      orderBy: { rowNumber: "asc" },
      select: { rowNumber: true, raw: true, numericCols: true },
    });
    const cells = stored.map((r) => (Array.isArray(r.raw) ? r.raw.map((c) => (typeof c === "string" ? c : "")) : []));
    const numericCells = new Set(stored.flatMap((r) => r.numericCols.map((c) => `${r.rowNumber}:${c}`)));

    // Only the identifiers this file names are looked up.
    const cell = (row: string[], col: KnownColumn) => (mapping[col] === null ? "" : (row[mapping[col]!] ?? "").trim());
    const barcodes: string[] = [];
    const skus: string[] = [];
    for (const row of cells) {
      const b = cell(row, "barcode");
      if (b !== "") {
        try {
          barcodes.push(normalizeBarcode(b));
        } catch {
          // validateRows rejects it (BAD_BARCODE)
        }
      }
      const s = cell(row, "sku");
      if (s !== "") skus.push(s);
    }
    const index: ExistingIndex = await buildExistingIndex(tx, barcodes, skus);
    const results = validateRows(cells, mapping, index, await currenciesOf(tx), { numericCells });

    // Rows are rewritten in bulk (delete + multi-row insert): one UPDATE per row would not fit 10,000 rows.
    await tx.rtImportRow.deleteMany({ where: { batchId: batch.id } });
    const data = results.map((r, i) => {
      const s: SerializedRowResult = serializeRowResult(r);
      return {
        businessId: actor.businessId,
        batchId: batch.id,
        rowNumber: r.rowNumber,
        raw: json(cells[i]),
        numericCols: stored[i]!.numericCols,
        status: r.status,
        reason: r.reason ?? null,
        matchedVariantId: r.matchedVariantId ?? null,
        matchedUnitId: r.matchedUnitId ?? null,
        diff: r.diff ? json(r.diff) : undefined,
        normalized: s.normalized ? json(s.normalized) : undefined,
      };
    });
    for (const part of chunks(data)) await tx.rtImportRow.createMany({ data: part });

    const summary: ImportSummary = { ok: 0, changed: 0, skipped: 0, rejected: 0, total: results.length };
    for (const r of results) {
      if (r.status === "OK") summary.ok += 1;
      else if (r.status === "CHANGED") summary.changed += 1;
      else if (r.status === "SKIPPED") summary.skipped += 1;
      else summary.rejected += 1;
    }
    await tx.rtImportBatch.updateMany({
      where: { id: batch.id },
      data: { status: "VALIDATED", mapping: json(mapping), stats: json(summary), version: { increment: 1 } },
    });
    const firstRejected = results
      .filter((r) => r.status === "REJECTED")
      .slice(0, PAGE_SIZE)
      .map((r) => ({ rowNumber: r.rowNumber, reason: r.reason ?? "", raw: cells[r.rowNumber - 1] ?? [] }));
    return { summary, firstRejected, version: batch.version + 1 };
  },
  // The idempotency row keeps no cells of the file: a replay returns the counts and reasons only.
  storedValue: (value) => ({ ...value, firstRejected: value.firstRejected.map((r) => ({ ...r, raw: [] })) }),
  audit: (input, value) => ({ entity: "RtImportBatch", entityId: input.batchId, changes: { mapping: input.mapping, summary: value.summary } }),
});

// ---------------------------------------------------------------------------------------------
// 3. Commit

type StoredNormalized = NonNullable<SerializedRowResult["normalized"]>;

/**
 * After commit. `created` and `updated` are disjoint; the other counters are subsets:
 * priceNotPermitted (price left out, no price.change), priceNotApplied (updated, but the price was
 * not changed because a scheduled price exists), withoutBasePrice (created as a pack unit only,
 * so the base piece has no price).
 */
export type CommitStats = {
  total: number;
  created: number;
  updated: number;
  priceNotPermitted: number;
  priceNotApplied: number;
  withoutBasePrice: number;
  skipped: number;
  rejected: number;
};

export type SliceResult =
  | { done: false; created: number; updated: number; rejected: number }
  | { done: true; stats: CommitStats; alreadyCommitted: boolean };

/** Postgres deadlock / serialization failure, Prisma's write-conflict code, or a unique violation. */
export function isRetryable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown; meta?: unknown; cause?: unknown };
  if (e.code === "P2002" || e.code === "P2034" || e.code === "40P01" || e.code === "40001") return true;
  const text = `${typeof e.message === "string" ? e.message : ""} ${JSON.stringify(e.meta ?? null)}`;
  if (/40P01|40001|deadlock detected|could not serialize/.test(text)) return true;
  return e.cause !== undefined && e.cause !== err && isRetryable(e.cause);
}

/** Active categories and brands by normalized Arabic name (a root category first, then the oldest). */
async function taxonomyByName(tx: Tx) {
  const categories = await tx.rtCategory.findMany({
    where: { archivedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, nameAr: true, parentId: true },
  });
  const brands = await tx.rtBrand.findMany({ where: { archivedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, nameAr: true } });
  const cat = new Map<string, string>();
  for (const c of categories.filter((c) => c.parentId === null)) if (!cat.has(normalizeSearchText(c.nameAr))) cat.set(normalizeSearchText(c.nameAr), c.id);
  for (const c of categories) if (!cat.has(normalizeSearchText(c.nameAr))) cat.set(normalizeSearchText(c.nameAr), c.id);
  const brand = new Map<string, string>();
  for (const b of brands) if (!brand.has(normalizeSearchText(b.nameAr))) brand.set(normalizeSearchText(b.nameAr), b.id);
  return { cat, brand };
}

/**
 * Finds or creates (at the root) the categories and brands named. A name that normalizes to
 * nothing resolves to null (validateRows already rejects it: NO_CONTENT). Call under the taxonomy lock.
 */
async function resolveTaxonomy(tx: Tx, businessId: string, names: { categories: (string | null)[]; brands: (string | null)[] }) {
  const { cat, brand } = await taxonomyByName(tx);
  const missing = (list: (string | null)[], have: Map<string, string>) => {
    const out = new Map<string, string>();
    for (const n of list) {
      const k = n ? normalizeSearchText(n) : "";
      if (k !== "" && !have.has(k) && !out.has(k)) out.set(k, n!.trim());
    }
    return [...out].map(([k, nameAr]) => ({ k, id: randomUUID(), nameAr }));
  };
  const newCats = missing(names.categories, cat);
  if (newCats.length > 0) {
    await tx.rtCategory.createMany({ data: newCats.map((c) => ({ id: c.id, businessId, nameAr: c.nameAr, parentId: null })) });
    for (const c of newCats) cat.set(c.k, c.id);
  }
  const newBrands = missing(names.brands, brand);
  if (newBrands.length > 0) {
    await tx.rtBrand.createMany({ data: newBrands.map((b) => ({ id: b.id, businessId, nameAr: b.nameAr })) });
    for (const b of newBrands) brand.set(b.k, b.id);
  }
  const find = (map: Map<string, string>) => (name: string | null) =>
    name && normalizeSearchText(name) !== "" ? (map.get(normalizeSearchText(name)) ?? null) : null;
  return { categoryId: find(cat), brandId: find(brand) };
}

/**
 * Stores the CHANGED rows' choices once, at the first slice that finds a CHANGED row without one
 * (after that every CHANGED row has UPDATE or SKIP): later slices and resumed calls use what was
 * stored, never a different onChange. A row the per-row map does not name is SKIP.
 */
async function saveResolutions(tx: Tx, batchId: string, choice: z.infer<typeof onChange>): Promise<void> {
  const open = await tx.rtImportRow.findFirst({ where: { batchId, status: "CHANGED", resolution: null }, select: { id: true } });
  if (!open) return;
  if (typeof choice === "string") {
    await tx.rtImportRow.updateMany({ where: { batchId, status: "CHANGED" }, data: { resolution: choice } });
    return;
  }
  await tx.rtImportRow.updateMany({ where: { batchId, status: "CHANGED" }, data: { resolution: "SKIP" } });
  const wanted = Object.entries(choice)
    .filter(([, v]) => v === "UPDATE")
    .map(([k]) => Number(k));
  for (const part of chunks(wanted)) {
    await tx.rtImportRow.updateMany({ where: { batchId, status: "CHANGED", rowNumber: { in: part } }, data: { resolution: "UPDATE" } });
  }
}

const CREATED_REASONS = new Set(["CREATED", "CREATED_WITHOUT_PRICE", "CREATED_WITHOUT_BASE_PRICE"]);

/** Counts from the stored rows (after the last slice). */
async function finalStats(tx: Tx, batchId: string): Promise<CommitStats> {
  const rows = await tx.rtImportRow.findMany({ where: { batchId }, select: { status: true, reason: true } });
  const s: CommitStats = { total: rows.length, created: 0, updated: 0, priceNotPermitted: 0, priceNotApplied: 0, withoutBasePrice: 0, skipped: 0, rejected: 0 };
  for (const r of rows) {
    if (r.status === "COMMITTED") {
      if (CREATED_REASONS.has(r.reason ?? "")) s.created += 1;
      else s.updated += 1;
      if (r.reason === "PRICE_NOT_PERMITTED" || r.reason === "CREATED_WITHOUT_PRICE") s.priceNotPermitted += 1;
      if (r.reason === "PRICE_NOT_APPLIED") s.priceNotApplied += 1;
      if (r.reason === "CREATED_WITHOUT_BASE_PRICE") s.withoutBasePrice += 1;
    } else if (r.status === "REJECTED") s.rejected += 1;
    else s.skipped += 1;
  }
  return s;
}

type Pending = {
  id: string;
  rowNumber: number;
  status: ImportRowStatus;
  normalized: StoredNormalized;
  matchedVariantId: string | null;
  matchedUnitId: string | null;
  diff: DiffEntry[] | null;
};
type Outcome = { status: "COMMITTED" | "REJECTED"; reason: string; variantId?: string };

const priceOf = (n: StoredNormalized) => (n.price ? { currency: n.price.currency, amountMinor: BigInt(n.price.amountMinor) } : null);

const commitInput = z
  .object({
    batchId: id,
    onChange,
    /** The batch version validateImport returned: a re-validation since then gives VERSION_CONFLICT. */
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict();

/**
 * One slice: up to SLICE_SIZE rows that still wait (OK, or CHANGED with resolution UPDATE), in row
 * order. Exported for tests (a crash after one slice); commitImport is the entry point.
 */
export const commitImportSlice = defineAction({
  name: "catalog.import.commit",
  permission: "catalog.import",
  writes: true,
  timeoutMs: TIMEOUT_MS,
  input: commitInput,
  async run({ actor, tx, input, lockBusiness }): Promise<SliceResult> {
    try {
      return await runSlice(actor, tx, input, lockBusiness);
    } catch (err) {
      if (isRetryable(err)) throw new RuleError("VERSION_CONFLICT", { retry: "true" });
      throw err;
    }
  },
  audit: (input, value) => ({
    entity: "RtImportBatch",
    entityId: input.batchId,
    changes: value.done
      ? { done: true, stats: value.stats, alreadyCommitted: value.alreadyCommitted }
      : { done: false, created: value.created, updated: value.updated, rejected: value.rejected },
  }),
});

async function runSlice(
  actor: { businessId: string; role: Parameters<typeof can>[0] },
  tx: Tx,
  input: z.infer<typeof commitInput>,
  lockBusiness: (name: string) => Promise<void>,
): Promise<SliceResult> {
  await lockBusiness(batchLock(input.batchId));
  const batch = await findBatch(tx, input.batchId);
  if (batch.status === "COMMITTED") return { done: true, stats: batch.stats as unknown as CommitStats, alreadyCommitted: true };
  if (batch.status !== "VALIDATED") throw new RuleError("IMPORT_NOT_VALIDATED");
  if (input.expectedVersion !== undefined && input.expectedVersion !== batch.version) throw new VersionConflictError();
  await saveResolutions(tx, batch.id, input.onChange);

  const rows = (await tx.rtImportRow.findMany({
    where: { batchId: batch.id, OR: [{ status: "OK" }, { status: "CHANGED", resolution: "UPDATE" }] },
    orderBy: { rowNumber: "asc" },
    take: SLICE_SIZE,
    select: { id: true, rowNumber: true, status: true, normalized: true, matchedVariantId: true, matchedUnitId: true, diff: true },
  })) as unknown as Pending[];

  if (rows.length === 0) {
    const stats = await finalStats(tx, batch.id);
    await tx.rtImportBatch.updateMany({ where: { id: batch.id }, data: { status: "COMMITTED", stats: json(stats), version: { increment: 1 } } });
    return { done: true, stats, alreadyCommitted: false };
  }

  const outcome = new Map<string, Outcome>();
  const reject = (r: Pending, reason: string) => outcome.set(r.id, { status: "REJECTED", reason });
  const live = (list: Pending[]) => list.filter((r) => !outcome.has(r.id));
  const fresh = rows.filter((r) => r.status === "OK");
  let updates = rows.filter((r) => r.status === "CHANGED");

  // Lock order: (batch) -> taxonomy -> products (sorted) -> SKU counter.
  await lockBusiness(TAXONOMY_LOCK);
  const matched = await tx.rtVariant.findMany({
    where: { id: { in: updates.map((r) => r.matchedVariantId).filter((v): v is string => v !== null) } },
    select: { id: true, productId: true, archivedAt: true },
  });
  const variantInfo = new Map(matched.map((v) => [v.id, v]));
  for (const productId of [...new Set(matched.map((v) => v.productId))].sort()) await lockBusiness(productLock(productId));

  // Stale guard, under the product locks: every "before" of the diff must still hold and the
  // matched unit must still be the active unit of the row's factor; otherwise the row is not written.
  const products = new Map(
    (
      await tx.rtProduct.findMany({
        where: { id: { in: matched.map((v) => v.productId) } },
        select: { id: true, nameAr: true, nameCkb: true, nameEn: true, archivedAt: true, category: { select: { nameAr: true } }, brand: { select: { nameAr: true } } },
      })
    ).map((p) => [p.id, p]),
  );
  const unitIds = updates.map((r) => r.matchedUnitId).filter((u): u is string => u !== null);
  const units = new Map(
    (await tx.rtUnit.findMany({ where: { id: { in: unitIds } }, select: { id: true, variantId: true, factor: true, archivedAt: true } })).map((u) => [u.id, u]),
  );
  const prices = await effectivePrices(tx, unitIds);
  for (const r of updates) {
    const v = r.matchedVariantId ? variantInfo.get(r.matchedVariantId) : undefined;
    const p = v ? products.get(v.productId) : undefined;
    if (!v || !p || v.archivedAt !== null || p.archivedAt !== null) {
      reject(r, "MATCH_ARCHIVED");
      continue;
    }
    const u = r.matchedUnitId ? units.get(r.matchedUnitId) : undefined;
    if (!u || u.archivedAt !== null || u.variantId !== v.id || u.factor !== (r.normalized.factor ?? 1)) {
      reject(r, "STALE_ROW");
      continue;
    }
    const current = (field: string): string | null | undefined => {
      if (field === "name") return p.nameAr;
      if (field === "nameCkb") return p.nameCkb;
      if (field === "nameEn") return p.nameEn;
      if (field === "category") return p.category?.nameAr ?? null;
      if (field === "brand") return p.brand?.nameAr ?? null;
      if (field.startsWith("price.")) return prices.get(u.id)?.[field.slice(6) as Currency]?.toString() ?? null;
      return undefined; // barcode: checked with the other codes below
    };
    if ((r.diff ?? []).some((d) => current(d.field) !== undefined && current(d.field) !== d.before)) reject(r, "STALE_ROW");
  }
  updates = live(updates);

  // Re-checked here, under the locks: what changed since validation decides per row.
  const { enabled } = await currenciesOf(tx);
  for (const r of [...fresh, ...updates]) {
    if (r.normalized.price && !enabled.includes(r.normalized.price.currency)) reject(r, "UNKNOWN_CURRENCY");
  }
  let creates = live(fresh);
  updates = live(updates);
  const manualSkus = creates.map((r) => r.normalized.sku).filter((s): s is string => s !== null);
  if (manualSkus.length > 0) {
    const taken = new Set((await tx.rtVariant.findMany({ where: { sku: { in: manualSkus } }, select: { sku: true } })).map((v) => v.sku));
    for (const r of creates) if (r.normalized.sku && taken.has(r.normalized.sku)) reject(r, "SKU_TAKEN");
  }
  creates = live(creates);
  // Codes this slice inserts: the new products', and the ones a SKU-matched UPDATE adds (diff "barcode").
  const adds = (r: Pending) => (r.diff ?? []).find((d) => d.field === "barcode")?.after ?? null;
  const codes = [...creates.map((r) => r.normalized.barcode), ...updates.map(adds)].filter((c): c is string => c !== null);
  if (codes.length > 0) {
    const taken = new Set((await tx.rtBarcode.findMany({ where: { code: { in: codes } }, select: { code: true } })).map((b) => b.code));
    for (const r of creates) if (r.normalized.barcode && taken.has(r.normalized.barcode)) reject(r, "BARCODE_TAKEN");
    for (const r of updates) {
      const code = adds(r);
      if (code && taken.has(code)) reject(r, "BARCODE_TAKEN");
    }
  }
  creates = live(creates);
  updates = live(updates);

  const changedTo = (r: Pending, field: string) => (r.diff ?? []).find((d) => d.field === field)?.after ?? null;
  const taxonomy = await resolveTaxonomy(tx, actor.businessId, {
    categories: [...creates.map((r) => r.normalized.category), ...updates.map((r) => changedTo(r, "category"))],
    brands: [...creates.map((r) => r.normalized.brand), ...updates.map((r) => changedTo(r, "brand"))],
  });
  const canPrice = can(actor.role, "price.change");

  // New products, and the barcodes added to existing units, in one sorted insert.
  const generated = await nextSkusCore(
    tx,
    actor.businessId,
    creates.filter((r) => r.normalized.sku === null).length,
    new Set(creates.map((r) => r.normalized.sku).filter((s): s is string => s !== null)),
  );
  let g = 0;
  const items: NewCatalogItem[] = creates.map((r) => {
    const n = r.normalized;
    const own = n.barcode ? [n.barcode] : [];
    const pack = n.factor !== null && n.factor > 1;
    return {
      nameAr: n.name,
      nameCkb: n.nameCkb,
      nameEn: n.nameEn,
      categoryId: taxonomy.categoryId(n.category),
      brandId: taxonomy.brandId(n.brand),
      sku: n.sku ?? generated[g++]!,
      baseUnit: { name: pack ? DEFAULT_BASE_UNIT : (n.unit ?? DEFAULT_BASE_UNIT), barcodes: pack ? [] : own },
      // The pack's name must differ from the base unit's (unit names are unique within a variant).
      pack: pack
        ? {
            name: n.unit && normalizeSearchText(n.unit) !== normalizeSearchText(DEFAULT_BASE_UNIT) ? n.unit : `${DEFAULT_BASE_UNIT} × ${n.factor}`,
            factor: n.factor!,
            barcodes: own,
          }
        : null,
      price: canPrice ? priceOf(n) : null,
      isTestData: batch.isTestData,
    };
  });
  const extraBarcodes = updates.flatMap((r) => {
    const code = adds(r);
    return code ? [{ unitId: r.matchedUnitId!, code }] : [];
  });
  const created = await insertProductsCore(tx, actor.businessId, items, extraBarcodes);
  creates.forEach((r, i) => {
    // Flagged only when the pack really got a price and the base piece therefore has none.
    const pack = r.normalized.factor !== null && r.normalized.factor > 1;
    const reason = !r.normalized.price ? "CREATED" : !canPrice ? "CREATED_WITHOUT_PRICE" : pack ? "CREATED_WITHOUT_BASE_PRICE" : "CREATED";
    outcome.set(r.id, { status: "COMMITTED", reason, variantId: created[i]!.variantId });
  });

  // Updates write only the fields of the diff (names, category, brand, barcode, the matched unit's price).
  let lists: { DEFAULT: string } | null = null;
  for (const r of updates) {
    const v = variantInfo.get(r.matchedVariantId!)!;
    const data: Prisma.RtProductUncheckedUpdateManyInput = {};
    for (const d of r.diff ?? []) {
      if (d.field === "name") data.nameAr = d.after;
      else if (d.field === "nameCkb") data.nameCkb = d.after;
      else if (d.field === "nameEn") data.nameEn = d.after;
      else if (d.field === "category") {
        const cid = taxonomy.categoryId(d.after);
        if (cid) data.categoryId = cid; // an empty-looking cell never clears the category
      } else if (d.field === "brand") {
        const bid = taxonomy.brandId(d.after);
        if (bid) data.brandId = bid;
      }
    }
    if (Object.keys(data).length > 0) {
      await tx.rtProduct.updateMany({ where: { id: v.productId, archivedAt: null }, data: { ...data, version: { increment: 1 } } });
    }
    // An UPDATE from a real (non-trial) file adopts a trial product as real: removeTestProducts leaves it.
    if (!batch.isTestData) {
      await tx.rtProduct.updateMany({ where: { id: v.productId, isTestData: true }, data: { isTestData: false, version: { increment: 1 } } });
    }
    await refreshSearchText(tx, v.productId);

    let reason = "UPDATED";
    const price = priceOf(r.normalized);
    if (price && (r.diff ?? []).some((d) => d.field === `price.${price.currency}`)) {
      if (!canPrice) reason = "PRICE_NOT_PERMITTED";
      else {
        lists ??= await ensureDefaultLists(tx, actor.businessId);
        const latest = await tx.rtPrice.findFirst({
          where: { unitId: r.matchedUnitId!, priceListId: lists.DEFAULT, currency: price.currency, validTo: null },
          select: { id: true },
        });
        try {
          await applyPrice(tx, {
            businessId: actor.businessId,
            unitId: r.matchedUnitId!,
            priceListId: lists.DEFAULT,
            currency: price.currency,
            amountMinor: price.amountMinor,
            validFrom: null,
            expectedLatestId: latest?.id ?? null,
          });
        } catch (err) {
          // Only a scheduled price ahead (refused before any statement ran) leaves the row standing
          // without its price. Anything else, a constraint refusal above all (its statement failed
          // and the transaction is aborted), fails the slice.
          if (!(err instanceof RuleError && err.details?.reason === "BEFORE_LATEST")) throw err;
          reason = "PRICE_NOT_APPLIED";
        }
      }
    }
    outcome.set(r.id, { status: "COMMITTED", reason });
  }

  // Row statuses, in the same transaction as the work.
  const byResult = new Map<string, string[]>();
  for (const r of rows) {
    const o = outcome.get(r.id)!;
    if (o.variantId) {
      await tx.rtImportRow.updateMany({ where: { id: r.id }, data: { status: o.status, reason: o.reason, matchedVariantId: o.variantId } });
    } else {
      const k = `${o.status}|${o.reason}`;
      byResult.set(k, [...(byResult.get(k) ?? []), r.id]);
    }
  }
  for (const [k, ids] of byResult) {
    const [status, reason] = k.split("|") as ["COMMITTED" | "REJECTED", string];
    await tx.rtImportRow.updateMany({ where: { id: { in: ids } }, data: { status, reason } });
  }
  const all = [...outcome.values()];
  return {
    done: false,
    created: all.filter((o) => o.variantId).length,
    updated: all.filter((o) => o.status === "COMMITTED" && !o.variantId).length,
    rejected: all.filter((o) => o.status === "REJECTED").length,
  };
}

export type CommitResult = { stats: CommitStats; alreadyCommitted: boolean };

/**
 * Applies a validated batch, slice by slice (see the top comment). Each slice is its own idempotent
 * write, keyed from the caller's key and the slice number, so repeating the call with the same key
 * replays the finished slices and continues; a new key continues from the rows not yet committed.
 * A slice that hit a deadlock or a code taken meanwhile is retried (its checks then reject the row).
 */
export async function commitImport(raw: unknown, meta: ActionMeta): Promise<Result<CommitResult>> {
  if (!commitInput.safeParse(raw).success || !validKey(meta.idempotencyKey)) return failure("INVALID_INPUT");
  const base = createHash("sha256").update(meta.idempotencyKey).digest("hex").slice(0, 40);
  const maxSlices = Math.ceil(MAX_IMPORT_ROWS / SLICE_SIZE) + 2;
  for (let n = 1; n <= maxSlices; n += 1) {
    let r: Result<SliceResult> | undefined;
    for (let attempt = 1; attempt <= MAX_SLICE_ATTEMPTS; attempt += 1) {
      r = await commitImportSlice(raw, { ...meta, idempotencyKey: `import-commit:${base}:${n}` });
      if (r.ok || r.code !== "VERSION_CONFLICT" || r.details?.retry !== "true") break;
    }
    if (!r!.ok) return r as Result<never>;
    const v = r!.value;
    if (v.done) return { ok: true, value: { stats: v.stats, alreadyCommitted: v.alreadyCommitted } };
  }
  return failure("VERSION_CONFLICT", { retry: "true" });
}

// ---------------------------------------------------------------------------------------------
// The rejected rows as a file

/** A cell a spreadsheet could read as a formula gets a leading apostrophe (CSV injection). */
export function neutralizeCell(cell: string): string {
  return /^[\t\r]/.test(cell) || /^\s*[=+\-@＝＋－＠]/.test(cell) ? `'${cell}` : cell;
}

/** One CSV cell, neutralized and quoted when needed (shared with the opening-stock import). */
export function csvCell(cell: string): string {
  const safe = neutralizeCell(cell);
  return /[",\r\n]|^\s|\s$/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** UTF-8 CSV (with BOM) of the REJECTED rows: the file's own columns plus `reason`. */
export const downloadRejected = defineAction({
  name: "catalog.import.rejected",
  permission: "catalog.import",
  writes: false,
  timeoutMs: TIMEOUT_MS,
  input: z.object({ batchId: id }).strict(),
  async run({ tx, input }): Promise<string> {
    const batch = await findBatch(tx, input.batchId);
    const headers = Array.isArray(batch.columns) ? batch.columns.map((c) => (typeof c === "string" ? c : "")) : [];
    const rows = await tx.rtImportRow.findMany({
      where: { batchId: batch.id, status: "REJECTED" },
      orderBy: { rowNumber: "asc" },
      select: { raw: true, reason: true },
    });
    const lines = [[...headers, "reason"].map(csvCell).join(",")];
    for (const r of rows) {
      const raw = Array.isArray(r.raw) ? r.raw.map((c) => (typeof c === "string" ? c : "")) : [];
      const cells = headers.map((_, i) => raw[i] ?? "");
      lines.push([...cells, r.reason ?? ""].map(csvCell).join(","));
    }
    return `﻿${lines.join("\r\n")}\r\n`;
  },
});

// ---------------------------------------------------------------------------------------------
// Batches

const batchSummarySelect = { id: true, fileName: true, status: true, stats: true, isTestData: true, createdAt: true, createdById: true } as const;

/** The business's batches, newest first, PAGE_SIZE per page; counts only, never rows. */
export const listImportBatches = defineAction({
  name: "catalog.import.list",
  permission: "catalog.import",
  writes: false,
  input: z.object({ page: z.number().int().min(0).max(10_000).default(0) }).strict().default({ page: 0 }),
  async run({ tx, input }) {
    const batches = await tx.rtImportBatch.findMany({
      where: { kind: "CATALOG" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: input.page * PAGE_SIZE,
      take: PAGE_SIZE,
      select: batchSummarySelect,
    });
    // Rows already in the catalog per batch, so the UI can show a partly committed batch.
    const counts = await tx.rtImportRow.groupBy({
      by: ["batchId"],
      where: { batchId: { in: batches.map((b) => b.id) }, status: "COMMITTED" },
      _count: { _all: true },
    });
    const committed = new Map(counts.map((c) => [c.batchId, c._count._all]));
    return batches.map((b) => ({ ...b, committedRows: committed.get(b.id) ?? 0 }));
  },
});

/** One batch with a page of its rows (PAGE_SIZE), optionally of one status. */
export const getImportBatch = defineAction({
  name: "catalog.import.get",
  permission: "catalog.import",
  writes: false,
  input: z
    .object({
      batchId: id,
      status: z.enum(["OK", "REJECTED", "SKIPPED", "CHANGED", "COMMITTED"]).optional(),
      page: z.number().int().min(0).max(1_000).default(0),
    })
    .strict(),
  async run({ tx, input }) {
    const batch = await findBatch(tx, input.batchId);
    const where = { batchId: batch.id, ...(input.status ? { status: input.status } : {}) };
    const rows = await tx.rtImportRow.findMany({
      where,
      orderBy: { rowNumber: "asc" },
      skip: input.page * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { rowNumber: true, status: true, reason: true, raw: true, diff: true, resolution: true, matchedVariantId: true, matchedUnitId: true },
    });
    const rowCount = await tx.rtImportRow.count({ where });
    const committedRows = await tx.rtImportRow.count({ where: { batchId: batch.id, status: "COMMITTED" } });
    const { fileHash: _hash, ...rest } = batch;
    void _hash;
    return { ...rest, rows, rowCount, committedRows };
  },
});

/**
 * The row numbers of a batch's CHANGED rows (at most MAX_IMPORT_ROWS numbers, no cells), so a screen
 * that shows one page at a time can send a per-row choice for every changed row.
 */
export const listChangedRows = defineAction({
  name: "catalog.import.changed",
  permission: "catalog.import",
  writes: false,
  input: z.object({ batchId: id }).strict(),
  async run({ tx, input }): Promise<number[]> {
    const batch = await findBatch(tx, input.batchId);
    const rows = await tx.rtImportRow.findMany({
      where: { batchId: batch.id, status: "CHANGED" },
      orderBy: { rowNumber: "asc" },
      take: MAX_IMPORT_ROWS,
      select: { rowNumber: true },
    });
    return rows.map((r) => r.rowNumber);
  },
});

/** Deletes a batch and its rows; refused once any of its rows is in the catalog. */
export const deleteImportBatch = defineAction({
  name: "catalog.import.delete",
  permission: "catalog.import",
  writes: true,
  input: z.object({ batchId: id }).strict(),
  async run({ tx, input, lockBusiness }) {
    await lockBusiness(batchLock(input.batchId));
    const batch = await findBatch(tx, input.batchId);
    if (await hasCommittedRows(tx, batch.id)) throw new RuleError("IMPORT_ALREADY_COMMITTED");
    const rows = await tx.rtImportRow.deleteMany({ where: { batchId: batch.id } });
    await tx.rtImportBatch.deleteMany({ where: { id: batch.id } });
    return { batchId: batch.id, rows: rows.count };
  },
  audit: (input, value) => ({ entity: "RtImportBatch", entityId: input.batchId, changes: { deletedRows: value.rows } }),
});

// ---------------------------------------------------------------------------------------------
// Mapping presets

const presetName = z.string().trim().min(1).max(60).refine((v) => normalizeSearchText(v) !== "");
const presetSelect = { id: true, name: true, mapping: true, createdAt: true } as const;

/** Saves a column map under a name; saving an existing name replaces its map. At most MAX_PRESETS per business. */
export const saveMappingPreset = defineAction({
  name: "catalog.import.preset.save",
  permission: "catalog.import",
  writes: true,
  input: z.object({ name: presetName, mapping: mappingInput }).strict(),
  async run({ actor, tx, input, lockBusiness }) {
    await lockBusiness(PRESET_LOCK);
    const existing = await tx.rtImportMappingPreset.findFirst({ where: { name: input.name }, select: { id: true } });
    if (existing) {
      await tx.rtImportMappingPreset.updateMany({ where: { id: existing.id }, data: { mapping: json(input.mapping) } });
      return tx.rtImportMappingPreset.findFirstOrThrow({ where: { id: existing.id }, select: presetSelect });
    }
    if ((await tx.rtImportMappingPreset.count()) >= MAX_PRESETS) throw new RuleError("INVALID_INPUT", { reason: "TOO_MANY_PRESETS" });
    return tx.rtImportMappingPreset.create({
      data: { businessId: actor.businessId, name: input.name, mapping: json(input.mapping), createdById: actor.userId },
      select: presetSelect,
    });
  },
  audit: (input, value) => ({ entity: "RtImportMappingPreset", entityId: value.id, changes: { name: input.name } }),
});

export const listMappingPresets = defineAction({
  name: "catalog.import.preset.list",
  permission: "catalog.import",
  writes: false,
  input: z.object({}).strict().default({}),
  async run({ tx }) {
    return tx.rtImportMappingPreset.findMany({ orderBy: [{ name: "asc" }], select: presetSelect });
  },
});

export const deleteMappingPreset = defineAction({
  name: "catalog.import.preset.delete",
  permission: "catalog.import",
  writes: true,
  input: z.object({ id }).strict(),
  async run({ tx, input, lockBusiness }) {
    await lockBusiness(PRESET_LOCK);
    const { count } = await tx.rtImportMappingPreset.deleteMany({ where: { id: input.id } });
    if (count === 0) throw new NotFoundError();
    return { id: input.id };
  },
  audit: (input) => ({ entity: "RtImportMappingPreset", entityId: input.id, changes: {} }),
});

// ---------------------------------------------------------------------------------------------
// Cleanup

/**
 * Deletes batches (with their rows) older than STALE_BATCH_DAYS that never reached COMMITTED and
 * have no committed row (a half-committed batch is the record of what was imported, so it stays).
 * Not scheduled yet: a periodic job must call it. Runs across all businesses, so it takes the base
 * client from its caller (feature code never imports it; see tests/enforcement/no-direct-db).
 */
export async function purgeStaleImportBatches(client: PrismaClient, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_BATCH_DAYS * 86_400_000);
  const { count } = await client.rtImportBatch.deleteMany({
    // Either kind of batch; one that has stock documents always has committed rows too (same transaction).
    where: { status: { not: "COMMITTED" }, createdAt: { lt: cutoff }, rows: { none: { status: "COMMITTED" } }, stockDocuments: { none: {} } },
  });
  return count;
}
