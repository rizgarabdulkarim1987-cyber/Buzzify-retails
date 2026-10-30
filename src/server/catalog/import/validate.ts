// Pure row validation for the catalog import. No database, no clock, no mutation of inputs.
// Task 9 builds the ExistingIndex from the database and stores the results (serializeRowResult).
import { MAX_PRICE_MINOR } from "@/server/catalog/price-core";
import { SKU_PATTERN, assertUnitFactor, normalizeBarcode, normalizeSearchText, parseMoneyText } from "@/server/domain/catalog";
import type { Currency } from "@/server/domain/money";
import type { Mapping } from "./mapping";

/** Field length limits; keep equal to MAX_PRODUCT_NAME_LENGTH, MAX_NAME_LENGTH, MAX_UNIT_NAME_LENGTH, MAX_SKU_LENGTH (tested). */
export const IMPORT_LIMITS = { name: 200, taxonomy: 120, unit: 40, sku: 64 } as const;

/**
 * A barcode typed as a NUMBER in xlsx may have lost leading zeros, so only the real code lengths
 * (EAN-8, UPC-A 12, EAN-13, GTIN-14) are trusted; any other digit count is rejected.
 */
const NUMERIC_BARCODE_LENGTHS: ReadonlySet<number> = new Set([8, 12, 13, 14]);

/** One unit of an existing variant, with its current DEFAULT price per currency (minor units). */
export type ExistingUnit = { unitId: string; name: string; factor: number; prices: Partial<Record<Currency, bigint>> };

/** What the database already holds for one identifier (a barcode, or `skuKey(sku)`). */
export type ExistingItem = {
  variantId: string;
  productId: string;
  /** The barcode, its unit, the variant or the product is archived: the code stays reserved, so a row cannot reuse it. */
  archived: boolean;
  sku: string;
  nameAr: string;
  nameCkb: string | null;
  nameEn: string | null;
  categoryName: string | null;
  brandName: string | null;
  /** Barcode key: the unit that owns the code. SKU key: not used. */
  unit: ExistingUnit | null;
  /** The variant's active units (a SKU match picks the one whose factor equals the row's). */
  units: readonly ExistingUnit[];
};

/** Keyed by normalized barcode, or by `skuKey(sku)` for a SKU. */
export type ExistingIndex = ReadonlyMap<string, ExistingItem>;
export const skuKey = (sku: string): string => `sku:${sku}`;

export type BusinessCurrencies = { default: Currency; enabled: readonly string[] };

export type RowStatus = "OK" | "REJECTED" | "SKIPPED" | "CHANGED";
export type DiffEntry = { field: string; before: string | null; after: string };

export type NormalizedRow = {
  barcode: string | null;
  sku: string | null;
  name: string;
  nameCkb: string | null;
  nameEn: string | null;
  category: string | null;
  brand: string | null;
  unit: string | null;
  factor: number | null;
  price: { currency: Currency; amountMinor: bigint } | null;
};

export type RowResult = {
  /** 1-based, header excluded. */
  rowNumber: number;
  status: RowStatus;
  /** Stable machine code (MISSING_NAME, BAD_PRICE, DUPLICATE_IN_FILE, EMPTY_ROW, UNCHANGED, ...). */
  reason?: string;
  normalized?: NormalizedRow;
  matchedVariantId?: string;
  /** The existing unit the row was compared with (and a price change applies to). */
  matchedUnitId?: string;
  diff?: DiffEntry[];
};

export type ValidateOptions = {
  /** "row:col" of cells stored as numbers in an xlsx (from parseImportFile). */
  numericCells?: ReadonlySet<string>;
};

const CURRENCY_ALIASES: Record<string, Currency> = {
  iqd: "IQD", "دينار": "IQD", "دينارعراقي": "IQD", "دع": "IQD",
  usd: "USD", "us$": "USD", $: "USD", "دولار": "USD", "دولارامريكي": "USD", "دۆلار": "USD",
};

/** A currency cell (code, symbol or name; Arabic or Kurdish) to its code, or null when unknown. */
export function currencyOf(text: string): Currency | null {
  const key = normalizeSearchText(text).replace(/[.\s]/g, "");
  return CURRENCY_ALIASES[key] ?? null;
}

const SCIENTIFIC = /^\d+(?:\.\d+)?e[+-]?\d+$/i;

class Reject extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function parsePrice(text: string, cur: string, biz: BusinessCurrencies) {
  const t = text.trim();
  if (/^[-−–]/.test(t)) throw new Reject("NEGATIVE_PRICE");
  let currency: Currency;
  if (cur === "") currency = biz.default;
  else {
    const c = currencyOf(cur);
    if (c === null) throw new Reject("UNKNOWN_CURRENCY");
    currency = c;
  }
  if (!biz.enabled.includes(currency)) throw new Reject("UNKNOWN_CURRENCY");
  let amountMinor: bigint;
  try {
    amountMinor = parseMoneyText(t, currency);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg.startsWith("Fractions")) throw new Reject("FRACTIONAL_IQD");
    if (msg.includes("too large")) throw new Reject("PRICE_TOO_LARGE");
    throw new Reject("BAD_PRICE");
  }
  if (amountMinor > MAX_PRICE_MINOR) throw new Reject("PRICE_TOO_LARGE");
  return { currency, amountMinor };
}

