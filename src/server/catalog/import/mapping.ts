import { normalizeSearchText } from "@/server/domain/catalog";

/** The columns an import file may carry. */
export const KNOWN_COLUMNS = [
  "barcode",
  "name",
  "nameCkb",
  "nameEn",
  "category",
  "brand",
  "unit",
  "factor",
  "price",
  "currency",
  "sku",
] as const;

export type KnownColumn = (typeof KNOWN_COLUMNS)[number];

/** Column index in the file for each known column, or null when the file has no such column. */
export type Mapping = Record<KnownColumn, number | null>;

export type MappingProblem = "MISSING_NAME" | "MISSING_IDENTIFIER" | "DUPLICATE_COLUMN";

/** Header spelling used for matching: normalized Arabic/Kurdish letters, no punctuation, single spaces. */
export function headerKey(s: string): string {
  return normalizeSearchText(s)
    .replace(/[_\-:*()[\]{}.،,;/\\|#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Aliases per column: Arabic, Kurdish (Sorani) and English. They go through the same normalization
// as the headers, so letter variants (ة/ه, أ/ا, ی/ي, ک/ك) and digits need no separate entry.
export const ALIASES: Record<KnownColumn, readonly string[]> = {
  barcode: ["barcode", "bar code", "ean", "upc", "gtin", "الباركود", "باركود", "بار كود", "الرمز الشريطي", "رمز شريطي", "بارکۆد", "بارکۆدی کاڵا", "کۆدی بارکۆد"],
  name: ["name", "item", "item name", "product", "product name", "title", "اسم", "الاسم", "اسم المادة", "اسم الصنف", "اسم المنتج", "المادة", "الصنف", "المنتج", "ناو", "ناوی کاڵا", "ناوی ماددە", "کاڵا"],
  nameCkb: ["name ckb", "name kurdish", "kurdish name", "name ku", "الاسم الكردي", "اسم كردي", "الاسم بالكردي", "الاسم كردي", "ناوی کوردی", "ناو بە کوردی", "ناوی کوردی کاڵا"],
  nameEn: ["name en", "name english", "english name", "name eng", "الاسم الانجليزي", "اسم انجليزي", "الاسم بالانجليزي", "الاسم انكليزي", "الاسم الإنجليزي", "ناوی ئینگلیزی", "ناو بە ئینگلیزی"],
  category: ["category", "group", "department", "الفئة", "التصنيف", "القسم", "المجموعة", "الفئه", "فئة", "تصنيف", "قسم", "پۆل", "پۆلێن", "بەش"],
  brand: ["brand", "maker", "manufacturer", "ماركة", "الماركة", "العلامة التجارية", "الشركة", "براند", "مارکە", "ماركه", "کۆمپانیا"],
  unit: ["unit", "uom", "unit name", "الوحدة", "وحدة", "یەکە", "یەکەی کاڵا"],
  factor: ["factor", "conversion", "conversion factor", "qty per unit", "pack size", "معامل", "معامل التحويل", "عدد في الوحدة", "عدد القطع", "هاوکۆلکە", "هاوکۆلکەی گۆڕین"],
  price: ["price", "sale price", "selling price", "unit price", "السعر", "سعر", "سعر البيع", "نرخ", "نرخی فرۆشتن"],
  currency: ["currency", "cur", "ccy", "العملة", "عملة", "دراو", "دراوی"],
  sku: ["sku", "item code", "product code", "item no", "رمز الصنف", "كود الصنف", "كود المادة", "رقم الصنف", "رمز المنتج", "کۆدی کاڵا"],
};

/**
 * A header matcher for a set of columns and their aliases (the catalog's here, the opening stock's
 * in src/server/stock/import.ts): maps each column to the first header that names it; the rest of
 * the headers are ignored. Throws at load when one alias names two columns.
 */
export function headerMatcher<C extends string>(columns: readonly C[], aliases: Record<C, readonly string[]>) {
  const byHeader = new Map<string, C>();
  for (const col of columns) {
    for (const alias of aliases[col]) {
      const key = headerKey(alias);
      const prev = byHeader.get(key);
      if (prev !== undefined && prev !== col) throw new Error(`Import header alias "${alias}" belongs to ${prev} and ${col}`);
      byHeader.set(key, col);
    }
  }
  return (headers: readonly string[]): Record<C, number | null> => {
    const mapping = Object.fromEntries(columns.map((c) => [c, null])) as Record<C, number | null>;
    headers.forEach((h, index) => {
      const col = byHeader.get(headerKey(h));
      if (col !== undefined && mapping[col] === null) mapping[col] = index;
    });
    return mapping;
  };
}

/** Maps each known column to the first header that names it; the rest of the headers are ignored. */
export const autoMapHeaders: (headers: readonly string[]) => Mapping = headerMatcher(KNOWN_COLUMNS, ALIASES);

/** name and (barcode or sku) must be mapped, and no file column may feed two targets. */
export function validateMapping(mapping: Mapping): { ok: boolean; problems: MappingProblem[] } {
  const problems: MappingProblem[] = [];
  const mapped = (c: KnownColumn) => Number.isInteger(mapping[c]) && (mapping[c] as number) >= 0;
  if (!mapped("name")) problems.push("MISSING_NAME");
  if (!mapped("barcode") && !mapped("sku")) problems.push("MISSING_IDENTIFIER");
  const used = KNOWN_COLUMNS.filter(mapped).map((c) => mapping[c] as number);
  if (new Set(used).size !== used.length) problems.push("DUPLICATE_COLUMN");
  return { ok: problems.length === 0, problems };
}
