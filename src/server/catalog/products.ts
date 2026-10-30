import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { Currency, RtTrackingMode } from "@/generated/prisma/enums";
import { SKU_PATTERN, assertUnitFactor, barcodeVariants, canonicalBarcode, normalizeSearchText } from "@/server/domain/catalog";
import { can } from "@/server/domain/permissions";
import type { Actor } from "@/server/framework/actor";
import { defineAction, validKey, type ActionMeta } from "@/server/framework/action";
import { ForbiddenError, NotFoundError, RuleError, failure, type Result } from "@/server/framework/errors";
import { updateVersioned } from "@/server/framework/versioned";
import { applyPrice, assertCurrencyEnabled, derivedUnitPrice, ensureDefaultLists, money } from "./price-core";

/*
 * Products (the model: names, descriptions, category, brand, tracking), their variants (the
 * sellable item with a SKU and optional size/colour options), the units of a variant (one base
 * unit with factor 1, plus larger units with a whole factor) and the barcodes of a unit.
 *
 * Every write needs catalog.manage and goes through defineAction (idempotent by key, audited,
 * version-checked on edits, refused while READ_ONLY/CLOSED). getProduct is open to any member.
 * Giving a price (createProduct, addVariant, addUnit) additionally needs price.change; without it
 * the whole call is refused (FORBIDDEN) and nothing is created. A larger unit's price is stored,
 * not computed (spec 7.9): with a base price it gets the explicit amount or factor x base; addUnit
 * without an explicit price derives one per currency from the base unit's current DEFAULT price,
 * but only for a price.change holder (a stock officer's new unit has no price). Every amount is
 * capped at MAX_PRICE_MINOR (INVALID_INPUT above it).
 *
 * Rules kept here (the database repeats the ones it can as constraints):
 * - A variant and its base unit are created in one transaction; the base unit is never archived
 *   and its factor stays 1 (the DB allows at most one base unit per variant).
 * - tracksExpiry needs trackingMode BATCH (also a CHECK); expiryAlertDays only with tracksExpiry.
 *   trackingMode is one enum, so SERIAL and BATCH can never be combined.
 * - soldByWeight needs every active variant's base unit to allow decimals (quantityScale >= 1).
 * - A barcode is unique in the business across every unit, archived ones included. We look first
 *   (so the refusal can name the product that owns it); the unique index decides races, and its
 *   violation is turned into BARCODE_TAKEN as well.
 * - Barcodes are stored in their canonical GTIN form (canonicalBarcode: a valid 12-digit UPC-A as
 *   "0" + code, everything else as normalizeBarcode leaves it); the look-first check searches every
 *   equal form (barcodeVariants), so a 12-digit row stored before this rule still blocks its
 *   13-digit twin. No data migration.
 * - SKU: given by the user or generated from the per-business counter (RtCatalogCounter, atomic
 *   increment, so never reused; a generated value that a manual SKU already took is skipped).
 *   It never changes afterwards (no action edits it).
 * - searchText (product and variant) is rebuilt in the same transaction after every change that
 *   affects it: all names, the SKUs, the variant options and the active barcodes, normalized.
 *
 * Concurrency: the checks above read several rows (the product's soldByWeight and its base units,
 * a variant's unit names, the names and barcodes refreshSearchText copies) and then write, and
 * READ COMMITTED alone would let two writers each pass on the old state, or let a slower
 * refreshSearchText overwrite a fresher one. So EVERY action that changes a product or any row
 * under it (variant, unit, barcode) takes lockBusiness(productLock(productId)) before it reads the
 * rows it depends on. Actions addressed by a child id first look up the productId (a cheap read
 * that decides nothing), take the lock, then re-read everything. createProduct needs no product
 * lock: nobody else can reach the new product before it commits.
 *
 * Lock order (to never deadlock): idempotency lock (framework), then "catalog.taxonomy" (only when
 * a category/brand is assigned, because archiveCategory counts active products under it), then
 * the product lock, then `stock:<variantId>` (ascending; only when a change must read the stock
 * history: unit factor, decimals, tracking flags; posting takes the same locks, after its document
 * lock and without any product lock), then the SKU counter row.
 */

type Tx = Prisma.TransactionClient;

export const MAX_PRODUCT_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_UNIT_NAME_LENGTH = 40;
export const MAX_SKU_LENGTH = 64;
export const SKU_PREFIX = "P";
const SKU_DIGITS = 6;

export const TAXONOMY_LOCK = "catalog.taxonomy";
export const productLock = (productId: string) => `catalog.product:${productId}`;

// ---------------------------------------------------------------------------------------------
// Input schemas

const id = z.string().min(1).max(64);
const version = z.number().int().min(1);
const hasContent = (v: string) => normalizeSearchText(v) !== "";
const nameAr = z.string().trim().min(1).max(MAX_PRODUCT_NAME_LENGTH).refine(hasContent);
const optionalName = z.string().trim().max(MAX_PRODUCT_NAME_LENGTH).refine((v) => v === "" || hasContent(v));
const optionalText = z.string().trim().max(MAX_DESCRIPTION_LENGTH);
/** Create: missing or empty -> null. */
const orNull = <T extends z.ZodType<string>>(s: T) =>
  s.nullish().transform((v) => (v ? v : null));
/** Update: missing -> undefined (unchanged), empty or null -> null (cleared). */
const patch = <T extends z.ZodType<string>>(s: T) =>
  s.nullish().transform((v) => (v === undefined ? undefined : v ? v : null));

const barcode = z.string().transform((v, ctx) => {
  try {
    return canonicalBarcode(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "invalid barcode" });
    return z.NEVER;
  }
});
const barcodes = z.array(barcode).max(20).default([]);

const price = z.object({ currency: z.enum(Currency), amountMinor: money }).strict();

const sku = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SKU_LENGTH)
  .regex(SKU_PATTERN);
const options = z
  .record(z.string().trim().min(1).max(40), z.string().trim().min(1).max(60))
  .refine((o) => Object.keys(o).length >= 1 && Object.keys(o).length <= 10);

const unitName = z.string().trim().min(1).max(MAX_UNIT_NAME_LENGTH).refine(hasContent);
const quantityScale = z.number().int().min(0).max(3);
const baseUnit = z.object({ name: unitName, quantityScale: quantityScale.default(0), barcodes }).strict();
const extraUnit = z
  .object({ name: unitName, factor: z.number(), quantityScale: quantityScale.default(0), barcodes, amountMinor: money.optional() })
  .strict();

type BaseUnitInput = z.infer<typeof baseUnit>;
type ExtraUnitInput = z.infer<typeof extraUnit>;
type PriceInput = z.infer<typeof price>;

/** No barcode twice in one request. */
function uniqueCodes(v: { baseUnit: BaseUnitInput; extraUnits: ExtraUnitInput[] }): boolean {
  const all = [...v.baseUnit.barcodes, ...v.extraUnits.flatMap((u) => u.barcodes)];
  return new Set(all).size === all.length;
}

