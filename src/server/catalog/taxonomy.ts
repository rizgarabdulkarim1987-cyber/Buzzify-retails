import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { normalizeSearchText } from "@/server/domain/catalog";
import { defineAction } from "@/server/framework/action";
import { NotFoundError, RuleError } from "@/server/framework/errors";
import { updateVersioned } from "@/server/framework/versioned";

/*
 * Categories (a tree, at most MAX_CATEGORY_DEPTH levels) and brands (a flat list). Both carry the
 * name in three languages (Arabic required). Every write needs catalog.manage and is audited,
 * idempotent by key, version-checked on edits, and refused while the business is READ_ONLY/CLOSED
 * (all by defineAction). Reads are open to any active member.
 *
 * Archiving hides a row from the lists (unless includeArchived) and frees its name for reuse.
 * Names are compared with normalizeSearchText. Uniqueness is checked inside the transaction; two
 * simultaneous creates of the same name could both pass (no database constraint backs it).
 */

type Tx = Prisma.TransactionClient;

export const MAX_CATEGORY_DEPTH = 4;
export const MAX_NAME_LENGTH = 120;

const id = z.string().min(1).max(64);
const version = z.number().int().min(1);
const nameAr = z.string().trim().min(1).max(MAX_NAME_LENGTH);
const optionalName = z
  .string()
  .trim()
  .max(MAX_NAME_LENGTH)
  .nullish()
  .transform((v) => (v ? v : null));

const names = { nameAr, nameCkb: optionalName, nameEn: optionalName };

export type TaxonomyItem = {
  id: string;
  nameAr: string;
  nameCkb: string | null;
  nameEn: string | null;
  archivedAt: Date | null;
  version: number;
};
export type CategoryItem = TaxonomyItem & { parentId: string | null };
export type BrandItem = TaxonomyItem;

const itemSelect = { id: true, nameAr: true, nameCkb: true, nameEn: true, archivedAt: true, version: true } as const;
const categorySelect = { ...itemSelect, parentId: true } as const;

const key = (name: string) => normalizeSearchText(name);

// ---------------------------------------------------------------------------------------------
// Categories

type TreeRow = { id: string; parentId: string | null; nameAr: string; archivedAt: Date | null };

/** Every category of the business (active and archived), for tree checks in memory. */
async function loadTree(tx: Tx): Promise<Map<string, TreeRow>> {
  const rows = await tx.rtCategory.findMany({ select: { id: true, parentId: true, nameAr: true, archivedAt: true } });
  return new Map(rows.map((r) => [r.id, r]));
}

/** Levels from the root down to (and including) this row; 1 for a root category. */
function depthOf(tree: Map<string, TreeRow>, rowId: string): number {
  let depth = 0;
  for (let cur: string | null = rowId; cur !== null && depth <= MAX_CATEGORY_DEPTH + 1; ) {
    depth += 1;
    cur = tree.get(cur)?.parentId ?? null;
  }
  return depth;
}

/** Levels in the subtree below this row (0 when it has no children), archived rows included. */
function heightBelow(tree: Map<string, TreeRow>, rowId: string): number {
  let height = 0;
  const walk = (parent: string, level: number) => {
    for (const r of tree.values()) {
      if (r.parentId === parent) {
        height = Math.max(height, level);
        walk(r.id, level + 1);
      }
    }
  };
  walk(rowId, 1);
  return height;
}

function isSelfOrDescendant(tree: Map<string, TreeRow>, rowId: string, candidate: string): boolean {
  for (let cur: string | null = candidate, guard = 0; cur !== null && guard <= tree.size; guard += 1) {
    if (cur === rowId) return true;
    cur = tree.get(cur)?.parentId ?? null;
  }
  return false;
}

/** The new parent must exist, be active, and leave room for `subtreeLevels` (the moved row's own level counts). */
function checkParent(tree: Map<string, TreeRow>, parentId: string | null, subtreeLevels: number) {
  if (parentId === null) {
    if (subtreeLevels > MAX_CATEGORY_DEPTH) throw new RuleError("INVALID_INPUT");
    return;
  }
  const parent = tree.get(parentId);
  if (!parent || parent.archivedAt !== null) throw new NotFoundError();
  if (depthOf(tree, parentId) + subtreeLevels > MAX_CATEGORY_DEPTH) throw new RuleError("INVALID_INPUT");
}

