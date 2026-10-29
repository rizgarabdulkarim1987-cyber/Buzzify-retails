import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { Currency } from "@/generated/prisma/enums";
import { normalizeBarcode, normalizeSearchText } from "@/server/domain/catalog";
import { defineAction } from "@/server/framework/action";
import { RuleError } from "@/server/framework/errors";

/*
 * Catalog search (spec 2 goal 3, 7 item 2, 8 "البحث العربي"). A read: any active member, refused
 * only when the business is CLOSED (the framework's gate).
 *
 * One hit is one VARIANT (the sellable item). Order:
 *   1. the exact barcode (after normalizeBarcode: Arabic digits to ASCII, leading zeros kept, so
 *      "0012345" and "12345" are different codes); the hit carries the unit that owns the code;
 *   2. an exact SKU, case-insensitive;
 *   3. everything whose normalized searchText contains EVERY token of the normalized query
 *      (AND of `contains`; the GIN trigram index on searchText accelerates `%token%`), ordered by
 *      (product nameAr, variant id). nameAr is ordered as the database stores it (not normalized):
 *      the sort key must be a column for keyset paging. The brief's prefix/earlier-token ranking is
 *      not done: it would need a computed rank in the keyset.
 * An empty query is a browse list (step 3 without tokens). A partial barcode typed by hand still
 * matches as text (the variant's searchText holds its barcodes), but only the full code gets the
 * barcode hit.
 *
 * Paging is keyset: nextCursor is opaque (base64url JSON). Steps 1 and 2 are a handful of rows,
 * recomputed on every page and excluded from step 3 by id; the cursor is {s: how many of them were
 * already returned} while they last, then {a: last nameAr, i: last variant id}. No OFFSET.
 *
 * Archived: hidden (product, variant) unless includeArchived. Archived units and barcodes are never
 * matched (refreshSearchText drops their barcodes from the text too).
 *
 * Price: `basePrice` is the current DEFAULT-list price of the hit's unit (the base unit, or the
 * unit whose barcode was scanned, so a carton scan shows the carton price) in the business default
 * currency, else the first currency alphabetically that has one. Prices, units and variants are
 * loaded with `in` filters: a constant number of queries per page, never per hit.
 *
 * Safety: the query is user text and only ever reaches Prisma as a parameter. LIKE wildcards
 * (% _ \) are escaped (see likeLiteral).
 */

type Tx = Prisma.TransactionClient;

export const MAX_QUERY_LENGTH = 100;
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 25;
const MAX_TOKENS = 10;
const MAX_EXACT_SKU_HITS = 5;

const id = z.string().min(1).max(64);

const searchInput = z
  .object({
    query: z.string().max(MAX_QUERY_LENGTH).default(""),
    categoryId: id.optional(),
    brandId: id.optional(),
    includeArchived: z.boolean().default(false),
    cursor: z.string().min(1).max(600).optional(),
    limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
  })
  .strict();

export type CatalogHit = {
  productId: string;
  variantId: string;
  unitId?: string;
  nameAr: string;
  nameCkb?: string;
  nameEn?: string;
  sku: string;
  matchedBarcode?: string;
  matchedUnitName?: string;
  basePrice?: { currency: Currency; amountMinor: bigint };
};

// ---------------------------------------------------------------------------------------------
// Cursor

const cursorSchema = z.union([
  z.object({ s: z.number().int().min(0).max(1000) }).strict(),
  z.object({ a: z.string().max(400), i: id }).strict(),
]);
type Cursor = z.infer<typeof cursorSchema>;

const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify(c), "utf8").toString("base64url");

function decodeCursor(raw: string): Cursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    throw new RuleError("INVALID_INPUT");
  }
}

// ---------------------------------------------------------------------------------------------
// Query pieces

/** Escapes the LIKE metacharacters so a token is matched literally. */
export const likeLiteral = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

type Special = { variantId: string; unitId?: string; matchedBarcode?: string; matchedUnitName?: string };

async function specialHits(tx: Tx, raw: string, normalized: string, variantWhere: Prisma.RtVariantWhereInput): Promise<Special[]> {
  const out: Special[] = [];
  let code: string | null = null;
  try {
    code = normalizeBarcode(raw);
  } catch {
    code = null;
  }
  if (code !== null) {
    const hit = await tx.rtBarcode.findFirst({
      where: { code, archivedAt: null, unit: { archivedAt: null, variant: variantWhere } },
      select: { code: true, unit: { select: { id: true, name: true, variantId: true } } },
    });
    if (hit) out.push({ variantId: hit.unit.variantId, unitId: hit.unit.id, matchedBarcode: hit.code, matchedUnitName: hit.unit.name });
  }
  if (normalized !== "" && !normalized.includes(" ")) {
    // `equals` + insensitive is an ILIKE without wildcards support from us: escape for it too.
    const skus = await tx.rtVariant.findMany({
      where: { ...variantWhere, sku: { equals: likeLiteral(normalized), mode: "insensitive" } },
      orderBy: { id: "asc" },
      take: MAX_EXACT_SKU_HITS,
      select: { id: true, sku: true },
    });
    for (const v of skus) {
      if (v.sku.toLowerCase() !== normalized) continue; // belt and braces: exact only
      if (!out.some((o) => o.variantId === v.id)) out.push({ variantId: v.id });
    }
  }
  return out;
}

async function businessCurrency(tx: Tx): Promise<Currency | null> {
  const biz = await tx.rtBusiness.findFirst({ select: { defaultCurrency: true } });
  return biz?.defaultCurrency ?? null;
}