const trackingFields = {
  trackingMode: z.enum(RtTrackingMode),
  soldByWeight: z.boolean(),
  tracksExpiry: z.boolean(),
  expiryAlertDays: z.number().int().min(1).max(3650),
};

const variantParts = {
  baseUnit,
  extraUnits: z.array(extraUnit).max(10).default([]),
  price: price.optional(),
};

const createInput = z
  .object({
    nameAr,
    nameCkb: orNull(optionalName),
    nameEn: orNull(optionalName),
    descriptionAr: orNull(optionalText),
    descriptionCkb: orNull(optionalText),
    descriptionEn: orNull(optionalText),
    categoryId: id.nullish().transform((v) => v ?? null),
    brandId: id.nullish().transform((v) => v ?? null),
    trackingMode: trackingFields.trackingMode.default("NONE"),
    soldByWeight: trackingFields.soldByWeight.default(false),
    tracksExpiry: trackingFields.tracksExpiry.default(false),
    expiryAlertDays: trackingFields.expiryAlertDays.nullish().transform((v) => v ?? null),
    sku: sku.optional(),
    options: options.nullish().transform((v) => v ?? null),
    /** A trial item (setup wizard; staff.manage only): removeTestProducts deletes it before launch; it never completes setup step 4. */
    isTestData: z.boolean().default(false),
    ...variantParts,
  })
  .strict()
  .refine(uniqueCodes);