function assertFreeSibling(tree: Map<string, TreeRow>, parentId: string | null, name: string, selfId: string | null) {
  const wanted = key(name);
  for (const r of tree.values()) {
    if (r.archivedAt === null && r.parentId === parentId && r.id !== selfId && key(r.nameAr) === wanted) {
      throw new RuleError("DUPLICATE_NAME");
    }
  }
}

const categoryAudit = (entityId: string, changes: Record<string, unknown>) => ({ entity: "RtCategory", entityId, changes });

export const createCategory = defineAction({
  name: "catalog.category.create",
  permission: "catalog.manage",
  input: z.object({ parentId: id.nullish().transform((v) => v ?? null), ...names }).strict(),
  writes: true,
  async run({ actor, tx, input }): Promise<CategoryItem> {
    const tree = await loadTree(tx);
    checkParent(tree, input.parentId, 1);
    assertFreeSibling(tree, input.parentId, input.nameAr, null);
    return tx.rtCategory.create({
      data: {
        businessId: actor.businessId,
        parentId: input.parentId,
        nameAr: input.nameAr,
        nameCkb: input.nameCkb,
        nameEn: input.nameEn,
      },
      select: categorySelect,
    });
  },
  audit: (input, value) => categoryAudit(value.id, { input }),
});

/** Replaces all three names of a category. */
export const renameCategory = defineAction({
  name: "catalog.category.rename",
  permission: "catalog.manage",
  input: z.object({ id, ...names, expectedVersion: version }).strict(),
  writes: true,
  async run({ tx, input }): Promise<CategoryItem> {
    const tree = await loadTree(tx);
    const row = tree.get(input.id);
    if (!row || row.archivedAt !== null) throw new NotFoundError();
    await updateVersioned(tx.rtCategory, { id: input.id, archivedAt: null }, input.expectedVersion, {
      nameAr: input.nameAr,
      nameCkb: input.nameCkb,
      nameEn: input.nameEn,
    });
    assertFreeSibling(tree, row.parentId, input.nameAr, input.id);
    return tx.rtCategory.findFirstOrThrow({ where: { id: input.id }, select: categorySelect });
  },
  audit: (input) => categoryAudit(input.id, { input }),
});

/** Moves a category (with its subtree) under another parent, or to the top level with parentId null. */
export const moveCategory = defineAction({
  name: "catalog.category.move",
  permission: "catalog.manage",
  input: z.object({ id, parentId: id.nullable(), expectedVersion: version }).strict(),
  writes: true,
  async run({ tx, input }): Promise<CategoryItem> {
    const tree = await loadTree(tx);
    const row = tree.get(input.id);
    if (!row || row.archivedAt !== null) throw new NotFoundError();
    await updateVersioned(tx.rtCategory, { id: input.id, archivedAt: null }, input.expectedVersion, { parentId: input.parentId });
    if (input.parentId !== null && isSelfOrDescendant(tree, input.id, input.parentId)) throw new RuleError("INVALID_INPUT");
    checkParent(tree, input.parentId, 1 + heightBelow(tree, input.id));
    assertFreeSibling(tree, input.parentId, row.nameAr, input.id);
    return tx.rtCategory.findFirstOrThrow({ where: { id: input.id }, select: categorySelect });
  },
  audit: (input) => categoryAudit(input.id, { input }),
});

/** Refused (CATEGORY_IN_USE) while the category has active subcategories or active products. */
export const archiveCategory = defineAction({
  name: "catalog.category.archive",
  permission: "catalog.manage",
  input: z.object({ id, expectedVersion: version }).strict(),
  writes: true,
  async run({ tx, input }): Promise<CategoryItem> {
    const row = await tx.rtCategory.findFirst({ where: { id: input.id, archivedAt: null }, select: { id: true } });
    if (!row) throw new NotFoundError();
    await updateVersioned(tx.rtCategory, { id: input.id, archivedAt: null }, input.expectedVersion, { archivedAt: new Date() });
    const children = await tx.rtCategory.count({ where: { parentId: input.id, archivedAt: null } });
    const products = await tx.rtProduct.count({ where: { categoryId: input.id, archivedAt: null } });
    if (children > 0 || products > 0) throw new RuleError("CATEGORY_IN_USE");
    return tx.rtCategory.findFirstOrThrow({ where: { id: input.id }, select: categorySelect });
  },
  audit: (input) => categoryAudit(input.id, { input }),
});

