import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCategory } from "@/server/catalog/taxonomy";
import {
  addBarcode,
  addUnit,
  addVariant,
  archiveBarcode,
  archiveProduct,
  archiveUnit,
  archiveVariant,
  createProduct,
  updateProduct,
} from "@/server/catalog/products";
import { setPrice } from "@/server/catalog/prices";
import { searchCatalog } from "@/server/catalog/search";
import { normalizeSearchText } from "@/server/domain/catalog";
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
      { key: "stock", role: "STOCK", branches: ["A"] },
      { key: "cashier", role: "CASHIER", branches: ["A"] },
    ],
  });
  await db.rtBusiness.update({ where: { id: w.business.id }, data: { status: "ACTIVE", name: label, enabledCurrencies: ["IQD", "USD"] } });
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
type Shop = Awaited<ReturnType<typeof business>>;

async function world() {
  await createPlan(db, { maxBranches: 3 });
  return { a: await business("A shop"), b: await business("B shop") };
}

const piece = (barcodes: string[] = []) => ({ name: "حبة", barcodes });

async function product(w: Shop, input: Record<string, unknown>) {
  const r = await createProduct({ baseUnit: piece(), ...input }, w.as(input.price || input.extraUnits ? "owner" : "stock"));
  if (!r.ok) throw new Error(`createProduct failed: ${r.code}`);
  return r.value;
}

async function search(w: Shop, input: Record<string, unknown>, who = "cashier") {
  const r = await searchCatalog({ ...input }, w.as(who));
  if (!r.ok) throw new Error(`searchCatalog failed: ${r.code}`);
  return r.value;
}

const names = async (w: Shop, query: string, extra: Record<string, unknown> = {}) =>
  (await search(w, { query, ...extra })).items.map((i) => i.nameAr);