/**
 * A non-empty barcode cell to a normalized code, or the reason it is refused: a number cell (xlsx)
 * that may have lost its leading zeros (NUMERIC_BARCODE_LOST_ZEROS) or text that is not a code
 * (BAD_BARCODE). Shared with the opening-stock import.
 */
export function parseBarcodeCell(raw: string, numericCell: boolean): { code: string } | { reason: string } {
  if (SCIENTIFIC.test(raw)) return { reason: "NUMERIC_BARCODE_LOST_ZEROS" };
  // A number cell: zeros may be gone. A short one, or one with a fraction, is not a barcode we can trust.
  if (numericCell && (!/^\d+$/.test(raw) || !NUMERIC_BARCODE_LENGTHS.has(raw.length))) return { reason: "NUMERIC_BARCODE_LOST_ZEROS" };
  try {
    return { code: normalizeBarcode(raw) };
  } catch {
    return { reason: "BAD_BARCODE" };
  }
}

export function validateRows(
  rows: readonly (readonly string[])[],
  mapping: Mapping,
  existingIndex: ExistingIndex,
  businessCurrencies: BusinessCurrencies,
  options: ValidateOptions = {},
): RowResult[] {
  const claimed = new Set<string>();
  // Existing variants already matched by an earlier valid row: one row per variant, whatever unit
  // or identifier it uses, so what is applied never depends on how commit slices the rows.
  const claimedVariants = new Set<string>();
  const results: RowResult[] = [];

  rows.forEach((cells, i) => {
    const rowNumber = i + 1;
    const get = (col: keyof Mapping): string => {
      const idx = mapping[col];
      return idx === null || idx === undefined ? "" : (cells[idx] ?? "").trim();
    };
    const reject = (reason: string): RowResult => ({ rowNumber, status: "REJECTED", reason });

    if (cells.every((c) => c.trim() === "")) {
      results.push({ rowNumber, status: "SKIPPED", reason: "EMPTY_ROW" });
      return;
    }

    try {
      const name = get("name");
      if (name === "") throw new Reject("MISSING_NAME");

      // Identity: the barcode, else the SKU.
      const rawBarcode = get("barcode");
      const sku = get("sku");
      let barcode: string | null = null;
      if (rawBarcode !== "") {
        const col = mapping.barcode;
        const read = parseBarcodeCell(rawBarcode, col !== null && options.numericCells?.has(`${rowNumber}:${col}`) === true);
        if ("reason" in read) throw new Reject(read.reason);
        barcode = read.code;
      }
      if (barcode === null && sku === "") throw new Reject("MISSING_IDENTIFIER");

      const nameCkb = get("nameCkb");
      const nameEn = get("nameEn");
      const category = get("category");
      const brand = get("brand");
      const unit = get("unit");
      if (name.length > IMPORT_LIMITS.name || nameCkb.length > IMPORT_LIMITS.name || nameEn.length > IMPORT_LIMITS.name) {
        throw new Reject("NAME_TOO_LONG");
      }
      if (category.length > IMPORT_LIMITS.taxonomy || brand.length > IMPORT_LIMITS.taxonomy) throw new Reject("NAME_TOO_LONG");
      if (unit.length > IMPORT_LIMITS.unit) throw new Reject("NAME_TOO_LONG");
      if (sku.length > IMPORT_LIMITS.sku || (sku !== "" && !SKU_PATTERN.test(sku))) throw new Reject("BAD_SKU");
      // Same rule as the catalog actions: a text must keep letters or digits after normalization.
      for (const text of [name, nameCkb, nameEn, category, brand, unit]) {
        if (text !== "" && normalizeSearchText(text) === "") throw new Reject("NO_CONTENT");
      }

      let factor: number | null = null;
      const factorText = get("factor");
      if (factorText !== "") {
        const digits = normalizeSearchText(factorText);
        try {
          if (!/^\d+$/.test(digits)) throw new Error("not a whole number");
          factor = Number(digits);
          assertUnitFactor(factor);
        } catch {
          throw new Reject("BAD_FACTOR");
        }
      }

      let price: NormalizedRow["price"] = null;
      const priceText = get("price");
      if (priceText !== "") price = parsePrice(priceText, get("currency"), businessCurrencies);

      // Repeated inside the file: the first valid row wins, later ones are rejected.
      const claims = [...(barcode !== null ? [barcode] : []), ...(sku !== "" ? [skuKey(sku)] : [])];
      if (claims.some((k) => claimed.has(k))) throw new Reject("DUPLICATE_IN_FILE");

      // Barcode first, then SKU. Two different products named by the barcode and the SKU is a conflict.
      const byBarcode = barcode !== null ? existingIndex.get(barcode) : undefined;
      const bySku = sku !== "" ? existingIndex.get(skuKey(sku)) : undefined;
      if (byBarcode && bySku && byBarcode.variantId !== bySku.variantId) throw new Reject("CONFLICTING_MATCH");
      const existing = byBarcode ?? bySku;
      if (existing?.archived) throw new Reject(byBarcode ? "ARCHIVED_BARCODE" : "ARCHIVED_SKU");
      // The unit compared: the barcode's own unit, or (SKU match) the active unit of the row's factor.
      let unitMatch: ExistingUnit | undefined;
      if (existing) {
        const wanted = factor ?? 1;
        if (byBarcode) {
          if (sku !== "" && sku !== byBarcode.sku) throw new Reject("SKU_MISMATCH");
          unitMatch = byBarcode.unit ?? undefined;
          if (!unitMatch || unitMatch.factor !== wanted) throw new Reject("UNIT_MISMATCH");
        } else {
          unitMatch = existing.units.find((u) => u.factor === wanted);
          if (!unitMatch) throw new Reject("UNIT_MISMATCH");
        }
        if (claimedVariants.has(existing.variantId)) throw new Reject("DUPLICATE_MATCH");
        claimedVariants.add(existing.variantId);
      }

      for (const k of claims) claimed.add(k);
      const normalized: NormalizedRow = {
        barcode,
        sku: sku === "" ? null : sku,
        name,
        nameCkb: nameCkb === "" ? null : nameCkb,
        nameEn: nameEn === "" ? null : nameEn,
        category: category === "" ? null : category,
        brand: brand === "" ? null : brand,
        unit: unit === "" ? null : unit,
        factor,
        price,
      };
      if (!existing) {
        results.push({ rowNumber, status: "OK", normalized });
        return;
      }

      const diff = diffAgainst(normalized, existing, unitMatch!);
      // A SKU match whose barcode is new to the catalog: adding the code is a change too.
      if (!byBarcode && barcode !== null) diff.push({ field: "barcode", before: null, after: barcode });
      const matched = { matchedVariantId: existing.variantId, matchedUnitId: unitMatch!.unitId };
      results.push(
        diff.length > 0
          ? { rowNumber, status: "CHANGED", normalized, ...matched, diff }
          : { rowNumber, status: "SKIPPED", reason: "UNCHANGED", normalized, ...matched },
      );
    } catch (e) {
      if (e instanceof Reject) {
        results.push(reject(e.code));
        return;
      }
      throw e;
    }
  });
  return results;
}