// ---------------------------------------------------------------------------------------------

/** Finds variants by barcode, SKU or (Arabic-normalized) text; keyset paged. See the file comment. */
export const searchCatalog = defineAction({
  name: "catalog.search",
  permission: null,
  input: searchInput,
  writes: false,
  async run({ tx, input }): Promise<{ items: CatalogHit[]; nextCursor: string | null }> {
    const cursor = input.cursor !== undefined ? decodeCursor(input.cursor) : null;
    const normalized = normalizeSearchText(input.query);
    const tokens = normalized === "" ? [] : normalized.split(" ").slice(0, MAX_TOKENS);

    const variantWhere: Prisma.RtVariantWhereInput = {
      ...(input.includeArchived ? {} : { archivedAt: null }),
      product: {
        ...(input.includeArchived ? {} : { archivedAt: null }),
        ...(input.categoryId ? { categoryId: input.categoryId } : {}),
        ...(input.brandId ? { brandId: input.brandId } : {}),
      },
    };

    const specials = normalized === "" ? [] : await specialHits(tx, input.query, normalized, variantWhere);
    const limit = input.limit;

    // 1) the exact hits still to return on this page
    const specialStart = cursor === null ? 0 : "s" in cursor ? cursor.s : specials.length;
    const head = specials.slice(specialStart, specialStart + limit);
    let nextCursor: string | null = null;
    let textRows: { id: string; nameAr: string }[] = [];

    if (specialStart + limit < specials.length) {
      nextCursor = encodeCursor({ s: specialStart + limit });
    } else {
      // 2) the text matches, after the cursor, until the page is full (one extra row says "more")
      const room = limit - head.length;
      const after = cursor !== null && "a" in cursor ? cursor : null;
      const where: Prisma.RtVariantWhereInput = {
        AND: [
          variantWhere,
          ...(specials.length > 0 ? [{ id: { notIn: specials.map((s) => s.variantId) } }] : []),
          ...tokens.map((t) => ({ searchText: { contains: likeLiteral(t) } })),
          ...(after
            ? [{ OR: [{ product: { nameAr: { gt: after.a } } }, { product: { nameAr: after.a }, id: { gt: after.i } }] }]
            : []),
        ],
      };
      const rows = await tx.rtVariant.findMany({
        where,
        orderBy: [{ product: { nameAr: "asc" } }, { id: "asc" }],
        take: room + 1,
        select: { id: true, product: { select: { nameAr: true } } },
      });
      const more = rows.length > room;
      textRows = rows.slice(0, room).map((r) => ({ id: r.id, nameAr: r.product.nameAr }));
      if (more) {
        const last = textRows[textRows.length - 1];
        // room 0: the exact hits filled the page exactly and text matches follow from the start.
        nextCursor = last ? encodeCursor({ a: last.nameAr, i: last.id }) : encodeCursor({ s: specials.length });
      }
    }

    const ordered: Special[] = [...head, ...textRows.map((r) => ({ variantId: r.id }))];
    if (ordered.length === 0) return { items: [], nextCursor };

    // 3) hydrate: variants+products, base units, prices (one query each, `in` filters)
    const variantIds = ordered.map((o) => o.variantId);
    const variants = await tx.rtVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, sku: true, productId: true, product: { select: { nameAr: true, nameCkb: true, nameEn: true } } },
    });
    const byVariant = new Map(variants.map((v) => [v.id, v]));
    const bases = await tx.rtUnit.findMany({
      where: { variantId: { in: variantIds }, isBase: true },
      select: { id: true, variantId: true },
    });
    const baseOf = new Map(bases.map((u) => [u.variantId, u.id]));
    const unitOf = (o: Special) => o.unitId ?? baseOf.get(o.variantId);
    const unitIds = [...new Set(ordered.map(unitOf).filter((u): u is string => !!u))];

    const now = new Date();
    const prices = await tx.rtPrice.findMany({
      where: {
        unitId: { in: unitIds },
        priceList: { kind: "DEFAULT" },
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
      select: { unitId: true, currency: true, amountMinor: true },
    });
    const preferred = prices.length > 0 ? await businessCurrency(tx) : null;
    const priceOf = (unitId: string | undefined) => {
      if (!unitId) return undefined;
      const mine = prices.filter((p) => p.unitId === unitId).sort((x, y) => (x.currency < y.currency ? -1 : 1));
      const pick = mine.find((p) => p.currency === preferred) ?? mine[0];
      return pick ? { currency: pick.currency, amountMinor: pick.amountMinor } : undefined;
    };

    const items: CatalogHit[] = [];
    for (const o of ordered) {
      const v = byVariant.get(o.variantId);
      if (!v) continue; // cannot happen: the ids come from this business's variants
      const unitId = unitOf(o);
      const basePrice = priceOf(unitId);
      items.push({
        productId: v.productId,
        variantId: v.id,
        ...(unitId ? { unitId } : {}),
        nameAr: v.product.nameAr,
        ...(v.product.nameCkb ? { nameCkb: v.product.nameCkb } : {}),
        ...(v.product.nameEn ? { nameEn: v.product.nameEn } : {}),
        sku: v.sku,
        ...(o.matchedBarcode ? { matchedBarcode: o.matchedBarcode } : {}),
        ...(o.matchedUnitName ? { matchedUnitName: o.matchedUnitName } : {}),
        ...(basePrice ? { basePrice } : {}),
      });
    }
    return { items, nextCursor };
  },
});