describe("catalog search", () => {
  it("a barcode scan returns the unit that owns it first", async () => {
    const { a } = await world();
    // A product whose NAME is the digits sorts/matches by text too; the scan must still win.
    await product(a, { nameAr: "عصير 6281000", sku: "TXT-1" });
    const p = await product(a, { nameAr: "حليب", baseUnit: piece(["6281000111"]), extraUnits: [{ name: "كرتون", factor: 12, barcodes: ["6281000222"] }] });
    const carton = await db.rtUnit.findFirstOrThrow({ where: { variantId: p.variantId, isBase: false } });

    const r = await search(a, { query: "6281000222" });
    expect(r.items[0]).toMatchObject({
      productId: p.productId,
      variantId: p.variantId,
      unitId: carton.id,
      nameAr: "حليب",
      sku: p.sku,
      matchedBarcode: "6281000222",
      matchedUnitName: "كرتون",
    });
    // Arabic-Indic digits scan the same code.
    expect((await search(a, { query: "٦٢٨١٠٠٠١١١" })).items[0]).toMatchObject({ unitId: p.baseUnitId, matchedBarcode: "6281000111" });
  });

  it("Arabic spelling variants and Arabic digits find the same product", async () => {
    const { a } = await world();
    const p = await product(a, { nameAr: "مدرسة أحمد ٣٠٠ ملم" });
    const variants = ["احمد", "أحمد", "إحمد", "مدرسه", "مدرسة", "٣٠٠", "300", "مَدْرَسَةُ", "مـدرســة", "أحـمد 300"];
    for (const q of variants) expect((await search(a, { query: q })).items.map((i) => i.productId), q).toEqual([p.productId]);

    const persian = await product(a, { nameAr: "كتاب علي" });
    for (const q of ["كتاب", "کتاب", "عَلی", "علي"]) expect((await search(a, { query: q })).items.map((i) => i.productId), q).toEqual([persian.productId]);
    // Stored with Persian letters, found with Arabic ones.
    const stored = await product(a, { nameAr: "کتاب ایران" });
    expect((await search(a, { query: "كتاب ايران" })).items.map((i) => i.productId)).toEqual([stored.productId]);
  });

  it("a partial name finds products in any language", async () => {
    const { a } = await world();
    const p = await product(a, { nameAr: "عصير برتقال", nameCkb: "شەربەتی پرتەقاڵ", nameEn: "Orange Juice" });
    await product(a, { nameAr: "ماء" });
    for (const q of ["برتق", "orange", "ORANGE ju", "juice", "شەربەت"]) {
      expect((await search(a, { query: q })).items.map((i) => i.productId), q).toEqual([p.productId]);
    }
    expect((await search(a, { query: "orange" })).items[0]).toMatchObject({ nameAr: "عصير برتقال", nameCkb: "شەربەتی پرتەقاڵ", nameEn: "Orange Juice" });
  });

  it("multiple tokens must all match", async () => {
    const { a } = await world();
    await product(a, { nameAr: "قميص أزرق" });
    await product(a, { nameAr: "قميص أحمر" });
    await product(a, { nameAr: "بنطال أزرق" });
    expect(await names(a, "قميص أزرق")).toEqual(["قميص أزرق"]);
    expect(await names(a, "ازرق قميص")).toEqual(["قميص أزرق"]);
    expect((await names(a, "قميص")).sort()).toEqual(["قميص أحمر", "قميص أزرق"].sort());
    expect(await names(a, "قميص اخضر")).toEqual([]);
  });

  it("an exact SKU comes before name matches, case-insensitively, and LIKE characters in a SKU stay literal", async () => {
    const { a } = await world();
    await product(a, { nameAr: "اسم يحتوي ab-1 داخله", sku: "ZZ-9" });
    const p = await product(a, { nameAr: "منتج", sku: "AB-1" });
    const r = await search(a, { query: "ab-1" });
    expect(r.items.map((i) => i.productId)[0]).toBe(p.productId);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.matchedBarcode).toBeUndefined();

    await product(a, { nameAr: "تحت", sku: "A_1" });
    await product(a, { nameAr: "فوق", sku: "AB1" });
    await product(a, { nameAr: "نسبة 5% خصم" });
    await product(a, { nameAr: "اي شيء", sku: "AXY1" });
    // "a_1" is not "a?1": the SKU tier finds A_1 only, and AB1 does not match at all.
    expect((await search(a, { query: "a_1" })).items.map((i) => i.sku)).toEqual(["A_1"]);
    expect((await search(a, { query: "A%1" })).items).toEqual([]);
    expect((await names(a, "%"))).toEqual(["نسبة 5% خصم"]);
  });

  it("an exact SKU written with Arabic or Persian letters and digits hits the exact tier first", async () => {
    const { a } = await world();
    const biz = a.business.id;
    const mk = async (nameAr: string, sku: string) => {
      const pid = randomUUID();
      const text = normalizeSearchText(`${nameAr} ${sku}`);
      await db.rtProduct.create({ data: { id: pid, businessId: biz, nameAr, searchText: text } });
      const v = await db.rtVariant.create({ data: { businessId: biz, productId: pid, sku, searchText: text } });
      await db.rtUnit.create({ data: { businessId: biz, variantId: v.id, name: "حبة", factor: 1, isBase: true } });
      return v.id;
    };
    const owner = await mk("منتج", "کد١"); // Persian kaf, Arabic-Indic digit
    for (const q of ["كد1", "کد١", "كد١"]) {
      expect((await search(a, { query: q })).items.map((i) => i.variantId), q).toEqual([owner]);
    }
    await mk("أأ ب كد1 اسم", "PLAIN-2"); // sorts before the owner by name and also matches as text
    const two = await search(a, { query: "كد1" });
    expect(two.items).toHaveLength(2);
    expect(two.items[0]!.variantId).toBe(owner);
  });

  it("archived products are hidden unless asked", async () => {
    const { a } = await world();
    const p = await product(a, { nameAr: "منتج قديم", baseUnit: piece(["777"]) });
    await product(a, { nameAr: "منتج جديد" });
    await archiveProduct({ id: p.productId, expectedVersion: 1 }, a.as("stock"));
    expect(await names(a, "منتج")).toEqual(["منتج جديد"]);
    expect(await names(a, "777")).toEqual([]);
    expect(await names(a, "")).toEqual(["منتج جديد"]);
    expect((await names(a, "منتج", { includeArchived: true })).sort()).toEqual(["منتج جديد", "منتج قديم"].sort());
    expect(await names(a, "777", { includeArchived: true })).toEqual(["منتج قديم"]);
  });

  it("another business never appears", async () => {
    const { a, b } = await world();
    await product(a, { nameAr: "سكر", sku: "SHARED-1", baseUnit: piece(["4001"]) });
    await product(b, { nameAr: "سكر ب", sku: "SHARED-1", baseUnit: piece(["4001"]) });
    expect(await names(a, "سكر")).toEqual(["سكر"]);
    expect(await names(b, "سكر")).toEqual(["سكر ب"]);
    expect(await names(a, "4001")).toEqual(["سكر"]);
    expect(await names(b, "shared-1")).toEqual(["سكر ب"]);
    expect(await names(a, "")).toEqual(["سكر"]);
  });

  it("a leading-zero barcode matches only with its zeros", async () => {
    const { a } = await world();
    const withZeros = await product(a, { nameAr: "بزيرو", baseUnit: piece(["0012345"]) });
    const r = await search(a, { query: "12345" });
    // The exact tier does not fire for 12345 ...
    expect(r.items.every((i) => i.matchedBarcode === undefined)).toBe(true);
    // ... and with the zeros it does.
    expect((await search(a, { query: "0012345" })).items[0]).toMatchObject({ productId: withZeros.productId, matchedBarcode: "0012345" });
    const plain = await product(a, { nameAr: "بدون", baseUnit: piece(["12345"]) });
    const both = await search(a, { query: "12345" });
    expect(both.items[0]).toMatchObject({ productId: plain.productId, matchedBarcode: "12345" });
    expect((await search(a, { query: "0012345" })).items[0]).toMatchObject({ productId: withZeros.productId });
    expect((await search(a, { query: "٠٠١٢٣٤٥" })).items[0]).toMatchObject({ productId: withZeros.productId });
  });

  it("LIKE wildcards in the query are literal", async () => {
    const { a } = await world();
    await product(a, { nameAr: "خصم 50% اليوم" });
    await product(a, { nameAr: "خصم 500 اليوم" });
    await product(a, { nameAr: "اسم_واحد" });
    await product(a, { nameAr: "اسمXواحد" });
    await product(a, { nameAr: "مسار a\\b" });
    await product(a, { nameAr: "مسار aXb" });
    expect(await names(a, "50%")).toEqual(["خصم 50% اليوم"]);
    expect(await names(a, "%")).toEqual(["خصم 50% اليوم"]);
    expect(await names(a, "_")).toEqual(["اسم_واحد"]);
    expect(await names(a, "اسم_واحد")).toEqual(["اسم_واحد"]);
    expect(await names(a, "a\\b")).toEqual(["مسار a\\b"]);
    expect(await names(a, "\\")).toEqual(["مسار a\\b"]);
    expect(await names(a, "%%")).toEqual([]);
  });

  it("empty query browses with filters, ordered by name", async () => {
    const { a } = await world();
    const cat = await createCategory({ nameAr: "مشروبات" }, a.as("stock"));
    if (!cat.ok) throw new Error("cat");
    await product(a, { nameAr: "ب", categoryId: cat.value.id });
    await product(a, { nameAr: "أ", categoryId: cat.value.id });
    await product(a, { nameAr: "ج" });
    expect((await names(a, "   ")).length).toBe(3);
    expect(await names(a, "", { categoryId: cat.value.id })).toEqual(["أ", "ب"]);
    expect(await names(a, "ب", { categoryId: cat.value.id })).toEqual(["ب"]);
    expect(await names(a, "ج", { categoryId: cat.value.id })).toEqual([]);
  });

  it("rejects over-long queries, bad limits and bad cursors", async () => {
    const { a } = await world();
    await product(a, { nameAr: "صنف" });
    const bad = async (input: Record<string, unknown>) => (await searchCatalog(input, a.as("cashier")))
    expect(await bad({ query: "x".repeat(101) })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await bad({ query: "x".repeat(100) })).toMatchObject({ ok: true });
    expect(await bad({ query: "", limit: 51 })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await bad({ query: "", limit: 0 })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await bad({ query: "", limit: 50 })).toMatchObject({ ok: true });
    expect(await bad({ query: "", cursor: "garbage" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await bad({ query: "", cursor: Buffer.from('{"a":1}').toString("base64url") })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await bad({ query: 5 })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("a cashier can search (also SUSPENDED); an ARCHIVED (CLOSED) business refuses", async () => {
    const { a } = await world();
    await product(a, { nameAr: "صنف" });
    expect(await searchCatalog({ query: "صنف" }, a.as("cashier"))).toMatchObject({ ok: true });
    await db.rtBusiness.update({ where: { id: a.business.id }, data: { status: "SUSPENDED" } });
    expect(await searchCatalog({ query: "صنف" }, a.as("cashier"))).toMatchObject({ ok: true });
    await db.rtBusiness.update({ where: { id: a.business.id }, data: { status: "ARCHIVED" } });
    expect(await searchCatalog({ query: "صنف" }, a.as("cashier"))).toMatchObject({ ok: false, code: "READ_ONLY" });
  });

  it("an archived unit is not matched by its barcodes, which stay active", async () => {
    const { a } = await world();
    const p = await product(a, { nameAr: "صنف", extraUnits: [{ name: "كرتون", factor: 6, barcodes: ["424242"] }] });
    const carton = await db.rtUnit.findFirstOrThrow({ where: { variantId: p.variantId, isBase: false } });
    expect((await search(a, { query: "424242" })).items[0]).toMatchObject({ unitId: carton.id, matchedBarcode: "424242" });
    const r = await archiveUnit({ id: carton.id, expectedVersion: 1 }, a.as("owner"));
    expect(r.ok).toBe(true);
    expect(await db.rtBarcode.count({ where: { code: "424242", archivedAt: null } })).toBe(1);
    expect(await names(a, "424242")).toEqual([]);
    expect(await names(a, "424242", { includeArchived: true })).toEqual([]);
    expect(await names(a, "صنف")).toEqual(["صنف"]);
  });

  it("each hit carries the unit's current DEFAULT price in the business currency", async () => {
    const { a } = await world();
    await db.rtBusiness.update({ where: { id: a.business.id }, data: { defaultCurrency: "IQD" } });
    const p = await product(a, { nameAr: "سلعة", price: { currency: "IQD", amountMinor: 1500n }, extraUnits: [{ name: "كرتون", factor: 12, barcodes: ["9090"] }] });
    await product(a, { nameAr: "بلا سعر" });
    const q = await search(a, { query: "سلعة" });
    expect(q.items[0]).toMatchObject({ productId: p.productId, unitId: p.baseUnitId, unitPrice: { currency: "IQD", amountMinor: 1500n } });
    // A carton scan shows the carton's own price (12 x 1500).
    expect((await search(a, { query: "9090" })).items[0]!.unitPrice).toEqual({ currency: "IQD", amountMinor: 18000n });
    expect((await search(a, { query: "بلا سعر" })).items[0]!.unitPrice).toBeUndefined();

    // Default currency has no price, another currency has: that one is used.
    const usd = await product(a, { nameAr: "دولاري", price: { currency: "USD", amountMinor: 250n } });
    expect((await search(a, { query: "دولاري" })).items[0]).toMatchObject({ productId: usd.productId, unitPrice: { currency: "USD", amountMinor: 250n } });
    // setPrice changes what search shows.
    const list = await db.rtPriceList.findFirstOrThrow({ where: { businessId: a.business.id, kind: "DEFAULT" } });
    const ch = await setPrice({ unitId: p.baseUnitId, priceListId: list.id, currency: "IQD", amountMinor: 2000n }, a.as("owner"));
    expect(ch.ok).toBe(true);
    expect((await search(a, { query: "سلعة" })).items[0]!.unitPrice).toEqual({ currency: "IQD", amountMinor: 2000n });
  });

  describe("searchText follows the catalog actions", () => {
    it("rename: found by the new name, not the old", async () => {
      const { a } = await world();
      const p = await product(a, { nameAr: "اسم قديم", nameEn: "Old name" });
      const r = await updateProduct({ id: p.productId, expectedVersion: 1, nameAr: "اسم جديد", nameEn: "New name" }, a.as("stock"));
      expect(r.ok).toBe(true);
      expect(await names(a, "جديد")).toEqual(["اسم جديد"]);
      expect(await names(a, "new name")).toEqual(["اسم جديد"]);
      expect(await names(a, "قديم")).toEqual([]);
      expect(await names(a, "old")).toEqual([]);
    });

    it("addBarcode and archiveBarcode", async () => {
      const { a } = await world();
      const p = await product(a, { nameAr: "صنف" });
      expect(await names(a, "5551234")).toEqual([]);
      const added = await addBarcode({ unitId: p.baseUnitId, code: "5551234" }, a.as("stock"));
      if (!added.ok) throw new Error("addBarcode");
      expect((await search(a, { query: "5551234" })).items[0]).toMatchObject({ productId: p.productId, matchedBarcode: "5551234" });
      const archived = await archiveBarcode({ id: added.value.id, expectedVersion: added.value.version }, a.as("stock"));
      expect(archived.ok).toBe(true);
      expect(await names(a, "5551234")).toEqual([]);
    });

    it("archiveVariant: its SKU no longer matches; the other variant still does", async () => {
      const { a } = await world();
      const p = await product(a, { nameAr: "قميص", sku: "SH-M", options: { size: "M" } });
      const v2 = await addVariant({ productId: p.productId, sku: "SH-L", options: { size: "L" }, baseUnit: piece(["888"]) }, a.as("stock"));
      if (!v2.ok) throw new Error("addVariant");
      expect((await search(a, { query: "sh-l" })).items.map((i) => i.variantId)).toEqual([v2.value.variantId]);
      expect((await search(a, { query: "قميص" })).items).toHaveLength(2);
      const arch = await archiveVariant({ variantId: v2.value.variantId, expectedVersion: 1 }, a.as("stock"));
      expect(arch.ok).toBe(true);
      expect(await names(a, "sh-l")).toEqual([]);
      expect(await names(a, "888")).toEqual([]);
      expect((await search(a, { query: "قميص" })).items.map((i) => i.variantId)).toEqual([p.variantId]);
      expect((await search(a, { query: "sh-l", includeArchived: true })).items.map((i) => i.variantId)).toEqual([v2.value.variantId]);
    });

    it("a variant option value finds the variant", async () => {
      const { a } = await world();
      const p = await product(a, { nameAr: "حذاء", options: { اللون: "أزرق" } });
      const v2 = await addVariant({ productId: p.productId, options: { اللون: "أحمر" }, baseUnit: piece() }, a.as("stock"));
      if (!v2.ok) throw new Error("addVariant");
      expect((await search(a, { query: "حذاء ازرق" })).items.map((i) => i.variantId)).toEqual([p.variantId]);
      expect((await search(a, { query: "حذاء احمر" })).items.map((i) => i.variantId)).toEqual([v2.value.variantId]);
    });

    it("a new unit's barcode finds the unit", async () => {
      const { a } = await world();
      const p = await product(a, { nameAr: "ماء" });
      const u = await addUnit({ variantId: p.variantId, name: "علبة", factor: 6, barcodes: ["31337"] }, a.as("stock"));
      if (!u.ok) throw new Error("addUnit");
      expect((await search(a, { query: "31337" })).items[0]).toMatchObject({ unitId: u.value.id, matchedUnitName: "علبة" });
    });
  });

  describe("paging", () => {
    it("results are paged and the cursor walks all 1500 seeded products without gaps or repeats", async () => {
      const { a } = await world();
      const biz = a.business.id;
      const N = 1500;
      const rows = Array.from({ length: N }, (_, i) => {
        const nameAr = `صنف ${i % 100}`; // many products share a name: the id breaks ties
        return { id: randomUUID(), nameAr, sku: `S${String(i).padStart(5, "0")}` };
      });
      await db.rtProduct.createMany({ data: rows.map((r) => ({ id: r.id, businessId: biz, nameAr: r.nameAr, searchText: normalizeSearchText(`${r.nameAr} ${r.sku}`) })) });
      const vIds = rows.map(() => randomUUID());
      await db.rtVariant.createMany({
        data: rows.map((r, i) => ({ id: vIds[i]!, businessId: biz, productId: r.id, sku: r.sku, searchText: normalizeSearchText(`${r.nameAr} ${r.sku}`) })),
      });
      await db.rtUnit.createMany({ data: rows.map((_, i) => ({ businessId: biz, variantId: vIds[i]!, name: "حبة", factor: 1, isBase: true })) });

      const walk = async (input: Record<string, unknown>, limit: number) => {
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const r = await search(a, { ...input, limit, ...(cursor ? { cursor } : {}) });
          expect(r.items.length).toBeLessThanOrEqual(limit);
          seen.push(...r.items.map((i) => i.variantId));
          cursor = r.nextCursor;
          pages += 1;
          if (cursor) expect(r.items).toHaveLength(limit);
        } while (cursor);
        return { seen, pages };
      };

      const text = await walk({ query: "صنف" }, 50);
      expect(text.pages).toBe(30);
      expect(new Set(text.seen).size).toBe(N);
      expect(text.seen).toHaveLength(N);
      expect(new Set(text.seen)).toEqual(new Set(vIds));

      const browse = await walk({ query: "" }, 37);
      expect(browse.seen).toHaveLength(N);
      expect(new Set(browse.seen).size).toBe(N);

      // The order is stable: the same walk gives the same sequence.
      expect((await walk({ query: "صنف" }, 50)).seen).toEqual(text.seen);
      // A narrower token set pages too.
      const narrow = await walk({ query: "صنف 7" }, 20);
      expect(new Set(narrow.seen).size).toBe(narrow.seen.length);
      expect(narrow.seen.length).toBe(rows.filter((r) => normalizeSearchText(r.nameAr).includes("صنف") && normalizeSearchText(`${r.nameAr} ${r.sku}`).includes("7")).length);

      // The exact-barcode / SKU hit stays first on page 1 and is not repeated later.
      const exact = await walk({ query: "s00042" }, 1);
      expect(exact.seen[0]).toBe(vIds[42]);
      expect(new Set(exact.seen).size).toBe(exact.seen.length);
    }, 120_000);

    it("the cursor survives a 200-character Arabic name as the last row of a page", async () => {
      const { a } = await world();
      const long = "ع".repeat(200);
      await product(a, { nameAr: "أ قصير" });
      await product(a, { nameAr: long });
      await product(a, { nameAr: "ي قصير" });
      const first = await search(a, { query: "", limit: 2 });
      expect(first.items.map((i) => i.nameAr)).toEqual(["أ قصير", long]);
      expect(first.nextCursor).not.toBeNull();
      expect(first.nextCursor!.length).toBeGreaterThan(500);
      expect(first.nextCursor!.length).toBeLessThanOrEqual(2048);
      const second = await search(a, { query: "", limit: 2, cursor: first.nextCursor });
      expect(second.items.map((i) => i.nameAr)).toEqual(["ي قصير"]);
      expect(second.nextCursor).toBeNull();
      // Still strictly validated: unknown keys, wrong types and oversize are refused.
      const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
      for (const c of [enc({ a: "x", i: "y", extra: 1 }), enc({ s: -1 }), enc({ a: 5, i: "y" }), "A".repeat(2049)]) {
        expect(await searchCatalog({ query: "", cursor: c }, a.as("cashier"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
      }
    });

    it("the exact-hit cursor walks barcode, SKU, then text hits one by one without repeats", async () => {
      const { a } = await world();
      // Query "7001": barcode of p1, SKU of p2, name text of p3 and p4.
      const p1 = await product(a, { nameAr: "ز باركود", baseUnit: piece(["7001"]) });
      const p2 = await product(a, { nameAr: "ي سكو", sku: "7001" });
      const p3 = await product(a, { nameAr: "أ نص 7001" });
      const p4 = await product(a, { nameAr: "ب نص 7001" });
      const seen: string[] = [];
      const cursors: unknown[] = [];
      let cursor: string | null = null;
      do {
        const r = await search(a, { query: "7001", limit: 1, ...(cursor ? { cursor } : {}) });
        expect(r.items).toHaveLength(1);
        seen.push(r.items[0]!.productId);
        cursor = r.nextCursor;
        if (cursor) cursors.push(JSON.parse(Buffer.from(cursor, "base64url").toString()));
      } while (cursor);
      expect(seen).toEqual([p1.productId, p2.productId, p3.productId, p4.productId]);
      expect(cursors.slice(0, 2)).toEqual([{ s: 1 }, { s: 2 }]);
      expect(cursors[2]).toHaveProperty("a");
      const all = await search(a, { query: "7001", limit: 10 });
      expect(all.items.map((i) => i.productId)).toEqual(seen);
      // A page boundary right after the exact hits: the next page starts the text matches.
      const two = await search(a, { query: "7001", limit: 2 });
      expect(two.items.map((i) => i.productId)).toEqual([p1.productId, p2.productId]);
      const rest = await search(a, { query: "7001", limit: 2, cursor: two.nextCursor! });
      expect(rest.items.map((i) => i.productId)).toEqual([p3.productId, p4.productId]);
      expect(rest.nextCursor).toBeNull();
    });

    it("search stays fast on 1500 products (loose smoke guard, not a benchmark)", async () => {
      const { a } = await world();
      const biz = a.business.id;
      const rows = Array.from({ length: 1500 }, (_, i) => ({ id: randomUUID(), nameAr: `منتج رقم ${i}`, sku: `Q${i}` }));
      await db.rtProduct.createMany({ data: rows.map((r) => ({ id: r.id, businessId: biz, nameAr: r.nameAr, searchText: normalizeSearchText(r.nameAr) })) });
      const vIds = rows.map(() => randomUUID());
      await db.rtVariant.createMany({ data: rows.map((r, i) => ({ id: vIds[i]!, businessId: biz, productId: r.id, sku: r.sku, searchText: normalizeSearchText(`${r.nameAr} ${r.sku}`) })) });
      await db.rtUnit.createMany({ data: rows.map((_, i) => ({ businessId: biz, variantId: vIds[i]!, name: "حبة", factor: 1, isBase: true })) });
      await search(a, { query: "منتج" }); // warm up the connection
      const t0 = performance.now();
      for (const q of ["منتج رقم 77", "q1499", "رقم", ""]) await search(a, { query: q });
      const perCall = (performance.now() - t0) / 4;
      // Documented as a smoke guard: a regression to a per-hit query would blow far past this.
      expect(perCall).toBeLessThan(1500);

      // The trigram GIN index is usable for a Latin term (the planner may still prefer a scan on a
      // table this small, hence enable_seqscan=off). Arabic needs a UTF-8 ctype database (report).
      const plan = await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        const out = await tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN SELECT id FROM "RtVariant" WHERE "searchText" LIKE '%q1499%'`);
        return out.map((r) => r["QUERY PLAN"]).join("\n");
      });
      expect(plan).toContain("RtVariant_searchText_idx");
    }, 60_000);
  });
});
