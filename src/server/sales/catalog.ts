import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { Currency } from "@/generated/prisma/enums";
import { searchInTx } from "@/server/catalog/search";
import { defineAction } from "@/server/framework/action";

/*
 * What the till shows (R3): the top categories as big buttons and the items as tiles, each tile one
 * sellable unit with its current price. Reads (sale.create). Trial, archived and serial items are
 * left out (they cannot be sold). A tile sells the variant's base unit; a scanned barcode names its
 * own unit (a carton scan sells a carton). The price is the unit's current DEFAULT-list price in the
 * business currency (null: no price, the tile is shown but cannot be added). onHand is the unit's
 * stock at the given location in base units x 1000 (all batches, expired ones included; the sale
 * itself refuses what cannot be sold), or null when no location is given.
 */

type Tx = Prisma.TransactionClient;

export const MAX_SELL_ITEMS = 60;
const id = z.string().min(1).max(64);

export type SellCategory = {
  id: string;
  nameAr: string;
  nameCkb: string | null;
  nameEn: string | null;
  /** Sellable products in the category and everything under it (shown quietly on the till tile). */
  itemCount: number;
};

export type SellItem = {
  variantId: string;
  unitId: string;
  nameAr: string;
  nameCkb: string | null;
  nameEn: string | null;
  unitName: string;
  /** Decimal places the quantity may have (0 whole pieces, 3 grams of a kg). */
  quantityScale: number;
  /** Base units in one of this unit (1 for the base unit). */
  factor: number;
  soldByWeight: boolean;
  priceMinor: bigint | null;
  currency: Currency;
  onHand: bigint | null;
  /** The barcode that found it (a scan), or null. */
  matchedBarcode: string | null;
  /** The product's top-level category (what the till colours the tile by), or null. */
  categoryId: string | null;
  /** Batches that still hold stock at the location (base units x 1000), earliest expiry first, no expiry last; [] when stock was not read. */
  batches: { expiryDate: string | null; qty: bigint }[];
  /** The earliest expiry among those batches, or null. */
  earliestExpiry: string | null;
};

/** The active top-level categories, by Arabic name. */
export const listSellCategories = defineAction({
  name: "sale.categories",
  permission: "sale.create",
  input: z.object({}).strict(),
  writes: false,
  async run({ tx }): Promise<SellCategory[]> {
    const roots = await tx.rtCategory.findMany({
      where: { archivedAt: null, parentId: null },
      orderBy: [{ nameAr: "asc" }, { id: "asc" }],
      select: { id: true, nameAr: true, nameCkb: true, nameEn: true },
      take: 100,
    });
    const all = await activeCategories(tx);
    const grouped = await tx.rtProduct.groupBy({
      by: ["categoryId"],
      where: { archivedAt: null, isTestData: false, trackingMode: { not: "SERIAL" }, categoryId: { not: null } },
      _count: { _all: true },
    });
    const perRoot = new Map<string, number>();
    for (const g of grouped) {
      const root = rootOf(all, g.categoryId);
      if (root) perRoot.set(root, (perRoot.get(root) ?? 0) + g._count._all);
    }
    return roots.map((r) => ({ ...r, itemCount: perRoot.get(r.id) ?? 0 }));
  },
});

