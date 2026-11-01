import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  archiveBrand,
  archiveCategory,
  createBrand,
  createCategory,
  listBrands,
  listCategories,
  moveCategory,
  renameBrand,
  renameCategory,
} from "@/server/catalog/taxonomy";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

const { db } = useTestDb();

const key = () => randomUUID();
const DAY = 86_400_000;

async function business(label: string) {
  const w = await createBusinessWithStaff(db, {
    branches: ["A"],
    staff: [
      { key: "owner", role: "OWNER" },
      { key: "manager", role: "MANAGER", branches: ["A"] },
      { key: "stock", role: "STOCK", branches: ["A"] },
      { key: "cashier", role: "CASHIER", branches: ["A"] },
    ],
  });
  await db.rtBusiness.update({ where: { id: w.business.id }, data: { status: "ACTIVE", name: label } });
  await db.rtSubscription.create({
    data: {
      businessId: w.business.id,
      planCode: "basic",
      status: "ACTIVE",
      currentPeriodStart: new Date(Date.now() - DAY),
      currentPeriodEnd: new Date(Date.now() + 30 * DAY),
    },
  });
  const as = (who: string, k = key()) => ({ userId: w.staff[who]!.user.id, businessId: w.business.id, idempotencyKey: k });
  return { ...w, as };
}

async function world() {
  await createPlan(db, { maxBranches: 3 });
  return { a: await business("A shop"), b: await business("B shop") };
}

/** Creates a category and returns its id (fails the test when refused). */
async function cat(w: Awaited<ReturnType<typeof business>>, nameAr: string, parentId: string | null = null) {
  const r = await createCategory({ nameAr, parentId }, w.as("stock"));
  if (!r.ok) throw new Error(`createCategory failed: ${r.code}`);
  return r.value;
}

