// Pure row validation for the catalog import. No database, no clock, no mutation of inputs.
// Task 9 builds the ExistingIndex from the database and stores the results (serializeRowResult).
import { MAX_PRICE_MINOR } from "@/server/catalog/price-core";
import { assertUnitFactor, normalizeBarcode, normalizeSearchText, parseMoneyText } from "@/server/domain/catalog";
import type { Currency } from "@/server/domain/money";
import type { Mapping } from "./mapping";

/** Field length limits; keep equal to MAX_PRODUCT_NAME_LENGTH, MAX_NAME_LENGTH, MAX_UNIT_NAME_LENGTH, MAX_SKU_LENGTH (tested). */
export const IMPORT_LIMITS = { name: 200, taxonomy: 120, unit: 40, sku: 64 } as const;

/** Numeric xlsx barcode cells shorter than this lost their leading zeros (EAN-8 is the shortest real code). */
const MIN_NUMERIC_BARCODE_DIGITS = 8;

/** What the database already holds for one identifier (a barcode, or `skuKey(sku)`). */
export type ExistingItem = {
  variantId: string;
  productId: string;
  /** The product or variant is archived: its codes stay reserved (BARCODE_TAKEN), so a row cannot reuse them. */
  archived: boolean;
  nameAr: string;
  nameCkb: string | null;
  nameEn: string | null;
  categoryName: string | null;
  brandName: string | null;
  unitName: string;
  /** Current price per currency, minor units, DEFAULT list. */
  prices: Partial<Record<Currency, bigint>>;
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
  diff?: DiffEntry[];
};

export type ValidateOptions = {
  /** "row:col" of cells stored as numbers in an xlsx (from parseImportFile). */
  numericCells?: ReadonlySet<string>;
};

const CURRENCY_ALIASES: Record<string, Currency> = {
  iqd: "IQD", "دينار": "IQD", "دينارعراقي": "IQD", "دع": "IQD", id: "IQD",
  usd: "USD", "us$": "USD", $: "USD", "دولار": "USD", "دولارامريكي": "USD", "دۆلار": "USD",
};

function currencyOf(text: string): Currency | null {
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

export function validateRows(
  rows: readonly (readonly string[])[],
  mapping: Mapping,
  existingIndex: ExistingIndex,
  businessCurrencies: BusinessCurrencies,
  options: ValidateOptions = {},
): RowResult[] {
  const claimed = new Set<string>();
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
        if (SCIENTIFIC.test(rawBarcode)) throw new Reject("NUMERIC_BARCODE_LOST_ZEROS");
        const col = mapping.barcode;
        if (col !== null && options.numericCells?.has(`${rowNumber}:${col}`)) {
          // A number cell: zeros may be gone. A short one, or one with a fraction, is not a barcode we can trust.
          if (!/^\d+$/.test(rawBarcode) || rawBarcode.length < MIN_NUMERIC_BARCODE_DIGITS) {
            throw new Reject("NUMERIC_BARCODE_LOST_ZEROS");
          }
        }
        try {
          barcode = normalizeBarcode(rawBarcode);
        } catch {
          throw new Reject("BAD_BARCODE");
        }
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
      if (sku.length > IMPORT_LIMITS.sku) throw new Reject("BAD_SKU");

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
      const idKey = barcode !== null ? barcode : skuKey(sku);
      const claims = [idKey, ...(barcode !== null && sku !== "" ? [skuKey(sku)] : [])];
      if (claims.some((k) => claimed.has(k))) throw new Reject("DUPLICATE_IN_FILE");

      const existing = existingIndex.get(idKey);
      if (existing?.archived) throw new Reject("ARCHIVED_BARCODE");

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

      const diff = diffAgainst(normalized, existing);
      results.push(
        diff.length > 0
          ? { rowNumber, status: "CHANGED", normalized, matchedVariantId: existing.variantId, diff }
          : { rowNumber, status: "SKIPPED", reason: "UNCHANGED", normalized, matchedVariantId: existing.variantId },
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
function diffAgainst(n: NormalizedRow, e: ExistingItem): DiffEntry[] {
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
    const before = e.prices[n.price.currency];
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