/** The current DEFAULT-list price (business currency) of each unit, null when it has none: refreshes a cart after PRICE_CHANGED. */
export const currentUnitPrices = defineAction({
  name: "sale.prices",
  permission: "sale.create",
  input: z.object({ unitIds: z.array(id).min(1).max(200) }).strict(),
  writes: false,
  async run({ tx, input }): Promise<Record<string, bigint | null>> {
    const biz = await tx.rtBusiness.findFirstOrThrow({ select: { defaultCurrency: true } });
    const now = new Date();
    const rows = await tx.rtPrice.findMany({
      where: {
        unitId: { in: input.unitIds },
        currency: biz.defaultCurrency,
        priceList: { kind: "DEFAULT" },
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
      select: { unitId: true, amountMinor: true },
    });
    const found = new Map(rows.map((r) => [r.unitId, r.amountMinor]));
    return Object.fromEntries(input.unitIds.map((u) => [u, found.get(u) ?? null]));
  },
});

type CatRow = { id: string; parentId: string | null };
const activeCategories = (tx: Tx): Promise<CatRow[]> => tx.rtCategory.findMany({ where: { archivedAt: null }, select: { id: true, parentId: true } });

/** The top-level ancestor of a category (itself when it has no parent), null when it is unknown or archived. */
function rootOf(all: readonly CatRow[], id: string | null): string | null {
  if (!id) return null;
  const byId = new Map(all.map((c) => [c.id, c]));
  let cur = byId.get(id);
  for (let i = 0; cur && cur.parentId && i < 32; i++) cur = byId.get(cur.parentId);
  return cur && !cur.parentId ? cur.id : null;
}

/** The category and every active category under it. */
function categoryTree(all: readonly CatRow[], rootId: string): string[] {
  const out = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of all) {
      if (c.parentId && out.has(c.parentId) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return [...out];
}

const sellable: Prisma.RtVariantWhereInput = {
  archivedAt: null,
  product: { archivedAt: null, isTestData: false, trackingMode: { not: "SERIAL" } },
};

/**
 * Tiles for the till: by category (with its sub-categories), by text or barcode, or the first
 * items. Browsing (no text) pages with offset; a search returns its best matches only.
 */
export const listSellItems = defineAction({
  name: "sale.items",
  permission: "sale.create",
  input: z
    .object({
      query: z.string().max(100).default(""),
      categoryId: id.nullish(),
      locationId: id.nullish(),
      limit: z.number().int().min(1).max(MAX_SELL_ITEMS).default(MAX_SELL_ITEMS),
      offset: z.number().int().min(0).max(100_000).default(0),
    })
    .strict(),
  writes: false,
  async run({ tx, input }): Promise<SellItem[]> {
    const biz = await tx.rtBusiness.findFirstOrThrow({ select: { defaultCurrency: true } });
    const cats = await activeCategories(tx);
    // Which variants, and (for a scan) which unit.
    let picks: { variantId: string; unitId?: string; matchedBarcode?: string }[];
    if (input.query.trim() !== "") {
      const hits = await searchInTx(tx, { query: input.query, includeArchived: false, limit: Math.min(input.limit, 50) });
      picks = hits.items
        .filter((h) => !h.isTestData && !h.archived)
        .map((h) => ({ variantId: h.variantId, ...(h.matchedBarcode ? { unitId: h.unitId, matchedBarcode: h.matchedBarcode } : {}) }));
    } else {
      const categoryIds = input.categoryId ? categoryTree(cats, input.categoryId) : null;
      const rows = await tx.rtVariant.findMany({
        where: { ...sellable, product: { ...(sellable.product as object), ...(categoryIds ? { categoryId: { in: categoryIds } } : {}) } },
        orderBy: [{ product: { nameAr: "asc" } }, { id: "asc" }],
        skip: input.offset,
        take: input.limit,
        select: { id: true },
      });
      picks = rows.map((r) => ({ variantId: r.id }));
    }
    if (picks.length === 0) return [];

    const variantIds = [...new Set(picks.map((p) => p.variantId))];
    const variants = await tx.rtVariant.findMany({
      where: { ...sellable, id: { in: variantIds } },
      select: { id: true, product: { select: { nameAr: true, nameCkb: true, nameEn: true, soldByWeight: true, categoryId: true } } },
    });
    const variantOf = new Map(variants.map((v) => [v.id, v]));
    const units = await tx.rtUnit.findMany({
      where: { variantId: { in: variantIds }, archivedAt: null },
      select: { id: true, variantId: true, name: true, factor: true, quantityScale: true, isBase: true },
    });
    const unitById = new Map(units.map((u) => [u.id, u]));
    const baseOf = new Map(units.filter((u) => u.isBase).map((u) => [u.variantId, u]));
    const chosen = picks
      .map((p) => ({ p, unit: p.unitId ? unitById.get(p.unitId) : baseOf.get(p.variantId), v: variantOf.get(p.variantId) }))
      .filter((c): c is { p: (typeof picks)[number]; unit: NonNullable<typeof c.unit>; v: NonNullable<typeof c.v> } => !!c.unit && !!c.v);

    const now = new Date();
    const prices = await tx.rtPrice.findMany({
      where: {
        unitId: { in: chosen.map((c) => c.unit.id) },
        currency: biz.defaultCurrency,
        priceList: { kind: "DEFAULT" },
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
      select: { unitId: true, amountMinor: true },
    });
    const priceOf = new Map(prices.map((p) => [p.unitId, p.amountMinor]));
    const stock = input.locationId
      ? await tx.rtStockBalance.groupBy({
          by: ["variantId"],
          where: { locationId: input.locationId, variantId: { in: variantIds } },
          _sum: { qty: true },
        })
      : null;
    const onHandOf = new Map((stock ?? []).map((s) => [s.variantId, s._sum.qty ?? 0n]));
    // Batches with stock: one read of the balances, one of their batches (no per-item queries).
    const batchesOf = new Map<string, { expiryDate: string | null; qty: bigint }[]>();
    if (input.locationId) {
      const rows = await tx.rtStockBalance.findMany({
        where: { locationId: input.locationId, variantId: { in: variantIds }, batchId: { not: null }, qty: { gt: 0n } },
        select: { variantId: true, batchId: true, qty: true },
      });
      const batchRows = await tx.rtBatch.findMany({ where: { id: { in: rows.map((r) => r.batchId!) } }, select: { id: true, expiryDate: true } });
      const expiryOf = new Map(batchRows.map((b) => [b.id, b.expiryDate ? b.expiryDate.toISOString().slice(0, 10) : null]));
      for (const r of rows) {
        const list = batchesOf.get(r.variantId) ?? [];
        list.push({ expiryDate: expiryOf.get(r.batchId!) ?? null, qty: r.qty });
        batchesOf.set(r.variantId, list);
      }
      for (const list of batchesOf.values()) {
        list.sort((a, b) => (a.expiryDate === b.expiryDate ? 0 : a.expiryDate === null ? 1 : b.expiryDate === null ? -1 : a.expiryDate < b.expiryDate ? -1 : 1));
      }
    }

    return chosen.map(({ p, unit, v }) => ({
      variantId: v.id,
      unitId: unit.id,
      nameAr: v.product.nameAr,
      nameCkb: v.product.nameCkb,
      nameEn: v.product.nameEn,
      unitName: unit.name,
      quantityScale: unit.quantityScale,
      factor: unit.factor,
      soldByWeight: v.product.soldByWeight,
      priceMinor: priceOf.get(unit.id) ?? null,
      currency: biz.defaultCurrency,
      onHand: stock ? (onHandOf.get(v.id) ?? 0n) : null,
      matchedBarcode: p.matchedBarcode ?? null,
      categoryId: rootOf(cats, v.product.categoryId),
      batches: batchesOf.get(v.id) ?? [],
      earliestExpiry: (batchesOf.get(v.id) ?? []).find((b) => b.expiryDate !== null)?.expiryDate ?? null,
    }));
  },
});