/** What the file would change on an existing product. Only columns present in the file (non-empty cells) count; unit and factor never do. */
function diffAgainst(n: NormalizedRow, e: ExistingItem, unit: ExistingUnit): DiffEntry[] {
  const diff: DiffEntry[] = [];
  if (n.name !== e.nameAr) diff.push({ field: "name", before: e.nameAr, after: n.name });
  if (n.nameCkb !== null && n.nameCkb !== (e.nameCkb ?? "")) diff.push({ field: "nameCkb", before: e.nameCkb, after: n.nameCkb });
  if (n.nameEn !== null && n.nameEn !== (e.nameEn ?? "")) diff.push({ field: "nameEn", before: e.nameEn, after: n.nameEn });
  if (n.category !== null && normalizeSearchText(n.category) !== normalizeSearchText(e.categoryName ?? "")) {
    diff.push({ field: "category", before: e.categoryName, after: n.category });
  }
  if (n.brand !== null && normalizeSearchText(n.brand) !== normalizeSearchText(e.brandName ?? "")) {
    diff.push({ field: "brand", before: e.brandName, after: n.brand });
  }
  if (n.price) {
    const before = unit.prices[n.price.currency];
    if (before === undefined || before !== n.price.amountMinor) {
      diff.push({
        field: `price.${n.price.currency}`,
        before: before === undefined ? null : before.toString(),
        after: n.price.amountMinor.toString(),
      });
    }
  }
  return diff;
}

export type SerializedRowResult = Omit<RowResult, "normalized"> & {
  normalized?: Omit<NormalizedRow, "price"> & { price: { currency: Currency; amountMinor: string } | null };
};

/** JSON-safe copy (bigint amounts become strings) for the Json columns of RtImportRow. */
export function serializeRowResult(r: RowResult): SerializedRowResult {
  const { normalized, ...rest } = r;
  if (!normalized) return rest;
  return {
    ...rest,
    normalized: {
      ...normalized,
      price: normalized.price ? { currency: normalized.price.currency, amountMinor: normalized.price.amountMinor.toString() } : null,
    },
  };
}