describe("categories", () => {
  it("a stock officer creates and renames categories, a cashier cannot", async () => {
    const { a } = await world();
    expect(await createCategory({ nameAr: "مشروبات" }, a.as("cashier"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const created = await createCategory({ nameAr: "  مشروبات  ", nameCkb: "خواردنەوە", nameEn: "Drinks" }, a.as("stock"));
    expect(created).toMatchObject({ ok: true, value: { nameAr: "مشروبات", nameCkb: "خواردنەوە", nameEn: "Drinks", parentId: null, version: 1 } });
    if (!created.ok) return;
    const id = created.value.id;

    expect(await renameCategory({ id, nameAr: "عصائر", expectedVersion: 1 }, a.as("cashier"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const renamed = await renameCategory({ id, nameAr: "عصائر", nameEn: "Juices", expectedVersion: 1 }, a.as("stock"));
    expect(renamed).toMatchObject({ ok: true, value: { id, nameAr: "عصائر", nameCkb: null, nameEn: "Juices", version: 2 } });
    expect(await db.rtCategory.findUniqueOrThrow({ where: { id } })).toMatchObject({ nameAr: "عصائر", nameCkb: null, version: 2 });
    expect(await db.rtAuditLog.count({ where: { businessId: a.business.id, action: { startsWith: "catalog.category" } } })).toBe(2);

    // Any member can read; the Arabic name is required and trimmed.
    const list = await listCategories({}, a.as("cashier"));
    expect(list).toMatchObject({ ok: true, value: [{ id, nameAr: "عصائر" }] });
    expect(await createCategory({ nameAr: "   " }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await createCategory({ nameAr: "x".repeat(121) }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await createCategory({ nameEn: "only english" }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("a category cannot become its own ancestor", async () => {
    const { a } = await world();
    const root = await cat(a, "الجذر");
    const child = await cat(a, "الابن", root.id);
    const grand = await cat(a, "الحفيد", child.id);

    expect(await moveCategory({ id: root.id, parentId: root.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await moveCategory({ id: root.id, parentId: grand.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await db.rtCategory.findUniqueOrThrow({ where: { id: root.id } })).toMatchObject({ parentId: null, version: 1 });

    // A legal move works: grandchild to the root level, then back under the root.
    expect(await moveCategory({ id: grand.id, parentId: null, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true, value: { parentId: null, version: 2 } });
    expect(await moveCategory({ id: grand.id, parentId: root.id, expectedVersion: 2 }, a.as("stock"))).toMatchObject({ ok: true, value: { parentId: root.id } });
  });

  it("limits the tree to depth 4, counting the moved subtree", async () => {
    const { a } = await world();
    const l1 = await cat(a, "م1");
    const l2 = await cat(a, "م2", l1.id);
    const l3 = await cat(a, "م3", l2.id);
    const l4 = await cat(a, "م4", l3.id);
    expect(await createCategory({ nameAr: "م5", parentId: l4.id }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });

    // A second tree of depth 2 cannot be hung under l3 (it would reach depth 5), but fits under l2.
    const r1 = await cat(a, "ج1");
    await cat(a, "ج2", r1.id);
    expect(await moveCategory({ id: r1.id, parentId: l3.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await moveCategory({ id: r1.id, parentId: l2.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
  });

  it("refuses duplicate sibling names (normalized) but allows the same name under another parent", async () => {
    const { a } = await world();
    const p1 = await cat(a, "أ");
    const p2 = await cat(a, "ب");
    const first = await cat(a, "إلكترونيات", p1.id);
    expect(await createCategory({ nameAr: "الكترونيات", parentId: p1.id }, a.as("stock"))).toMatchObject({ ok: false, code: "DUPLICATE_NAME" });
    expect(await createCategory({ nameAr: "إلكترونيات", parentId: p2.id }, a.as("stock"))).toMatchObject({ ok: true });
    const other = await cat(a, "ملابس", p1.id);
    expect(await renameCategory({ id: other.id, nameAr: " الكترونيات ", expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "DUPLICATE_NAME" });
    // Renaming to its own normalized name is fine; moving into a parent that has the name is not.
    expect(await renameCategory({ id: first.id, nameAr: "الكترونيات", expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
    const moved = await cat(a, "الكترونيات");
    expect(await moveCategory({ id: moved.id, parentId: p1.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "DUPLICATE_NAME" });
  });

  it("archiving a category with active children is refused", async () => {
    const { a } = await world();
    const parent = await cat(a, "الأب");
    const child = await cat(a, "الابن", parent.id);
    expect(await archiveCategory({ id: parent.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "CATEGORY_IN_USE" });

    // Active products block it too.
    const product = await db.rtProduct.create({ data: { businessId: a.business.id, nameAr: "منتج", categoryId: child.id } });
    expect(await archiveCategory({ id: child.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "CATEGORY_IN_USE" });
    await db.rtProduct.update({ where: { id: product.id }, data: { archivedAt: new Date() } });

    expect(await archiveCategory({ id: child.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await archiveCategory({ id: parent.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });

    // Archived rows are hidden unless asked for, and cannot be a parent.
    expect(await listCategories({}, a.as("cashier"))).toMatchObject({ ok: true, value: [] });
    const all = await listCategories({ includeArchived: true }, a.as("cashier"));
    expect(all.ok && all.value.map((c) => c.id).sort()).toEqual([child.id, parent.id].sort());
    expect(await createCategory({ nameAr: "تحت المؤرشف", parentId: parent.id }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    // The name of an archived category can be reused.
    expect(await createCategory({ nameAr: "الأب" }, a.as("stock"))).toMatchObject({ ok: true });
  });

  it("a stale version gives VERSION_CONFLICT", async () => {
    const { a } = await world();
    const c = await cat(a, "قسم");
    expect(await renameCategory({ id: c.id, nameAr: "جديد", expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await renameCategory({ id: c.id, nameAr: "آخر", expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(await moveCategory({ id: c.id, parentId: null, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(await archiveCategory({ id: c.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    const b = await createBrand({ nameAr: "علامة" }, a.as("stock"));
    if (!b.ok) throw new Error("brand");
    expect(await renameBrand({ id: b.value.id, nameAr: "ن", expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await renameBrand({ id: b.value.id, nameAr: "م", expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(await archiveBrand({ id: b.value.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect((await db.rtCategory.findUniqueOrThrow({ where: { id: c.id } })).nameAr).toBe("جديد");
  });

  it("another business never sees or edits these rows", async () => {
    const { a, b } = await world();
    const c = await cat(a, "قسم أ");
    const br = await createBrand({ nameAr: "علامة أ" }, a.as("stock"));
    if (!br.ok) throw new Error("brand");

    expect(await listCategories({ includeArchived: true }, b.as("owner"))).toMatchObject({ ok: true, value: [] });
    expect(await listBrands({ includeArchived: true }, b.as("owner"))).toMatchObject({ ok: true, value: [] });
    expect(await renameCategory({ id: c.id, nameAr: "مسروق", expectedVersion: 1 }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await moveCategory({ id: c.id, parentId: null, expectedVersion: 1 }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await archiveCategory({ id: c.id, expectedVersion: 1 }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await createCategory({ nameAr: "تحت قسم غيري", parentId: c.id }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await renameBrand({ id: br.value.id, nameAr: "مسروق", expectedVersion: 1 }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await archiveBrand({ id: br.value.id, expectedVersion: 1 }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    // Not a member of A at all.
    expect(await listCategories({}, { ...b.as("owner"), businessId: a.business.id })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    // The same name is free in B.
    expect(await createCategory({ nameAr: "قسم أ" }, b.as("owner"))).toMatchObject({ ok: true });
    expect(await db.rtCategory.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ nameAr: "قسم أ", archivedAt: null, version: 1 });
  });

  it("every write is refused in READ_ONLY, reads still work", async () => {
    const { a } = await world();
    const c = await cat(a, "قسم");
    const br = await createBrand({ nameAr: "علامة" }, a.as("stock"));
    if (!br.ok) throw new Error("brand");
    await db.rtBusiness.update({ where: { id: a.business.id }, data: { status: "SUSPENDED" } });

    const results = [
      await createCategory({ nameAr: "جديد" }, a.as("stock")),
      await renameCategory({ id: c.id, nameAr: "ن", expectedVersion: 1 }, a.as("stock")),
      await moveCategory({ id: c.id, parentId: null, expectedVersion: 1 }, a.as("stock")),
      await archiveCategory({ id: c.id, expectedVersion: 1 }, a.as("stock")),
      await createBrand({ nameAr: "جديدة" }, a.as("stock")),
      await renameBrand({ id: br.value.id, nameAr: "ن", expectedVersion: 1 }, a.as("stock")),
      await archiveBrand({ id: br.value.id, expectedVersion: 1 }, a.as("stock")),
    ];
    for (const r of results) expect(r).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await listCategories({}, a.as("stock"))).toMatchObject({ ok: true });
    expect(await listBrands({}, a.as("stock"))).toMatchObject({ ok: true });
    expect(await db.rtCategory.count({ where: { businessId: a.business.id } })).toBe(1);
  });

  it("the same idempotency key does not create twice", async () => {
    const { a } = await world();
    const k = key();
    const first = await createCategory({ nameAr: "مرة واحدة" }, a.as("stock", k));
    const second = await createCategory({ nameAr: "مرة واحدة" }, a.as("stock", k));
    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual(first);
    expect(await db.rtCategory.count({ where: { businessId: a.business.id } })).toBe(1);
    expect(await createCategory({ nameAr: "اسم آخر" }, a.as("stock", k))).toMatchObject({ ok: false, code: "IDEMPOTENCY_MISMATCH" });

    const kb = key();
    expect(await createBrand({ nameAr: "علامة" }, a.as("stock", kb))).toMatchObject({ ok: true });
    expect(await createBrand({ nameAr: "علامة" }, a.as("stock", kb))).toMatchObject({ ok: true });
    expect(await db.rtBrand.count({ where: { businessId: a.business.id } })).toBe(1);
  });
});

describe("brands", () => {
  it("creates, renames and archives; names are unique per business after normalization", async () => {
    const { a } = await world();
    expect(await createBrand({ nameAr: "المراعي" }, a.as("cashier"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const created = await createBrand({ nameAr: "المراعي", nameEn: "Almarai" }, a.as("stock"));
    expect(created).toMatchObject({ ok: true, value: { nameAr: "المراعي", nameEn: "Almarai", nameCkb: null, version: 1 } });
    if (!created.ok) return;
    const id = created.value.id;
    expect(await createBrand({ nameAr: " المراعي " }, a.as("stock"))).toMatchObject({ ok: false, code: "DUPLICATE_NAME" });
    const other = await createBrand({ nameAr: "نادك" }, a.as("stock"));
    if (!other.ok) return;
    // yeh/alef maksura fold together, so this is the same name.
    expect(await renameBrand({ id: other.value.id, nameAr: "المراعى", expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "DUPLICATE_NAME" });
    expect(await renameBrand({ id: other.value.id, nameAr: "نادك الجديدة", expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });

    expect(await archiveBrand({ id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
    const visible = await listBrands({}, a.as("cashier"));
    expect(visible.ok && visible.value.map((x) => x.id)).toEqual([other.value.id]);
    const all = await listBrands({ includeArchived: true }, a.as("cashier"));
    expect(all.ok && all.value).toHaveLength(2);
    // The name of an archived brand is free again.
    expect(await createBrand({ nameAr: "المراعي" }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await db.rtAuditLog.count({ where: { businessId: a.business.id, action: { startsWith: "catalog.brand" } } })).toBe(5);
  });
});

describe("taxonomy hardening", () => {
  it("owner and manager can write; a cashier is refused on every write", async () => {
    const { a } = await world();
    expect(await createCategory({ nameAr: "للمالك" }, a.as("owner"))).toMatchObject({ ok: true });
    const m = await createCategory({ nameAr: "للمدير" }, a.as("manager"));
    expect(m).toMatchObject({ ok: true });
    expect(await createBrand({ nameAr: "علامة المدير" }, a.as("manager"))).toMatchObject({ ok: true });
    const c = await cat(a, "قسم");
    const br = await createBrand({ nameAr: "علامة" }, a.as("stock"));
    if (!br.ok) throw new Error("brand");
    const refused = [
      await moveCategory({ id: c.id, parentId: null, expectedVersion: 1 }, a.as("cashier")),
      await archiveCategory({ id: c.id, expectedVersion: 1 }, a.as("cashier")),
      await createBrand({ nameAr: "x" }, a.as("cashier")),
      await renameBrand({ id: br.value.id, nameAr: "x", expectedVersion: 1 }, a.as("cashier")),
      await archiveBrand({ id: br.value.id, expectedVersion: 1 }, a.as("cashier")),
    ];
    for (const r of refused) expect(r).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await db.rtCategory.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ archivedAt: null, version: 1 });
  });

  it("a CLOSED business refuses writes and reads", async () => {
    const { a } = await world();
    await db.rtBusiness.update({ where: { id: a.business.id }, data: { status: "ARCHIVED" } });
    expect(await createCategory({ nameAr: "x" }, a.as("stock"))).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await listCategories({}, a.as("stock"))).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await listBrands({}, a.as("stock"))).toMatchObject({ ok: false, code: "READ_ONLY" });
  });

  it("a refused rename or move leaves the row unchanged", async () => {
    const { a } = await world();
    const p = await cat(a, "أب");
    await cat(a, "اسم", p.id);
    const other = await cat(a, "اسم");
    expect(await renameCategory({ id: other.id, nameAr: "غيره", expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
    const dup = await cat(a, "اسم آخر", p.id);
    expect(await renameCategory({ id: dup.id, nameAr: "اسم", nameEn: "changed", expectedVersion: 1 }, a.as("stock"))).toMatchObject({ code: "DUPLICATE_NAME" });
    expect(await db.rtCategory.findUniqueOrThrow({ where: { id: dup.id } })).toMatchObject({ nameAr: "اسم آخر", nameEn: null, version: 1, parentId: p.id });
    const root = await cat(a, "اسم آخر");
    expect(await moveCategory({ id: root.id, parentId: p.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ code: "DUPLICATE_NAME" });
    expect(await db.rtCategory.findUniqueOrThrow({ where: { id: root.id } })).toMatchObject({ parentId: null, version: 1 });
  });

  it("rejects names that normalize to nothing", async () => {
    const { a } = await world();
    expect(await createCategory({ nameAr: "ـــ" }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await createBrand({ nameAr: "ـ ـ" }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await createBrand({ nameAr: "علامة", nameEn: "ـ" }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("a corrupted tree (cycle in the data) is refused, never an endless loop", async () => {
    const { a } = await world();
    const x = await cat(a, "س");
    const y = await cat(a, "ص", x.id);
    await db.rtCategory.update({ where: { id: x.id }, data: { parentId: y.id } });
    const z = await cat(a, "ع");
    expect(await moveCategory({ id: x.id, parentId: z.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await moveCategory({ id: z.id, parentId: y.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("concurrent opposite moves: exactly one succeeds and no cycle forms", async () => {
    const { a } = await world();
    for (let round = 0; round < 4; round += 1) {
      const x = await cat(a, `س${round}`);
      const y = await cat(a, `ص${round}`);
      const r = await Promise.all([
        moveCategory({ id: x.id, parentId: y.id, expectedVersion: 1 }, a.as("stock")),
        moveCategory({ id: y.id, parentId: x.id, expectedVersion: 1 }, a.as("manager")),
      ]);
      expect(r.filter((v) => v.ok)).toHaveLength(1);
      expect(r.filter((v) => !v.ok)).toHaveLength(1);
      const rows = await db.rtCategory.findMany({ where: { businessId: a.business.id } });
      expect(rows.filter((c) => c.parentId !== null)).toHaveLength(round + 1);
    }
  });

  it("concurrent same-name creates produce one row", async () => {
    const { a } = await world();
    for (let round = 0; round < 4; round += 1) {
      const r = await Promise.all([
        createCategory({ nameAr: `واحد${round}` }, a.as("stock")),
        createCategory({ nameAr: ` واحد${round}` }, a.as("manager")),
        createBrand({ nameAr: `علامة${round}` }, a.as("stock")),
        createBrand({ nameAr: `علامة${round}` }, a.as("manager")),
      ]);
      expect(r.filter((v) => v.ok)).toHaveLength(2);
      expect(await db.rtCategory.count({ where: { businessId: a.business.id } })).toBe(round + 1);
      expect(await db.rtBrand.count({ where: { businessId: a.business.id } })).toBe(round + 1);
    }
  });

  it("concurrent writes that together reach depth 5: one is refused", async () => {
    const { a } = await world();
    for (let round = 0; round < 4; round += 1) {
      const l1 = await cat(a, `م1${round}`);
      const l2 = await cat(a, "م2", l1.id);
      const l3 = await cat(a, "م3", l2.id);
      const lone = await cat(a, `منفرد${round}`);
      const r = await Promise.all([
        moveCategory({ id: lone.id, parentId: l3.id, expectedVersion: 1 }, a.as("stock")),
        createCategory({ nameAr: "تحت", parentId: lone.id }, a.as("manager")),
      ]);
      expect(r.filter((v) => v.ok)).toHaveLength(1);
      expect(r.find((v) => !v.ok)).toMatchObject({ code: "INVALID_INPUT" });
      const rows = await db.rtCategory.findMany({ where: { businessId: a.business.id } });
      const byId = new Map(rows.map((c) => [c.id, c]));
      const depth = (id: string): number => 1 + (byId.get(id)!.parentId ? depth(byId.get(id)!.parentId!) : 0);
      expect(Math.max(...rows.map((c) => depth(c.id)))).toBeLessThanOrEqual(4);
    }
  });
});