const updateInput = z
  .object({
    id,
    expectedVersion: version,
    nameAr: nameAr.optional(),
    nameCkb: patch(optionalName),
    nameEn: patch(optionalName),
    descriptionAr: patch(optionalText),
    descriptionCkb: patch(optionalText),
    descriptionEn: patch(optionalText),
    categoryId: id.nullable().optional(),
    brandId: id.nullable().optional(),
    trackingMode: trackingFields.trackingMode.optional(),
    soldByWeight: trackingFields.soldByWeight.optional(),
    tracksExpiry: trackingFields.tracksExpiry.optional(),
    expiryAlertDays: trackingFields.expiryAlertDays.nullable().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Helpers

/**
 * True once any variant in `variantIds` has had a POSTED stock movement (R-D: drafts do not lock).
 * Reads RtVariant.stockStartedAt, set by the ledger on a variant's first movement: business-level, so a
 * branch-limited editor, whose scoped client cannot see other branches' movements, is locked too (R-Q).
 */
async function variantsHaveHistory(tx: Tx, variantIds: string[]): Promise<boolean> {
  if (variantIds.length === 0) return false;
  const started = await tx.rtVariant.findFirst({ where: { id: { in: variantIds }, stockStartedAt: { not: null } }, select: { id: true } });
  return started !== null;
}

/** Waits for any posting in flight on these variants (posting holds `stock:<variantId>`), in ascending order. */
async function lockStockOf(lock: (name: string) => Promise<void>, variantIds: string[]): Promise<void> {
  for (const v of [...new Set(variantIds)].sort()) await lock(`stock:${v}`);
}

/**
 * True once the unit's variant has a posted stock movement: from then on its factor (and the unit
 * layout) is history. Callers that need it exact against a concurrent posting take lockStockOf first.
 */
export async function unitIsLocked(tx: Tx, unitId: string): Promise<boolean> {
  const unit = await tx.rtUnit.findFirst({ where: { id: unitId }, select: { variantId: true } });
  if (!unit) return false;
  return variantsHaveHistory(tx, [unit.variantId]);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

type Tracking = { trackingMode: RtTrackingMode; tracksExpiry: boolean; expiryAlertDays: number | null };

function checkTracking(t: Tracking): void {
  if (t.tracksExpiry && t.trackingMode !== "BATCH") throw new RuleError("TRACKING_RULE");
  if (t.expiryAlertDays !== null && !t.tracksExpiry) throw new RuleError("TRACKING_RULE");
}

function checkFactor(factor: number): void {
  try {
    assertUnitFactor(factor);
  } catch {
    throw new RuleError("UNIT_RULE");
  }
}

/** Unit names are unique within a variant (normalized). */
function checkUnitNames(names: string[]): void {
  const keys = names.map(normalizeSearchText);
  if (new Set(keys).size !== keys.length) throw new RuleError("UNIT_RULE");
}

function needsPricePermission(actor: Actor, wantsPrice: boolean): void {
  if (wantsPrice && !can(actor.role, "price.change")) throw new ForbiddenError("price.change");
}

/** An active category/brand of this business, or NOT_FOUND. Call under the taxonomy lock. */
async function checkTaxonomy(tx: Tx, categoryId: string | null | undefined, brandId: string | null | undefined): Promise<void> {
  if (categoryId) {
    const c = await tx.rtCategory.findFirst({ where: { id: categoryId, archivedAt: null }, select: { id: true } });
    if (!c) throw new NotFoundError();
  }
  if (brandId) {
    const b = await tx.rtBrand.findFirst({ where: { id: brandId, archivedAt: null }, select: { id: true } });
    if (!b) throw new NotFoundError();
  }
}

/** Refuses when any code exists in the business (archived included), naming the owning product. */
async function assertBarcodesFree(tx: Tx, codes: string[]): Promise<void> {
  if (codes.length === 0) return;
  const taken = await tx.rtBarcode.findFirst({
    // Every stored form of each code (a 12-digit row from before canonicalization blocks "0" + code).
    where: { code: { in: [...new Set(codes.flatMap(barcodeVariants))] } },
    select: {
      code: true,
      unit: { select: { variant: { select: { product: { select: { id: true, nameAr: true, nameCkb: true, nameEn: true } } } } } },
    },
  });
  if (taken) {
    const product = taken.unit.variant.product;
    throw new RuleError("BARCODE_TAKEN", {
      barcode: taken.code,
      productId: product.id,
      productName: product.nameAr,
      productNameCkb: product.nameCkb,
      productNameEn: product.nameEn,
    });
  }
}

async function insertBarcode(tx: Tx, businessId: string, unitId: string, code: string) {
  try {
    return await tx.rtBarcode.create({
      data: { businessId, unitId, code },
      select: { id: true, unitId: true, code: true, archivedAt: true, version: true },
    });
  } catch (err) {
    // A concurrent caller committed the same code after our check; the transaction is aborted
    // now, so the owner cannot be looked up and the details carry the code only.
    if (isUniqueViolation(err)) throw new RuleError("BARCODE_TAKEN", { barcode: code });
    throw err;
  }
}

const formatSku = (n: number) => `${SKU_PREFIX}${String(n).padStart(SKU_DIGITS, "0")}`;

/**
 * The next `count` free generated SKUs. The counter row is incremented atomically (its row lock
 * queues concurrent creators until commit), so a number is handed out once; numbers whose SKU a
 * manual entry already took (in the database, or in `reserved`: manual SKUs about to be inserted
 * by the same caller) are skipped and more are drawn.
 */
export async function nextSkusCore(tx: Tx, businessId: string, count: number, reserved: ReadonlySet<string> = new Set()): Promise<string[]> {
  const out: string[] = [];
  if (count <= 0) return out;
  await tx.rtCatalogCounter.createMany({ data: [{ businessId }], skipDuplicates: true });
  for (let attempt = 0; attempt < 1000 && out.length < count; attempt += 1) {
    const want = count - out.length;
    const row = await tx.rtCatalogCounter.update({
      where: { businessId },
      data: { nextSku: { increment: want } },
      select: { nextSku: true },
    });
    const candidates = Array.from({ length: want }, (_, i) => formatSku(row.nextSku - want + i));
    const used = await tx.rtVariant.findMany({ where: { sku: { in: candidates } }, select: { sku: true } });
    const taken = new Set(used.map((u) => u.sku));
    for (const c of candidates) if (!taken.has(c) && !reserved.has(c)) out.push(c);
  }
  if (out.length < count) throw new Error("nextSkusCore: no free SKU after 1000 attempts");
  return out;
}

async function nextSku(tx: Tx, businessId: string): Promise<string> {
  const [sku] = await nextSkusCore(tx, businessId, 1);
  return sku!;
}

async function assertSkuFree(tx: Tx, value: string): Promise<void> {
  const used = await tx.rtVariant.findFirst({ where: { sku: value }, select: { id: true } });
  if (used) throw new RuleError("SKU_TAKEN");
}

/** The product's searchText: its names and the SKUs of its active variants, normalized. */
export function productSearchText(names: readonly string[], activeSkus: readonly string[]): string {
  return normalizeSearchText([...names, ...activeSkus].join(" "));
}

/** A variant's searchText: the product names, its SKU, its option values and its active barcodes, normalized. */
export function variantSearchText(names: readonly string[], sku: string, options: unknown, activeCodes: readonly string[]): string {
  const optionValues = options && typeof options === "object" && !Array.isArray(options) ? Object.values(options).map(String) : [];
  return normalizeSearchText([...names, sku, ...optionValues, ...activeCodes].join(" "));
}

/**
 * Rebuilds the normalized searchText of the product (names + active variants' SKUs) and of every
 * one of its variants (names + SKU + options + active barcodes). Call under the product lock.
 */
export async function refreshSearchText(tx: Tx, productId: string): Promise<void> {
  // One level per query (see getProduct): no nested to-many selects inside a transaction.
  const product = await tx.rtProduct.findFirst({ where: { id: productId }, select: { nameAr: true, nameCkb: true, nameEn: true } });
  if (!product) throw new NotFoundError();
  const variants = await tx.rtVariant.findMany({
    where: { productId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, sku: true, options: true, archivedAt: true },
  });
  const codes = await tx.rtBarcode.findMany({
    where: { archivedAt: null, unit: { archivedAt: null, variant: { productId } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { code: true, unit: { select: { variantId: true } } },
  });
  const names = [product.nameAr, product.nameCkb, product.nameEn].filter((n): n is string => !!n);
  await tx.rtProduct.updateMany({
    where: { id: productId },
    data: { searchText: productSearchText(names, variants.filter((v) => v.archivedAt === null).map((v) => v.sku)) },
  });
  for (const v of variants) {
    const own = codes.filter((c) => c.unit.variantId === v.id).map((c) => c.code);
    await tx.rtVariant.updateMany({ where: { id: v.id }, data: { searchText: variantSearchText(names, v.sku, v.options, own) } });
  }
}

const unitSelect = { id: true, variantId: true, name: true, factor: true, isBase: true, quantityScale: true, archivedAt: true, version: true } as const;

/**
 * Checks that need no database: unit names, factors, sold-by-weight, unit prices need a base
 * price, and every derived price (factor x base) stays under MAX_PRICE_MINOR.
 */
function checkVariantParts(parts: { baseUnit: BaseUnitInput; extraUnits: ExtraUnitInput[]; price?: PriceInput }, soldByWeight: boolean): void {
  for (const u of parts.extraUnits) checkFactor(u.factor);
  checkUnitNames([parts.baseUnit.name, ...parts.extraUnits.map((u) => u.name)]);
  if (soldByWeight && parts.baseUnit.quantityScale < 1) throw new RuleError("UNIT_RULE");
  if (!parts.price && parts.extraUnits.some((u) => u.amountMinor !== undefined)) throw new RuleError("INVALID_INPUT");
  const base = parts.price?.amountMinor;
  if (base !== undefined) for (const u of parts.extraUnits) if (u.amountMinor === undefined) derivedUnitPrice(base, u.factor);
}

const wantsPrice = (parts: { extraUnits: ExtraUnitInput[]; price?: PriceInput }) =>
  parts.price !== undefined || parts.extraUnits.some((u) => u.amountMinor !== undefined);

/**
 * Inserts one variant with its base unit, extra units, barcodes and optional prices. The caller
 * has checked the parts (checkVariantParts), the price permission and the currency, and holds the
 * locks. Barcodes are checked AFTER the SKU is taken: a creator queued behind the counter row
 * then sees the codes the previous one committed and gets a refusal that names the product.
 */
async function insertVariant(
  tx: Tx,
  businessId: string,
  productId: string,
  v: { sku?: string; options: Record<string, string> | null; baseUnit: BaseUnitInput; extraUnits: ExtraUnitInput[]; price?: PriceInput },
): Promise<{ variantId: string; baseUnitId: string; sku: string }> {
  let skuValue: string;
  if (v.sku !== undefined) {
    await assertSkuFree(tx, v.sku);
    skuValue = v.sku;
  } else {
    skuValue = await nextSku(tx, businessId);
  }
  await assertBarcodesFree(tx, [...v.baseUnit.barcodes, ...v.extraUnits.flatMap((u) => u.barcodes)]);

  let variantId: string;
  try {
    const row = await tx.rtVariant.create({
      data: { businessId, productId, sku: skuValue, options: v.options ?? undefined },
      select: { id: true },
    });
    variantId = row.id;
  } catch (err) {
    // Someone committed this SKU after our check. With a manual SKU that is plainly SKU_TAKEN.
    // With a generated one it means a concurrent MANUAL entry chose exactly the candidate the
    // counter just handed us (the counter itself never repeats); the caller gave no SKU, so the
    // message reads oddly, but retrying the same request draws the next number and succeeds.
    if (isUniqueViolation(err)) throw new RuleError("SKU_TAKEN");
    throw err;
  }

  const base = await tx.rtUnit.create({
    data: { businessId, variantId, name: v.baseUnit.name, factor: 1, isBase: true, quantityScale: v.baseUnit.quantityScale },
    select: { id: true },
  });
  const codes = v.baseUnit.barcodes.map((code) => ({ unitId: base.id, code }));

  const extras: { id: string; unit: ExtraUnitInput }[] = [];
  for (const u of v.extraUnits) {
    const row = await tx.rtUnit.create({
      data: { businessId, variantId, name: u.name, factor: u.factor, isBase: false, quantityScale: u.quantityScale },
      select: { id: true },
    });
    codes.push(...u.barcodes.map((code) => ({ unitId: row.id, code })));
    extras.push({ id: row.id, unit: u });
  }
  // In code order, as insertProductsCore does: two creators then take the unique-index locks in one order.
  codes.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  for (const c of codes) await insertBarcode(tx, businessId, c.unitId, c.code);

  if (v.price) {
    const lists = await ensureDefaultLists(tx, businessId);
    const validFrom = new Date();
    const at = { businessId, priceListId: lists.DEFAULT, currency: v.price.currency, validFrom };
    await applyPrice(tx, { ...at, unitId: base.id, amountMinor: v.price.amountMinor });
    // A larger unit's price is stored, not computed (spec 7.9): the explicit amount, or factor x base.
    for (const e of extras) {
      const amountMinor = e.unit.amountMinor ?? derivedUnitPrice(v.price.amountMinor, e.unit.factor);
      await applyPrice(tx, { ...at, unitId: e.id, amountMinor });
    }
  }
  return { variantId, baseUnitId: base.id, sku: skuValue };
}

/** One new product for insertProductsCore: a single variant, its base unit and optionally one larger unit. */
export type NewCatalogItem = {
  nameAr: string;
  nameCkb: string | null;
  nameEn: string | null;
  categoryId: string | null;
  brandId: string | null;
  /** Already resolved: a free manual SKU or one from nextSkusCore. */
  sku: string;
  baseUnit: { name: string; barcodes: string[] };
  /** A larger unit (factor >= 2) carrying its own barcodes. */
  pack: { name: string; factor: number; barcodes: string[] } | null;
  /** DEFAULT-list price from now on, of the pack when there is one, else of the base unit. */
  price: PriceInput | null;
  /** A trial item (an import started from the setup wizard as trial items). */
  isTestData?: boolean;
};

/**
 * Bulk creation for the catalog import: the same rows createProduct makes (product, variant, base
 * unit with factor 1, optional larger unit, barcodes, DEFAULT prices, searchText), written with a
 * handful of multi-row INSERTs instead of ~20 statements per product. The caller holds the locks
 * (taxonomy when ids are set, the SKU counter via nextSkusCore), has checked that every SKU and
 * barcode is free and every category/brand is active, the currencies enabled and price.change.
 * Barcodes are inserted in code order so two concurrent bulk inserts take index locks in one order.
 * A unique violation (a code or SKU committed by someone else meanwhile) propagates as the raw
 * database error; the transaction is then aborted and the caller decides (retry the slice).
 */
export async function insertProductsCore(
  tx: Tx,
  businessId: string,
  items: readonly NewCatalogItem[],
  /** Codes for EXISTING units (checked free by the caller, under the product lock); inserted in the same sorted INSERT. */
  extraBarcodes: readonly { unitId: string; code: string }[] = [],
): Promise<{ productId: string; variantId: string }[]> {
  const rows = items.map((raw) => {
    // Stored in the canonical form (canonicalBarcode also refuses what normalizeBarcode refuses).
    const item: NewCatalogItem = {
      ...raw,
      baseUnit: { ...raw.baseUnit, barcodes: raw.baseUnit.barcodes.map(canonicalBarcode) },
      ...(raw.pack ? { pack: { ...raw.pack, barcodes: raw.pack.barcodes.map(canonicalBarcode) } } : {}),
    };
    if (item.pack) checkFactor(item.pack.factor);
    const names = [item.nameAr, item.nameCkb, item.nameEn].filter((n): n is string => !!n);
    const codes = [...item.baseUnit.barcodes, ...(item.pack?.barcodes ?? [])];
    return {
      item,
      productId: randomUUID(),
      variantId: randomUUID(),
      baseUnitId: randomUUID(),
      packUnitId: item.pack ? randomUUID() : null,
      productText: productSearchText(names, [item.sku]),
      variantText: variantSearchText(names, item.sku, null, codes),
    };
  });
  if (rows.length > 0) await tx.rtProduct.createMany({
    data: rows.map((r) => ({
      id: r.productId,
      businessId,
      nameAr: r.item.nameAr,
      nameCkb: r.item.nameCkb,
      nameEn: r.item.nameEn,
      categoryId: r.item.categoryId,
      brandId: r.item.brandId,
      searchText: r.productText,
      isTestData: r.item.isTestData === true,
    })),
  });
  if (rows.length > 0) await tx.rtVariant.createMany({
    data: rows.map((r) => ({ id: r.variantId, businessId, productId: r.productId, sku: r.item.sku, searchText: r.variantText })),
  });
  if (rows.length > 0) await tx.rtUnit.createMany({
    data: rows.flatMap((r) => [
      { id: r.baseUnitId, businessId, variantId: r.variantId, name: r.item.baseUnit.name, factor: 1, isBase: true, quantityScale: 0 },
      ...(r.item.pack && r.packUnitId
        ? [{ id: r.packUnitId, businessId, variantId: r.variantId, name: r.item.pack.name, factor: r.item.pack.factor, isBase: false, quantityScale: 0 }]
        : []),
    ]),
  });
  const codes: { businessId: string; unitId: string; code: string }[] = rows
    .flatMap((r): { businessId: string; unitId: string; code: string }[] => [
      ...r.item.baseUnit.barcodes.map((code) => ({ businessId, unitId: r.baseUnitId, code })),
      ...(r.packUnitId ? (r.item.pack?.barcodes ?? []).map((code) => ({ businessId, unitId: r.packUnitId!, code })) : []),
    ])
    .concat(extraBarcodes.map((b) => ({ businessId, unitId: b.unitId, code: canonicalBarcode(b.code) })))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  if (codes.length > 0) await tx.rtBarcode.createMany({ data: codes });
  const priced = rows.filter((r) => r.item.price !== null);
  if (priced.length > 0) {
    const lists = await ensureDefaultLists(tx, businessId);
    const validFrom = new Date();
    await tx.rtPrice.createMany({
      data: priced.map((r) => ({
        businessId,
        unitId: r.packUnitId ?? r.baseUnitId,
        priceListId: lists.DEFAULT,
        currency: r.item.price!.currency,
        amountMinor: r.item.price!.amountMinor,
        validFrom,
        validTo: null,
      })),
    });
  }
  return rows.map((r) => ({ productId: r.productId, variantId: r.variantId }));
}

const productSelect = {
  id: true,
  nameAr: true,
  nameCkb: true,
  nameEn: true,
  descriptionAr: true,
  descriptionCkb: true,
  descriptionEn: true,
  categoryId: true,
  brandId: true,
  trackingMode: true,
  soldByWeight: true,
  tracksExpiry: true,
  expiryAlertDays: true,
  isTestData: true,
  archivedAt: true,
  version: true,
} as const;

const audit = (entity: string, entityId: string, changes: Record<string, unknown>) => ({ entity, entityId, changes });

// ---------------------------------------------------------------------------------------------
// Products

export type CreatedProduct = { productId: string; variantId: string; baseUnitId: string; sku: string };

/** A product with its default variant, base unit, optional larger units, barcodes and price. */
export const createProduct = defineAction({
  name: "catalog.product.create",
  permission: "catalog.manage",
  input: createInput,
  writes: true,
  async run({ actor, tx, input, lockBusiness }): Promise<CreatedProduct> {
    needsPricePermission(actor, wantsPrice(input));
    assertMayMarkTrial(actor, input.isTestData);
    checkTracking(input);
    checkVariantParts(input, input.soldByWeight);
    if (input.price) await assertCurrencyEnabled(tx, input.price.currency);
    if (input.categoryId || input.brandId) {
      await lockBusiness(TAXONOMY_LOCK);
      await checkTaxonomy(tx, input.categoryId, input.brandId);
    }

    const product = await tx.rtProduct.create({
      data: {
        businessId: actor.businessId,
        nameAr: input.nameAr,
        nameCkb: input.nameCkb,
        nameEn: input.nameEn,
        descriptionAr: input.descriptionAr,
        descriptionCkb: input.descriptionCkb,
        descriptionEn: input.descriptionEn,
        categoryId: input.categoryId,
        brandId: input.brandId,
        trackingMode: input.trackingMode,
        soldByWeight: input.soldByWeight,
        tracksExpiry: input.tracksExpiry,
        expiryAlertDays: input.expiryAlertDays,
        isTestData: input.isTestData,
      },
      select: { id: true },
    });
    const v = await insertVariant(tx, actor.businessId, product.id, input);
    await refreshSearchText(tx, product.id);
    return { productId: product.id, ...v };
  },
  audit: (input, value) => audit("RtProduct", value.productId, { input, created: value }),
});

const minimalItem = z.object({ nameAr, baseUnitName: unitName, quantityScale }).strict();

/**
 * The smallest createProduct (R1b receipt intake, "create the new items"): an Arabic name, one
 * variant with a generated SKU and one base unit; no category, brand, price, barcode or tracking,
 * never a trial item. Runs inside the caller's action transaction; the caller has checked
 * catalog.manage. Takes no lock, like createProduct without taxonomy (nobody can reach the new
 * product before it commits; the SKU counter row is the only shared row and comes last).
 * INVALID_INPUT for a name or unit name createProduct would refuse.
 */
export async function createMinimalProductInTx(
  tx: Tx,
  businessId: string,
  item: { nameAr: string; baseUnitName: string; quantityScale: number },
): Promise<CreatedProduct> {
  const parsed = minimalItem.safeParse(item);
  if (!parsed.success) throw new RuleError("INVALID_INPUT");
  const { baseUnitName, quantityScale: scale } = parsed.data;
  const product = await tx.rtProduct.create({ data: { businessId, nameAr: parsed.data.nameAr }, select: { id: true } });
  const v = await insertVariant(tx, businessId, product.id, { options: null, baseUnit: { name: baseUnitName, quantityScale: scale, barcodes: [] }, extraUnits: [] });
  await refreshSearchText(tx, product.id);
  return { productId: product.id, ...v };
}

/** Changes the given fields (missing = unchanged, null = cleared). The SKU is not editable. */
export const updateProduct = defineAction({
  name: "catalog.product.update",
  permission: "catalog.manage",
  input: updateInput,
  writes: true,
  async run({ tx, input, lockBusiness }) {
    // Lock order: taxonomy (only when a category/brand is named), then the product.
    if (input.categoryId || input.brandId) await lockBusiness(TAXONOMY_LOCK);
    await lockBusiness(productLock(input.id));
    const current = await tx.rtProduct.findFirst({ where: { id: input.id, archivedAt: null }, select: productSelect });
    if (!current) throw new NotFoundError();
    const { id: productId, expectedVersion, ...changes } = input;
    const data = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) as Partial<typeof current>;
    const next = { ...current, ...data };
    checkTracking(next);
    if (next.trackingMode !== current.trackingMode || next.tracksExpiry !== current.tracksExpiry) {
      // After the first posted movement of any variant, how the product is tracked is history.
      const variants = await tx.rtVariant.findMany({ where: { productId }, select: { id: true } });
      const ids = variants.map((v) => v.id);
      await lockStockOf(lockBusiness, ids);
      if (await variantsHaveHistory(tx, ids)) throw new RuleError("TRACKING_RULE");
    }

    const newCategory = data.categoryId && data.categoryId !== current.categoryId ? data.categoryId : null;
    const newBrand = data.brandId && data.brandId !== current.brandId ? data.brandId : null;
    if (newCategory || newBrand) await checkTaxonomy(tx, newCategory, newBrand);
    if (next.soldByWeight) {
      const wholeOnly = await tx.rtUnit.count({
        where: { isBase: true, quantityScale: { lt: 1 }, variant: { productId, archivedAt: null } },
      });
      if (wholeOnly > 0) throw new RuleError("UNIT_RULE");
    }

    await updateVersioned(tx.rtProduct, { id: productId, archivedAt: null }, expectedVersion, data);
    await refreshSearchText(tx, productId);
    return tx.rtProduct.findFirstOrThrow({ where: { id: productId }, select: productSelect });
  },
  audit: (input) => audit("RtProduct", input.id, { input }),
});

/** Hides the product from lists; its variants, units, barcodes and SKUs stay (nothing is freed). */
export const archiveProduct = defineAction({
  name: "catalog.product.archive",
  permission: "catalog.manage",
  input: z.object({ id, expectedVersion: version }).strict(),
  writes: true,
  async run({ tx, input, lockBusiness }) {
    await lockBusiness(productLock(input.id));
    const row = await tx.rtProduct.findFirst({ where: { id: input.id, archivedAt: null }, select: { id: true } });
    if (!row) throw new NotFoundError();
    await updateVersioned(tx.rtProduct, { id: input.id, archivedAt: null }, input.expectedVersion, { archivedAt: new Date() });
    return tx.rtProduct.findFirstOrThrow({ where: { id: input.id }, select: { id: true, archivedAt: true, version: true } });
  },
  audit: (input) => audit("RtProduct", input.id, { input }),
});

/** Brings an archived product back (its variants, units, barcodes and SKUs never left). */
export const unarchiveProduct = defineAction({
  name: "catalog.product.unarchive",
  permission: "catalog.manage",
  input: z.object({ id, expectedVersion: version }).strict(),
  writes: true,
  async run({ tx, input, lockBusiness }) {
    await lockBusiness(productLock(input.id));
    const row = await tx.rtProduct.findFirst({ where: { id: input.id, archivedAt: { not: null } }, select: { id: true } });
    if (!row) throw new NotFoundError();
    await updateVersioned(tx.rtProduct, { id: input.id, archivedAt: { not: null } }, input.expectedVersion, { archivedAt: null });
    await refreshSearchText(tx, input.id);
    return tx.rtProduct.findFirstOrThrow({ where: { id: input.id }, select: { id: true, archivedAt: true, version: true } });
  },
  audit: (input) => audit("RtProduct", input.id, { input }),
});

// ---------------------------------------------------------------------------------------------
// Trial items (setup wizard)

/** Only staff.manage holders (OWNER, MANAGER: the people running setup) may mark or remove trial items. */
export function assertMayMarkTrial(actor: Actor, isTestData: boolean): void {
  if (isTestData && !can(actor.role, "staff.manage")) throw new ForbiddenError("staff.manage");
}

/** Products removed per transaction by removeTestProducts. */
export const TEST_REMOVE_SLICE = 200;

export type TestRemoveSlice = { removed: number; productIds: string[]; done: boolean };

/**
 * A check that a later release registers for a table that can point at a catalog item (a sale line,
 * a stock movement, a purchase): given variant ids about to be removed, true when any is referenced.
 * Then removeTestProducts refuses (TRIAL_IN_USE): a trial item that was sold is history, not a trial.
 * R1 registers none: no sales, stock or purchase tables exist yet, so nothing can reference a product
 * except the catalog's own rows (deleted below) and import rows (their match is set to null by the FK).
 */
export type TrialReferenceCheck = (tx: Tx, variantIds: readonly string[]) => Promise<boolean>;
const trialReferenceChecks = new Set<TrialReferenceCheck>();

/** Registers a reference check; returns its removal (used by tests). */
export function registerTrialReferenceCheck(check: TrialReferenceCheck): () => void {
  trialReferenceChecks.add(check);
  return () => trialReferenceChecks.delete(check);
}

/**
 * One slice of removeTestProducts: up to TEST_REMOVE_SLICE trial products (isTestData, archived or
 * not), each under its product lock taken in sorted id order (the catalog's lock order), deleted with
 * everything under them in FK-safe order: prices, barcodes, units, variants, products. Their barcodes
 * and manual SKUs are free again afterwards. The SKU counter is per business and is not rewound.
 */
export const removeTestProductsSlice = defineAction({
  name: "catalog.product.removeTestData",
  permission: "staff.manage",
  input: z.object({}).strict(),
  writes: true,
  async run({ actor, tx, lockBusiness }): Promise<TestRemoveSlice> {
    if (!can(actor.role, "catalog.manage")) throw new ForbiddenError("catalog.manage");
    const found = await tx.rtProduct.findMany({
      where: { isTestData: true },
      orderBy: { id: "asc" },
      take: TEST_REMOVE_SLICE,
      select: { id: true },
    });
    const ids = found.map((p) => p.id);
    if (ids.length === 0) return { removed: 0, productIds: [], done: true };
    for (const id of ids) await lockBusiness(productLock(id));
    // Re-read under the locks: a product adopted as real meanwhile (a real import's UPDATE) stays.
    const still = (await tx.rtProduct.findMany({ where: { id: { in: ids }, isTestData: true }, orderBy: { id: "asc" }, select: { id: true } })).map((p) => p.id);
    const variantIds = (await tx.rtVariant.findMany({ where: { productId: { in: still } }, select: { id: true } })).map((v) => v.id);
    for (const check of trialReferenceChecks) {
      if (await check(tx, variantIds)) throw new RuleError("TRIAL_IN_USE");
    }
    const unitIds = (await tx.rtUnit.findMany({ where: { variantId: { in: variantIds } }, select: { id: true } })).map((u) => u.id);
    await tx.rtPrice.deleteMany({ where: { unitId: { in: unitIds } } });
    await tx.rtBarcode.deleteMany({ where: { unitId: { in: unitIds } } });
    await tx.rtUnit.deleteMany({ where: { id: { in: unitIds } } });
    await tx.rtVariant.deleteMany({ where: { id: { in: variantIds } } });
    const { count } = await tx.rtProduct.deleteMany({ where: { id: { in: still }, isTestData: true } });
    return { removed: count, productIds: still, done: ids.length < TEST_REMOVE_SLICE };
  },
  // The ids are at most TEST_REMOVE_SLICE per row.
  audit: (_input, value) => audit("RtProduct", "", { removedTestProducts: value.removed, productIds: value.productIds.slice(0, TEST_REMOVE_SLICE) }),
});

/**
 * Deletes every trial product of the business, TEST_REMOVE_SLICE per transaction, and returns how
 * many. Each slice is an idempotent write keyed from the caller's key and the slice number (as
 * commitImport does), so repeating the call with the same key does not redo finished slices.
 */
export async function removeTestProducts(raw: unknown, meta: ActionMeta): Promise<Result<{ removed: number }>> {
  if (!validKey(meta.idempotencyKey)) return failure("INVALID_INPUT");
  const base = createHash("sha256").update(meta.idempotencyKey).digest("hex").slice(0, 40);
  let removed = 0;
  // Bounded: a business never has more products than this many slices can hold in R1.
  for (let n = 1; n <= 1_000; n += 1) {
    const r = await removeTestProductsSlice(raw, { ...meta, idempotencyKey: `test-remove:${base}:${n}` });
    if (!r.ok) return r;
    removed += r.value.removed;
    if (r.value.done) return { ok: true, value: { removed } };
  }
  return { ok: true, value: { removed } };
}

/** One product with its category and brand (names shown even when archived) and every variant, unit and barcode. */
export const getProduct = defineAction({
  name: "catalog.product.get",
  permission: null,
  input: z.object({ id }).strict(),
  writes: false,
  async run({ tx, input }) {
    // One level per query: a nested to-many select makes Prisma's interpreter send parallel
    // queries on the transaction's single connection (deprecated in pg, removed in pg@9).
    const taxonomy = { select: { id: true, nameAr: true, nameCkb: true, nameEn: true, archivedAt: true } } as const;
    const product = await tx.rtProduct.findFirst({
      where: { id: input.id },
      select: { ...productSelect, createdAt: true, category: taxonomy, brand: taxonomy },
    });
    if (!product) throw new NotFoundError();
    const variants = await tx.rtVariant.findMany({
      where: { productId: product.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, sku: true, options: true, archivedAt: true, version: true },
    });
    const units = await tx.rtUnit.findMany({
      where: { variantId: { in: variants.map((v) => v.id) } },
      orderBy: [{ isBase: "desc" }, { factor: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: unitSelect,
    });
    const codes = await tx.rtBarcode.findMany({
      where: { unitId: { in: units.map((u) => u.id) } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, unitId: true, code: true, archivedAt: true, version: true },
    });
    return {
      ...product,
      variants: variants.map((v) => ({
        ...v,
        units: units
          .filter((u) => u.variantId === v.id)
          .map((u) => ({ ...u, barcodes: codes.filter((b) => b.unitId === u.id) })),
      })),
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Product lock for child rows

export type LockFn = (name: string) => Promise<void>;

/** A row is changeable only while it and every parent up to the product are active. */
export const activeUnit = { archivedAt: null, variant: { archivedAt: null, product: { archivedAt: null } } } as const;

/*
 * Child actions resolve their productId with a cheap read that decides nothing (a row never moves
 * to another variant or product), take the product lock, then re-read everything they check.
 * NOT_FOUND when the row does not exist in this business.
 */
async function lockProductOfVariant(tx: Tx, lock: LockFn, variantId: string): Promise<void> {
  const row = await tx.rtVariant.findFirst({ where: { id: variantId }, select: { productId: true } });
  if (!row) throw new NotFoundError();
  await lock(productLock(row.productId));
}

export async function lockProductOfUnit(tx: Tx, lock: LockFn, unitId: string): Promise<void> {
  const row = await tx.rtUnit.findFirst({ where: { id: unitId }, select: { variant: { select: { productId: true } } } });
  if (!row) throw new NotFoundError();
  await lock(productLock(row.variant.productId));
}

async function lockProductOfBarcode(tx: Tx, lock: LockFn, barcodeId: string): Promise<void> {
  const row = await tx.rtBarcode.findFirst({
    where: { id: barcodeId },
    select: { unit: { select: { variant: { select: { productId: true } } } } },
  });
  if (!row) throw new NotFoundError();
  await lock(productLock(row.unit.variant.productId));
}

// ---------------------------------------------------------------------------------------------
// Variants

const optionsKey = (o: unknown): string => {
  if (!o || typeof o !== "object" || Array.isArray(o)) return "";
  return JSON.stringify(
    Object.entries(o as Record<string, unknown>)
      .map(([k, v]) => [normalizeSearchText(k), normalizeSearchText(String(v))])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
};

/** Adds a variant (e.g. size L / colour blue) with its own base unit; options must differ from every active variant. */
export const addVariant = defineAction({
  name: "catalog.variant.add",
  permission: "catalog.manage",
  input: z
    .object({ productId: id, sku: sku.optional(), options, ...variantParts })
    .strict()
    .refine(uniqueCodes),
  writes: true,
  async run({ actor, tx, input, lockBusiness }) {
    needsPricePermission(actor, wantsPrice(input));
    await lockBusiness(productLock(input.productId));
    const product = await tx.rtProduct.findFirst({
      where: { id: input.productId, archivedAt: null },
      select: { id: true, soldByWeight: true },
    });
    if (!product) throw new NotFoundError();
    checkVariantParts(input, product.soldByWeight);
    if (input.price) await assertCurrencyEnabled(tx, input.price.currency);
    const siblings = await tx.rtVariant.findMany({ where: { productId: product.id, archivedAt: null }, select: { options: true } });
    const wanted = optionsKey(input.options);
    if (siblings.some((v) => optionsKey(v.options) === wanted)) throw new RuleError("DUPLICATE_NAME");

    const v = await insertVariant(tx, actor.businessId, product.id, input);
    await refreshSearchText(tx, product.id);
    return v;
  },
  audit: (input, value) => audit("RtVariant", value.variantId, { input, created: value }),
});

/**
 * Archives a variant. Its SKU, units and barcodes stay reserved. The last active variant of a
 * product is refused (LAST_VARIANT): archive the product instead.
 */
export const archiveVariant = defineAction({
  name: "catalog.variant.archive",
  permission: "catalog.manage",
  input: z.object({ variantId: id, expectedVersion: version }).strict(),
  writes: true,
  async run({ tx, input, lockBusiness }) {
    await lockProductOfVariant(tx, lockBusiness, input.variantId);
    const variant = await tx.rtVariant.findFirst({
      where: { id: input.variantId, archivedAt: null, product: { archivedAt: null } },
      select: { id: true, productId: true },
    });
    if (!variant) throw new NotFoundError();
    const active = await tx.rtVariant.count({ where: { productId: variant.productId, archivedAt: null } });
    if (active <= 1) throw new RuleError("LAST_VARIANT");
    await updateVersioned(tx.rtVariant, { id: variant.id, archivedAt: null }, input.expectedVersion, { archivedAt: new Date() });
    await refreshSearchText(tx, variant.productId);
    return tx.rtVariant.findFirstOrThrow({ where: { id: variant.id }, select: { id: true, sku: true, archivedAt: true, version: true } });
  },
  audit: (input) => audit("RtVariant", input.variantId, { input }),
});

// ---------------------------------------------------------------------------------------------
// Units

/**
 * The prices a new unit gets, per currency, on the DEFAULT list: the explicit price, plus factor x
 * the base unit's current DEFAULT price for every other currency the base unit has (spec 7.9).
 * Derived prices only for a price.change holder; nobody else gets any (an explicit price was
 * already refused for them). Computed before any write, so an amount over the ceiling refuses the
 * whole call.
 */
async function newUnitPrices(
  tx: Tx,
  actor: Actor,
  variantId: string,
  factor: number,
  explicit: PriceInput | undefined,
): Promise<Map<Currency, bigint>> {
  const out = new Map<Currency, bigint>();
  if (!can(actor.role, "price.change")) return out;
  const base = await tx.rtUnit.findFirst({ where: { variantId, isBase: true }, select: { id: true } });
  if (base) {
    const now = new Date();
    const current = await tx.rtPrice.findMany({
      where: {
        unitId: base.id,
        priceList: { kind: "DEFAULT" },
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
      select: { currency: true, amountMinor: true },
    });
    for (const p of current) out.set(p.currency, derivedUnitPrice(p.amountMinor, factor));
  }
  if (explicit) out.set(explicit.currency, explicit.amountMinor);
  return out;
}

/** A larger (non-base) unit of an active variant, with optional barcodes and price. */
export const addUnit = defineAction({
  name: "catalog.unit.add",
  permission: "catalog.manage",
  input: z
    .object({ variantId: id, name: unitName, factor: z.number(), quantityScale: quantityScale.default(0), barcodes, price: price.optional() })
    .strict()
    .refine((v) => new Set(v.barcodes).size === v.barcodes.length),
  writes: true,
  async run({ actor, tx, input, lockBusiness }) {
    needsPricePermission(actor, input.price !== undefined);
    checkFactor(input.factor);
    await lockProductOfVariant(tx, lockBusiness, input.variantId);
    const variant = await tx.rtVariant.findFirst({
      where: { id: input.variantId, archivedAt: null, product: { archivedAt: null } },
      select: { id: true, productId: true },
    });
    if (!variant) throw new NotFoundError();
    const siblings = await tx.rtUnit.findMany({ where: { variantId: variant.id, archivedAt: null }, select: { name: true } });
    checkUnitNames([...siblings.map((u) => u.name), input.name]);
    if (input.price) await assertCurrencyEnabled(tx, input.price.currency);
    const prices = await newUnitPrices(tx, actor, variant.id, input.factor, input.price);
    await assertBarcodesFree(tx, input.barcodes);

    const unit = await tx.rtUnit.create({
      data: {
        businessId: actor.businessId,
        variantId: variant.id,
        name: input.name,
        factor: input.factor,
        isBase: false,
        quantityScale: input.quantityScale,
      },
      select: unitSelect,
    });
    for (const code of input.barcodes) await insertBarcode(tx, actor.businessId, unit.id, code);
    if (prices.size > 0) {
      const lists = await ensureDefaultLists(tx, actor.businessId);
      const validFrom = new Date();
      for (const [currency, amountMinor] of prices) {
        await applyPrice(tx, { businessId: actor.businessId, unitId: unit.id, priceListId: lists.DEFAULT, currency, amountMinor, validFrom });
      }
    }
    await refreshSearchText(tx, variant.productId);
    return unit;
  },
  audit: (input, value) => audit("RtUnit", value.id, { input }),
});

/**
 * Renames a unit or changes its decimals or factor. The base unit keeps factor 1; any other
 * factor can change only while unitIsLocked says no (no posted stock movement of its variant), and
 * the decimals can then only grow.
 */
export const updateUnit = defineAction({
  name: "catalog.unit.update",
  permission: "catalog.manage",
  input: z
    .object({ id, expectedVersion: version, name: unitName.optional(), quantityScale: quantityScale.optional(), factor: z.number().optional() })
    .strict(),
  writes: true,
  async run({ tx, input, lockBusiness }) {
    await lockProductOfUnit(tx, lockBusiness, input.id);
    const unit = await tx.rtUnit.findFirst({
      where: { id: input.id, ...activeUnit },
      select: { ...unitSelect, variant: { select: { productId: true, product: { select: { soldByWeight: true } } } } },
    });
    if (!unit) throw new NotFoundError();

    if (input.factor !== undefined && input.factor !== unit.factor) {
      if (unit.isBase) throw new RuleError("UNIT_RULE");
      checkFactor(input.factor);
      await lockStockOf(lockBusiness, [unit.variantId]);
      if (await unitIsLocked(tx, unit.id)) throw new RuleError("UNIT_RULE");
    }
    if (input.quantityScale !== undefined && unit.isBase && unit.variant.product.soldByWeight && input.quantityScale < 1) {
      throw new RuleError("UNIT_RULE");
    }
    if (input.quantityScale !== undefined && input.quantityScale < unit.quantityScale) {
      // Fewer decimals could strand a fractional quantity already in the ledger.
      await lockStockOf(lockBusiness, [unit.variantId]);
      if (await unitIsLocked(tx, unit.id)) throw new RuleError("UNIT_RULE");
    }
    if (input.name !== undefined) {
      const others = await tx.rtUnit.findMany({
        where: { variantId: unit.variantId, archivedAt: null, id: { not: unit.id } },
        select: { name: true },
      });
      checkUnitNames([...others.map((o) => o.name), input.name]);
    }

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.quantityScale !== undefined) data.quantityScale = input.quantityScale;
    if (input.factor !== undefined) data.factor = input.factor;
    await updateVersioned(tx.rtUnit, { id: unit.id, archivedAt: null }, input.expectedVersion, data);
    return tx.rtUnit.findFirstOrThrow({ where: { id: unit.id }, select: unitSelect });
  },
  audit: (input) => audit("RtUnit", input.id, { input }),
});

/** Archives a non-base unit; its barcodes stay reserved. The base unit is refused (UNIT_RULE). */
export const archiveUnit = defineAction({
  name: "catalog.unit.archive",
  permission: "catalog.manage",
  input: z.object({ id, expectedVersion: version }).strict(),
  writes: true,
  async run({ tx, input, lockBusiness }) {
    await lockProductOfUnit(tx, lockBusiness, input.id);
    const unit = await tx.rtUnit.findFirst({
      where: { id: input.id, ...activeUnit },
      select: { id: true, isBase: true, variant: { select: { productId: true } } },
    });
    if (!unit) throw new NotFoundError();
    if (unit.isBase) throw new RuleError("UNIT_RULE");
    await updateVersioned(tx.rtUnit, { id: unit.id, archivedAt: null }, input.expectedVersion, { archivedAt: new Date() });
    await refreshSearchText(tx, unit.variant.productId);
    return tx.rtUnit.findFirstOrThrow({ where: { id: unit.id }, select: unitSelect });
  },
  audit: (input) => audit("RtUnit", input.id, { input }),
});

// ---------------------------------------------------------------------------------------------
// Barcodes

/** Adds a barcode to an active unit of an active product. Leading zeros are kept; Arabic digits become ASCII. */
export const addBarcode = defineAction({
  name: "catalog.barcode.add",
  permission: "catalog.manage",
  input: z.object({ unitId: id, code: barcode }).strict(),
  writes: true,
  async run({ actor, tx, input, lockBusiness }) {
    await lockProductOfUnit(tx, lockBusiness, input.unitId);
    const unit = await tx.rtUnit.findFirst({
      where: { id: input.unitId, ...activeUnit },
      select: { id: true, variant: { select: { productId: true } } },
    });
    if (!unit) throw new NotFoundError();
    await assertBarcodesFree(tx, [input.code]);
    const row = await insertBarcode(tx, actor.businessId, unit.id, input.code);
    await refreshSearchText(tx, unit.variant.productId);
    return row;
  },
  audit: (input, value) => audit("RtBarcode", value.id, { input }),
});

/** Archives a barcode of an active unit. It stays reserved: no other unit can take the code. */
export const archiveBarcode = defineAction({
  name: "catalog.barcode.archive",
  permission: "catalog.manage",
  input: z.object({ id, expectedVersion: version }).strict(),
  writes: true,
  async run({ tx, input, lockBusiness }) {
    await lockProductOfBarcode(tx, lockBusiness, input.id);
    const row = await tx.rtBarcode.findFirst({
      where: { id: input.id, archivedAt: null, unit: activeUnit },
      select: { id: true, unit: { select: { variant: { select: { productId: true } } } } },
    });
    if (!row) throw new NotFoundError();
    await updateVersioned(tx.rtBarcode, { id: row.id, archivedAt: null }, input.expectedVersion, { archivedAt: new Date() });
    await refreshSearchText(tx, row.unit.variant.productId);
    return tx.rtBarcode.findFirstOrThrow({
      where: { id: row.id },
      select: { id: true, unitId: true, code: true, archivedAt: true, version: true },
    });
  },
  audit: (input) => audit("RtBarcode", input.id, { input }),
});