const listInput = z.object({ includeArchived: z.boolean().default(false) }).strict();

/** The business's categories as a flat list (parentId links the tree), oldest first. */
export const listCategories = defineAction({
  name: "catalog.category.list",
  permission: null,
  input: listInput,
  writes: false,
  async run({ tx, input }): Promise<CategoryItem[]> {
    return tx.rtCategory.findMany({
      where: input.includeArchived ? {} : { archivedAt: null },
      select: categorySelect,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  },
});

// ---------------------------------------------------------------------------------------------
// Brands

async function assertFreeBrandName(tx: Tx, name: string, selfId: string | null) {
  const wanted = key(name);
  const rows = await tx.rtBrand.findMany({ where: { archivedAt: null }, select: { id: true, nameAr: true } });
  if (rows.some((r) => r.id !== selfId && key(r.nameAr) === wanted)) throw new RuleError("DUPLICATE_NAME");
}

const brandAudit = (entityId: string, changes: Record<string, unknown>) => ({ entity: "RtBrand", entityId, changes });

export const createBrand = defineAction({
  name: "catalog.brand.create",
  permission: "catalog.manage",
  input: z.object(names).strict(),
  writes: true,
  async run({ actor, tx, input }): Promise<BrandItem> {
    await assertFreeBrandName(tx, input.nameAr, null);
    return tx.rtBrand.create({
      data: { businessId: actor.businessId, nameAr: input.nameAr, nameCkb: input.nameCkb, nameEn: input.nameEn },
      select: itemSelect,
    });
  },
  audit: (input, value) => brandAudit(value.id, { input }),
});

/** Replaces all three names of a brand. */
export const renameBrand = defineAction({
  name: "catalog.brand.rename",
  permission: "catalog.manage",
  input: z.object({ id, ...names, expectedVersion: version }).strict(),
  writes: true,
  async run({ tx, input }): Promise<BrandItem> {
    const row = await tx.rtBrand.findFirst({ where: { id: input.id, archivedAt: null }, select: { id: true } });
    if (!row) throw new NotFoundError();
    await updateVersioned(tx.rtBrand, { id: input.id, archivedAt: null }, input.expectedVersion, {
      nameAr: input.nameAr,
      nameCkb: input.nameCkb,
      nameEn: input.nameEn,
    });
    await assertFreeBrandName(tx, input.nameAr, input.id);
    return tx.rtBrand.findFirstOrThrow({ where: { id: input.id }, select: itemSelect });
  },
  audit: (input) => brandAudit(input.id, { input }),
});

export const archiveBrand = defineAction({
  name: "catalog.brand.archive",
  permission: "catalog.manage",
  input: z.object({ id, expectedVersion: version }).strict(),
  writes: true,
  async run({ tx, input }): Promise<BrandItem> {
    const row = await tx.rtBrand.findFirst({ where: { id: input.id, archivedAt: null }, select: { id: true } });
    if (!row) throw new NotFoundError();
    await updateVersioned(tx.rtBrand, { id: input.id, archivedAt: null }, input.expectedVersion, { archivedAt: new Date() });
    return tx.rtBrand.findFirstOrThrow({ where: { id: input.id }, select: itemSelect });
  },
  audit: (input) => brandAudit(input.id, { input }),
});

export const listBrands = defineAction({
  name: "catalog.brand.list",
  permission: null,
  input: listInput,
  writes: false,
  async run({ tx, input }): Promise<BrandItem[]> {
    return tx.rtBrand.findMany({
      where: input.includeArchived ? {} : { archivedAt: null },
      select: itemSelect,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  },
});
