import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  addBarcode,
  addUnit,
  addVariant,
  archiveBarcode,
  archiveProduct,
  archiveUnit,
  archiveVariant,
  createProduct,
  unarchiveProduct,
  getProduct,
  updateProduct,
  unitIsLocked,
  updateUnit,
} from "@/server/catalog/products";
import { archiveBrand, archiveCategory, createBrand, createCategory } from "@/server/catalog/taxonomy";
import { postStockDocument, saveStockDraft } from "@/server/stock/documents";
import { normalizeSearchText } from "@/server/domain/catalog";
import { z } from "zod";
import { defineAction } from "@/server/framework/action";
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

type Shop = Awaited<ReturnType<typeof business>>;

/**
 * Polls until at least `n` sessions of this database wait for a lock (row, index or advisory), or
 * `stop()` says the work already finished. Files run one at a time, so the count is ours.
 */
async function untilWaiting(n: number, stop: () => boolean = () => false, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end && !stop()) {
    const [row] = await db.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (Number(row!.count) >= n) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

/** A promise plus a flag telling whether it has settled. */
function tracked<T>(p: Promise<T>): { promise: Promise<T>; done: () => boolean } {
  let settled = false;
  void p.then(
    () => (settled = true),
    () => (settled = true),
  );
  return { promise: p, done: () => settled };
}

async function world() {
  await createPlan(db, { maxBranches: 3 });
  return { a: await business("A shop"), b: await business("B shop") };
}

const piece = (barcodes: string[] = []) => ({ name: "حبة", barcodes });

/** Creates a product and returns its ids (fails the test when refused). */
async function product(w: Shop, input: Record<string, unknown>, who = "stock") {
  const r = await createProduct({ baseUnit: piece(), ...input }, w.as(who));
  if (!r.ok) throw new Error(`createProduct failed: ${r.code}`);
  return r.value;
}

describe("products, variants and units", () => {
  it("a carton of 24 and a piece are two units of one variant with their own barcodes", async () => {
    const { a } = await world();
    const r = await createProduct(
      {
        nameAr: "  عصير برتقال  ",
        nameEn: "Orange juice",
        baseUnit: piece(["6281000000011"]),
        extraUnits: [{ name: "كرتون", factor: 24, barcodes: ["6281000000028"] }],
      },
      a.as("stock"),
    );
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const units = await db.rtUnit.findMany({ where: { variantId: r.value.variantId }, orderBy: { factor: "asc" } });
    expect(units.map((u) => [u.name, u.factor, u.isBase])).toEqual([
      ["حبة", 1, true],
      ["كرتون", 24, false],
    ]);
    expect(units[0]!.id).toBe(r.value.baseUnitId);
    const codes = await db.rtBarcode.findMany({ where: { businessId: a.business.id }, orderBy: { code: "asc" } });
    expect(codes.map((c) => [c.code, c.unitId])).toEqual([
      ["6281000000011", units[0]!.id],
      ["6281000000028", units[1]!.id],
    ]);
    expect(await db.rtProduct.findUniqueOrThrow({ where: { id: r.value.productId } })).toMatchObject({ nameAr: "عصير برتقال", nameEn: "Orange juice", version: 1 });
    expect(await db.rtVariant.count({ where: { productId: r.value.productId } })).toBe(1);

    // Zero, negative and fractional factors never make a unit.
    for (const factor of [0, -6, 2.5, 100_001]) {
      const bad = await createProduct({ nameAr: "سيء", baseUnit: piece(), extraUnits: [{ name: "علبة", factor }] }, a.as("stock"));
      expect(bad).toMatchObject({ ok: false });
      expect(["UNIT_RULE", "INVALID_INPUT"]).toContain(bad.ok ? "" : bad.code);
      const added = await addUnit({ variantId: r.value.variantId, name: "علبة", factor }, a.as("stock"));
      expect(["UNIT_RULE", "INVALID_INPUT"]).toContain(added.ok ? "" : added.code);
    }
    expect(await db.rtProduct.count({ where: { businessId: a.business.id } })).toBe(1);

    // A third unit is added later with its own barcode.
    const pack = await addUnit({ variantId: r.value.variantId, name: "علبة 6", factor: 6, barcodes: ["6281000000035"] }, a.as("stock"));
    expect(pack).toMatchObject({ ok: true, value: { name: "علبة 6", factor: 6, isBase: false } });
    // Two units of one variant cannot share a name.
    expect(await addUnit({ variantId: r.value.variantId, name: " كرتون ", factor: 12 }, a.as("stock"))).toMatchObject({ ok: false, code: "UNIT_RULE" });
  });

  it("a shirt in two sizes and two colours makes four variants with unique SKUs", async () => {
    const { a } = await world();
    const shirt = await product(a, { nameAr: "قميص", nameEn: "Shirt", options: { size: "M", colour: "أحمر" } });
    const ids = [shirt.variantId];
    for (const [size, colour] of [["L", "أحمر"], ["M", "أزرق"], ["L", "أزرق"]] as const) {
      const v = await addVariant({ productId: shirt.productId, options: { size, colour }, baseUnit: piece() }, a.as("stock"));
      expect(v).toMatchObject({ ok: true });
      if (v.ok) ids.push(v.value.variantId);
    }
    const variants = await db.rtVariant.findMany({ where: { productId: shirt.productId } });
    expect(variants).toHaveLength(4);
    expect(new Set(variants.map((v) => v.sku)).size).toBe(4);
    expect(new Set(variants.map((v) => v.id))).toEqual(new Set(ids));
    // Every variant has exactly one base unit, factor 1.
    for (const v of variants) {
      const units = await db.rtUnit.findMany({ where: { variantId: v.id } });
      expect(units.filter((u) => u.isBase).map((u) => u.factor)).toEqual([1]);
    }
    // The same option set twice is refused.
    expect(await addVariant({ productId: shirt.productId, options: { colour: "أزرق", size: "L" }, baseUnit: piece() }, a.as("stock"))).toMatchObject({
      ok: false,
      code: "DUPLICATE_NAME",
    });
    // Variant search text carries the model name, its SKU and its options.
    const blue = variants.find((v) => (v.options as Record<string, string>).colour === "أزرق" && (v.options as Record<string, string>).size === "L")!;
    expect(blue.searchText).toContain("قميص");
    expect(blue.searchText).toContain(normalizeSearchText(blue.sku));
    expect(blue.searchText).toContain("ازرق");

    const read = await getProduct({ id: shirt.productId }, a.as("cashier"));
    expect(read.ok && read.value.variants).toHaveLength(4);
  });

  it("SKU is generated per business when empty and never reused", async () => {
    const { a, b } = await world();
    const p1 = await product(a, { nameAr: "واحد" });
    const p2 = await product(a, { nameAr: "اثنان" });
    const manual = await product(a, { nameAr: "يدوي", sku: "MY-SKU-1" });
    expect(manual.sku).toBe("MY-SKU-1");
    expect(p1.sku).not.toBe(p2.sku);
    // The other business has its own sequence, so it can produce the same first SKU.
    const other = await product(b, { nameAr: "واحد" });
    expect(other.sku).toBe(p1.sku);

    // Archiving does not free the SKU; the next one is new.
    expect(await archiveProduct({ id: p2.productId, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
    const p3 = await product(a, { nameAr: "ثلاثة" });
    expect([p1.sku, p2.sku, manual.sku]).not.toContain(p3.sku);
    // A manual SKU that is already used (even by an archived product) is refused.
    expect(await createProduct({ nameAr: "مكرر", sku: p2.sku, baseUnit: piece() }, a.as("stock"))).toMatchObject({ ok: false, code: "SKU_TAKEN" });

    // A manual SKU that looks like the next generated one is skipped by the generator.
    const nextLooking = p3.sku.replace(/\d+$/, (d) => String(Number(d) + 1).padStart(d.length, "0"));
    await product(a, { nameAr: "يشبه التالي", sku: nextLooking });
    const p4 = await product(a, { nameAr: "أربعة" });
    expect(p4.sku).not.toBe(nextLooking);
    const all = await db.rtVariant.findMany({ where: { businessId: a.business.id } });
    expect(new Set(all.map((v) => v.sku)).size).toBe(all.length);

    // SKU is not an editable field.
    expect(await updateProduct({ id: p1.productId, expectedVersion: 1, sku: "NEW" }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("tracksExpiry without BATCH is refused", async () => {
    const { a } = await world();
    expect(await createProduct({ nameAr: "حليب", tracksExpiry: true, baseUnit: piece() }, a.as("stock"))).toMatchObject({ ok: false, code: "TRACKING_RULE" });
    expect(await createProduct({ nameAr: "حليب", trackingMode: "SERIAL", tracksExpiry: true, baseUnit: piece() }, a.as("stock"))).toMatchObject({
      ok: false,
      code: "TRACKING_RULE",
    });
    expect(await createProduct({ nameAr: "حليب", expiryAlertDays: 5, baseUnit: piece() }, a.as("stock"))).toMatchObject({ ok: false, code: "TRACKING_RULE" });
    const milk = await product(a, { nameAr: "حليب", trackingMode: "BATCH", tracksExpiry: true, expiryAlertDays: 7 });
    // Switching the mode away from BATCH while expiry is tracked is refused too.
    expect(await updateProduct({ id: milk.productId, expectedVersion: 1, trackingMode: "NONE" }, a.as("stock"))).toMatchObject({ ok: false, code: "TRACKING_RULE" });
    expect(await updateProduct({ id: milk.productId, expectedVersion: 1, trackingMode: "NONE", tracksExpiry: false, expiryAlertDays: null }, a.as("stock"))).toMatchObject({
      ok: true,
    });
    expect(await db.rtProduct.count({ where: { businessId: a.business.id } })).toBe(1);
  });

  it("SERIAL and BATCH are never combined and soldByWeight needs a fractional unit", async () => {
    const { a } = await world();
    // One mode only: anything but the three modes is refused.
    expect(await createProduct({ nameAr: "س", trackingMode: "SERIAL_BATCH", baseUnit: piece() }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await createProduct({ nameAr: "س", trackingMode: ["SERIAL", "BATCH"], baseUnit: piece() }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });

    expect(await createProduct({ nameAr: "طماطم", soldByWeight: true, baseUnit: { name: "كغم" } }, a.as("stock"))).toMatchObject({ ok: false, code: "UNIT_RULE" });
    const tomato = await product(a, { nameAr: "طماطم", soldByWeight: true, baseUnit: { name: "كغم", quantityScale: 3 } });
    // The base unit of a product sold by weight cannot become whole-only.
    const base = await db.rtUnit.findUniqueOrThrow({ where: { id: tomato.baseUnitId } });
    expect(await updateUnit({ id: base.id, expectedVersion: 1, quantityScale: 0 }, a.as("stock"))).toMatchObject({ ok: false, code: "UNIT_RULE" });
    // A whole-unit product cannot be switched to sold by weight.
    const can = await product(a, { nameAr: "علبة فول" });
    expect(await updateProduct({ id: can.productId, expectedVersion: 1, soldByWeight: true }, a.as("stock"))).toMatchObject({ ok: false, code: "UNIT_RULE" });
    // A new variant of a weighed product needs a fractional base unit too.
    expect(await addVariant({ productId: tomato.productId, options: { kind: "كرزية" }, baseUnit: { name: "كغم" } }, a.as("stock"))).toMatchObject({
      ok: false,
      code: "UNIT_RULE",
    });
  });

  it("the base unit cannot be archived and its factor stays 1", async () => {
    const { a } = await world();
    const p = await product(a, { nameAr: "سكر", extraUnits: [{ name: "كيس", factor: 10 }] });
    expect(await archiveUnit({ id: p.baseUnitId, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "UNIT_RULE" });
    expect(await updateUnit({ id: p.baseUnitId, expectedVersion: 1, factor: 2 }, a.as("stock"))).toMatchObject({ ok: false, code: "UNIT_RULE" });
    const bag = await db.rtUnit.findFirstOrThrow({ where: { variantId: p.variantId, isBase: false } });
    // R1 has no stock movements, so a factor can still change; then archive the unit.
    expect(await updateUnit({ id: bag.id, expectedVersion: 1, factor: 12, name: "كيس 12" }, a.as("stock"))).toMatchObject({ ok: true, value: { factor: 12, name: "كيس 12", version: 2 } });
    expect(await updateUnit({ id: bag.id, expectedVersion: 1, factor: 5 }, a.as("stock"))).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(await archiveUnit({ id: bag.id, expectedVersion: 2 }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await db.rtUnit.findUniqueOrThrow({ where: { id: p.baseUnitId } })).toMatchObject({ archivedAt: null, factor: 1, isBase: true });
  });
});

describe("barcodes", () => {
  it("an existing barcode in createProduct is refused with BARCODE_TAKEN naming the product that owns it", async () => {
    const { a } = await world();
    const owner = await product(a, { nameAr: "بيبسي", extraUnits: [{ name: "كرتون", factor: 24, barcodes: ["5449000000996"] }] });
    const r = await createProduct({ nameAr: "كولا", baseUnit: piece(["5449000000996"]) }, a.as("stock"));
    expect(r).toMatchObject({
      ok: false,
      code: "BARCODE_TAKEN",
      details: { barcode: "5449000000996", productId: owner.productId, productName: "بيبسي", productNameCkb: null, productNameEn: null },
    });
    expect(r.ok ? "" : r.message).not.toBe("");
    expect(await db.rtProduct.count({ where: { businessId: a.business.id } })).toBe(1);
    // The same code on another unit of the same product, or through addBarcode, is refused too.
    expect(await addBarcode({ unitId: owner.baseUnitId, code: "5449000000996" }, a.as("stock"))).toMatchObject({
      ok: false,
      code: "BARCODE_TAKEN",
      details: { productId: owner.productId },
    });
    // The same code twice in one request is refused.
    expect(await createProduct({ nameAr: "مكرر", baseUnit: piece(["111"]), extraUnits: [{ name: "ك", factor: 2, barcodes: ["111"] }] }, a.as("stock"))).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
  });

  it("a barcode on an archived product still blocks reuse", async () => {
    const { a } = await world();
    const old = await product(a, { nameAr: "قديم", baseUnit: piece(["999000"]) });
    expect(await archiveProduct({ id: old.productId, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await createProduct({ nameAr: "جديد", baseUnit: piece(["999000"]) }, a.as("stock"))).toMatchObject({
      ok: false,
      code: "BARCODE_TAKEN",
      details: { productId: old.productId },
    });
    // An archived barcode on an active product is reserved as well.
    const p = await product(a, { nameAr: "آخر", baseUnit: piece(["777"]) });
    const bc = await db.rtBarcode.findFirstOrThrow({ where: { code: "777" } });
    expect(await archiveBarcode({ id: bc.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await addBarcode({ unitId: p.baseUnitId, code: "777" }, a.as("stock"))).toMatchObject({ ok: false, code: "BARCODE_TAKEN" });
  });

  it("a leading-zero barcode is stored exactly, Arabic digits become ASCII", async () => {
    const { a } = await world();
    const p = await product(a, { nameAr: "صفر", baseUnit: piece(["0012345"]) });
    expect((await db.rtBarcode.findFirstOrThrow({ where: { unitId: p.baseUnitId } })).code).toBe("0012345");
    const added = await addBarcode({ unitId: p.baseUnitId, code: " ٠٠٩٨٧ " }, a.as("stock"));
    expect(added).toMatchObject({ ok: true, value: { code: "00987" } });
    // "12345" is a different code from "0012345".
    expect(await addBarcode({ unitId: p.baseUnitId, code: "12345" }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await addBarcode({ unitId: p.baseUnitId, code: "bad code!" }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    const variant = await db.rtVariant.findUniqueOrThrow({ where: { id: p.variantId } });
    expect(variant.searchText).toContain("0012345");
    expect(variant.searchText).toContain("00987");
  });

  it("two concurrent createProduct calls with the same barcode create exactly one", async () => {
    const { a } = await world();
    for (let round = 0; round < 4; round += 1) {
      const code = `20000${round}`;
      // Manual SKUs: nothing else serializes the two, so the database constraint decides.
      const r = await Promise.all([
        createProduct({ nameAr: `أ${round}`, sku: `RACE-A-${round}`, baseUnit: piece([code]) }, a.as("stock")),
        createProduct({ nameAr: `ب${round}`, sku: `RACE-B-${round}`, baseUnit: piece([code]) }, a.as("manager")),
      ]);
      expect(r.filter((v) => v.ok)).toHaveLength(1);
      expect(r.find((v) => !v.ok)).toMatchObject({ code: "BARCODE_TAKEN" });
      expect(await db.rtBarcode.count({ where: { businessId: a.business.id, code } })).toBe(1);
      expect(await db.rtProduct.count({ where: { businessId: a.business.id } })).toBe(round + 1);
    }
    // With generated SKUs as well.
    const r = await Promise.all([
      createProduct({ nameAr: "س", baseUnit: piece(["30000"]) }, a.as("stock")),
      createProduct({ nameAr: "ص", baseUnit: piece(["30000"]) }, a.as("manager")),
    ]);
    expect(r.filter((v) => v.ok)).toHaveLength(1);
    expect(r.find((v) => !v.ok)).toMatchObject({ code: "BARCODE_TAKEN" });
  });

  it("a code committed by someone else after our check is still refused by the database constraint", async () => {
    const { a } = await world();
    const holder = await product(a, { nameAr: "حامل" });
    let pending: ReturnType<typeof createProduct> | undefined;
    // Our insert is not committed yet, so the action's look-up does not see it; its own insert
    // then waits on the unique index (we poll until it does) and fails once we commit.
    await db.$transaction(
      async (t) => {
        await t.rtBarcode.create({ data: { businessId: a.business.id, unitId: holder.baseUnitId, code: "RACE-1" } });
        pending = createProduct({ nameAr: "متأخر", sku: "LATE-1", baseUnit: piece(["RACE-1"]) }, a.as("stock"));
        expect(await untilWaiting(1)).toBe(true);
      },
      { timeout: 15_000 },
    );
    const late = await pending!;
    expect(late).toMatchObject({ ok: false, code: "BARCODE_TAKEN", details: { barcode: "RACE-1" } });
    // The database path was taken: the look-up never saw the code, so the owner is not named.
    expect(late.ok ? null : late.details).not.toHaveProperty("productId");
    expect(await db.rtBarcode.count({ where: { businessId: a.business.id, code: "RACE-1" } })).toBe(1);
    expect(await db.rtProduct.count({ where: { businessId: a.business.id } })).toBe(1);

    // The same for addBarcode, and for a manual SKU taken in the meantime.
    let pendingCode: ReturnType<typeof addBarcode> | undefined;
    let pendingSku: ReturnType<typeof createProduct> | undefined;
    await db.$transaction(
      async (t) => {
        await t.rtBarcode.create({ data: { businessId: a.business.id, unitId: holder.baseUnitId, code: "RACE-2" } });
        await t.rtVariant.create({ data: { businessId: a.business.id, productId: holder.productId, sku: "RACE-SKU" } });
        pendingCode = addBarcode({ unitId: holder.baseUnitId, code: "RACE-2" }, a.as("stock"));
        pendingSku = createProduct({ nameAr: "متأخر", sku: "RACE-SKU", baseUnit: piece() }, a.as("manager"));
        expect(await untilWaiting(2)).toBe(true);
      },
      { timeout: 15_000 },
    );
    const code = await pendingCode!;
    expect(code).toMatchObject({ ok: false, code: "BARCODE_TAKEN" });
    expect(code.ok ? null : code.details).not.toHaveProperty("productId");
    expect(await pendingSku).toMatchObject({ ok: false, code: "SKU_TAKEN" });
    expect(await db.rtProduct.count({ where: { businessId: a.business.id } })).toBe(1);
  });

  it("concurrent createProduct calls generating SKUs never collide", async () => {
    const { a } = await world();
    const r = await Promise.all(Array.from({ length: 6 }, (_, i) => createProduct({ nameAr: `منتج ${i}`, baseUnit: piece() }, a.as(i % 2 ? "stock" : "manager"))));
    expect(r.every((v) => v.ok)).toBe(true);
    const skus = r.map((v) => (v.ok ? v.value.sku : ""));
    expect(new Set(skus).size).toBe(6);
  });
});

describe("prices, permissions and isolation", () => {
  it("a stock officer creates a product without a price and is refused when giving a price", async () => {
    const { a } = await world();
    expect(await createProduct({ nameAr: "بلا سعر", baseUnit: piece() }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await createProduct({ nameAr: "بسعر", baseUnit: piece(["123"]), price: { currency: "IQD", amountMinor: 1500n } }, a.as("stock"))).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(await db.rtProduct.count({ where: { businessId: a.business.id } })).toBe(1);
    expect(await db.rtBarcode.count({ where: { businessId: a.business.id } })).toBe(0);
    expect(await db.rtPrice.count({ where: { businessId: a.business.id } })).toBe(0);

    // A manager may: the base price is stored on the DEFAULT list, the carton gets factor x base.
    const m = await createProduct(
      { nameAr: "بسعر", baseUnit: piece(), extraUnits: [{ name: "كرتون", factor: 24 }, { name: "نصف", factor: 12, amountMinor: "17000" }], price: { currency: "IQD", amountMinor: "1500" } },
      a.as("manager"),
    );
    expect(m).toMatchObject({ ok: true });
    if (!m.ok) return;
    const lists = await db.rtPriceList.findMany({ where: { businessId: a.business.id } });
    expect(lists.map((l) => l.kind).sort()).toEqual(["DEFAULT", "WHOLESALE"]);
    const defaultList = lists.find((l) => l.kind === "DEFAULT")!;
    const prices = await db.rtPrice.findMany({ where: { businessId: a.business.id }, include: { unit: true } });
    expect(prices.map((p) => [p.unit.name, p.amountMinor, p.currency, p.priceListId, p.validTo]).sort()).toEqual(
      [
        ["حبة", 1500n, "IQD", defaultList.id, null],
        ["كرتون", 36000n, "IQD", defaultList.id, null],
        ["نصف", 17000n, "IQD", defaultList.id, null],
      ].sort(),
    );
    // A currency the business has not enabled is refused.
    expect(await createProduct({ nameAr: "دولار", baseUnit: piece(), price: { currency: "USD", amountMinor: 150n } }, a.as("manager"))).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    // A stock officer cannot price a new unit; a manager can.
    expect(await addUnit({ variantId: m.value.variantId, name: "ربطة", factor: 6, price: { currency: "IQD", amountMinor: 8000n } }, a.as("stock"))).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(await addUnit({ variantId: m.value.variantId, name: "ربطة", factor: 6, price: { currency: "IQD", amountMinor: 8000n } }, a.as("manager"))).toMatchObject({ ok: true });
  });

  it("a cashier cannot create or edit", async () => {
    const { a } = await world();
    const p = await product(a, { nameAr: "صنف", extraUnits: [{ name: "كرتون", factor: 6, barcodes: ["55"] }] });
    const carton = await db.rtUnit.findFirstOrThrow({ where: { variantId: p.variantId, isBase: false } });
    const bc = await db.rtBarcode.findFirstOrThrow({ where: { code: "55" } });
    const c = a.as("cashier");
    const refused = [
      await createProduct({ nameAr: "x", baseUnit: piece() }, c),
      await updateProduct({ id: p.productId, expectedVersion: 1, nameAr: "x" }, a.as("cashier")),
      await archiveProduct({ id: p.productId, expectedVersion: 1 }, a.as("cashier")),
      await addVariant({ productId: p.productId, options: { size: "L" }, baseUnit: piece() }, a.as("cashier")),
      await addUnit({ variantId: p.variantId, name: "ربطة", factor: 3 }, a.as("cashier")),
      await updateUnit({ id: carton.id, expectedVersion: 1, name: "x" }, a.as("cashier")),
      await archiveUnit({ id: carton.id, expectedVersion: 1 }, a.as("cashier")),
      await addBarcode({ unitId: carton.id, code: "66" }, a.as("cashier")),
      await archiveBarcode({ id: bc.id, expectedVersion: 1 }, a.as("cashier")),
    ];
    for (const r of refused) expect(r).toMatchObject({ ok: false, code: "FORBIDDEN" });
    // Reading is open to every member.
    expect(await getProduct({ id: p.productId }, a.as("cashier"))).toMatchObject({ ok: true, value: { id: p.productId, nameAr: "صنف" } });
    expect(await db.rtProduct.findUniqueOrThrow({ where: { id: p.productId } })).toMatchObject({ nameAr: "صنف", version: 1, archivedAt: null });
  });

  it("every write is refused in READ_ONLY, reads still work", async () => {
    const { a } = await world();
    const p = await product(a, { nameAr: "صنف", extraUnits: [{ name: "كرتون", factor: 6, barcodes: ["55"] }] });
    const carton = await db.rtUnit.findFirstOrThrow({ where: { variantId: p.variantId, isBase: false } });
    const bc = await db.rtBarcode.findFirstOrThrow({ where: { code: "55" } });
    await db.rtBusiness.update({ where: { id: a.business.id }, data: { status: "SUSPENDED" } });
    const s = () => a.as("owner");
    const results = [
      await createProduct({ nameAr: "x", baseUnit: piece() }, s()),
      await updateProduct({ id: p.productId, expectedVersion: 1, nameAr: "x" }, s()),
      await archiveProduct({ id: p.productId, expectedVersion: 1 }, s()),
      await addVariant({ productId: p.productId, options: { size: "L" }, baseUnit: piece() }, s()),
      await addUnit({ variantId: p.variantId, name: "ربطة", factor: 3 }, s()),
      await updateUnit({ id: carton.id, expectedVersion: 1, name: "x" }, s()),
      await archiveUnit({ id: carton.id, expectedVersion: 1 }, s()),
      await addBarcode({ unitId: carton.id, code: "66" }, s()),
      await archiveBarcode({ id: bc.id, expectedVersion: 1 }, s()),
    ];
    for (const r of results) expect(r).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await getProduct({ id: p.productId }, a.as("cashier"))).toMatchObject({ ok: true });
    expect(await db.rtProduct.count({ where: { businessId: a.business.id } })).toBe(1);
  });

  it("another business never sees or edits these rows", async () => {
    const { a, b } = await world();
    const p = await product(a, { nameAr: "صنف أ", extraUnits: [{ name: "كرتون", factor: 6, barcodes: ["55"] }] });
    const carton = await db.rtUnit.findFirstOrThrow({ where: { variantId: p.variantId, isBase: false } });
    const bc = await db.rtBarcode.findFirstOrThrow({ where: { code: "55" } });
    const o = () => b.as("owner");
    expect(await getProduct({ id: p.productId }, o())).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const refused = [
      await updateProduct({ id: p.productId, expectedVersion: 1, nameAr: "مسروق" }, o()),
      await archiveProduct({ id: p.productId, expectedVersion: 1 }, o()),
      await addVariant({ productId: p.productId, options: { size: "L" }, baseUnit: piece() }, o()),
      await addUnit({ variantId: p.variantId, name: "ربطة", factor: 3 }, o()),
      await updateUnit({ id: carton.id, expectedVersion: 1, name: "x" }, o()),
      await archiveUnit({ id: carton.id, expectedVersion: 1 }, o()),
      await addBarcode({ unitId: carton.id, code: "66" }, o()),
      await archiveBarcode({ id: bc.id, expectedVersion: 1 }, o()),
    ];
    for (const r of refused) expect(r).toMatchObject({ ok: false, code: "NOT_FOUND" });
    // Not a member of A at all.
    expect(await getProduct({ id: p.productId }, { ...b.as("owner"), businessId: a.business.id })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    // The same barcode is free in B.
    expect(await createProduct({ nameAr: "صنف ب", baseUnit: piece(["55"]) }, o())).toMatchObject({ ok: true });
    expect(await db.rtProduct.findUniqueOrThrow({ where: { id: p.productId } })).toMatchObject({ nameAr: "صنف أ", version: 1, archivedAt: null });
  });

  it("archived or foreign categories and brands are rejected; archived names still show on read", async () => {
    const { a, b } = await world();
    const cat = await createCategory({ nameAr: "مشروبات" }, a.as("stock"));
    const brand = await createBrand({ nameAr: "المراعي" }, a.as("stock"));
    const foreignCat = await createCategory({ nameAr: "قسم ب" }, b.as("stock"));
    const foreignBrand = await createBrand({ nameAr: "علامة ب" }, b.as("stock"));
    if (!cat.ok || !brand.ok || !foreignCat.ok || !foreignBrand.ok) throw new Error("taxonomy");

    expect(await createProduct({ nameAr: "x", categoryId: foreignCat.value.id, baseUnit: piece() }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await createProduct({ nameAr: "x", brandId: foreignBrand.value.id, baseUnit: piece() }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });

    const p = await product(a, { nameAr: "لبن", categoryId: cat.value.id, brandId: brand.value.id });
    // The category is in use; the brand can be archived and then cannot be assigned again.
    expect(await archiveCategory({ id: cat.value.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "CATEGORY_IN_USE" });
    expect(await archiveBrand({ id: brand.value.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await createProduct({ nameAr: "x", brandId: brand.value.id, baseUnit: piece() }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const other = await product(a, { nameAr: "جبن" });
    expect(await updateProduct({ id: other.productId, expectedVersion: 1, brandId: brand.value.id }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });

    // The product keeps its archived brand and getProduct still shows the name.
    const read = await getProduct({ id: p.productId }, a.as("cashier"));
    expect(read).toMatchObject({ ok: true, value: { brand: { id: brand.value.id, nameAr: "المراعي" }, category: { id: cat.value.id, nameAr: "مشروبات", archivedAt: null } } });
    expect(read.ok && read.value.brand?.archivedAt).toBeInstanceOf(Date);
    // Editing the product without touching the brand still works.
    expect(await updateProduct({ id: p.productId, expectedVersion: 1, nameEn: "Laban" }, a.as("stock"))).toMatchObject({ ok: true });

    // Archiving the category after moving the product out of it.
    expect(await updateProduct({ id: p.productId, expectedVersion: 2, categoryId: null }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await archiveCategory({ id: cat.value.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await updateProduct({ id: p.productId, expectedVersion: 3, categoryId: cat.value.id }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("lifecycle", () => {
  it("double submit with the same key creates one product", async () => {
    const { a } = await world();
    const k = key();
    const input = { nameAr: "مرة واحدة", baseUnit: piece(["4242"]) };
    const [first, second] = await Promise.all([createProduct(input, a.as("stock", k)), createProduct(input, a.as("stock", k))]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual(first);
    expect(await createProduct(input, a.as("stock", k))).toEqual(first);
    expect(await db.rtProduct.count({ where: { businessId: a.business.id } })).toBe(1);
    expect(await createProduct({ ...input, nameAr: "آخر" }, a.as("stock", k))).toMatchObject({ ok: false, code: "IDEMPOTENCY_MISMATCH" });
    expect(await db.rtAuditLog.count({ where: { businessId: a.business.id, action: "catalog.product.create" } })).toBe(1);
  });

  it("unarchive brings a product back: editable, searchable, audited, version checked, manage only, own business only", async () => {
    const { a, b } = await world();
    const p = await product(a, { nameAr: "راجع", baseUnit: piece(["7070"]) });
    expect(await archiveProduct({ id: p.productId, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
    // Refused: a cashier, a stale version, another business, an unknown id.
    expect(await unarchiveProduct({ id: p.productId, expectedVersion: 2 }, a.as("cashier"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await unarchiveProduct({ id: p.productId, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(await unarchiveProduct({ id: p.productId, expectedVersion: 2 }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await unarchiveProduct({ id: "missing", expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const back = await unarchiveProduct({ id: p.productId, expectedVersion: 2 }, a.as("stock"));
    expect(back).toMatchObject({ ok: true, value: { id: p.productId, archivedAt: null, version: 3 } });
    // Active again: editable, and an active product cannot be unarchived twice.
    expect(await updateProduct({ id: p.productId, expectedVersion: 3, nameAr: "راجع جديد" }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await unarchiveProduct({ id: p.productId, expectedVersion: 4 }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await db.rtAuditLog.count({ where: { businessId: a.business.id, action: "catalog.product.unarchive" } })).toBe(1);
    const row = await db.rtProduct.findUniqueOrThrow({ where: { id: p.productId } });
    expect(row.searchText).toContain(normalizeSearchText("راجع جديد"));
  });

  it("archive keeps the product readable and frees nothing", async () => {
    const { a } = await world();
    const p = await product(a, { nameAr: "مؤرشف", baseUnit: piece(["8080"]) });
    expect(await archiveProduct({ id: p.productId, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true, value: { id: p.productId, version: 2 } });
    const read = await getProduct({ id: p.productId }, a.as("cashier"));
    expect(read).toMatchObject({ ok: true, value: { id: p.productId, nameAr: "مؤرشف", variants: [{ id: p.variantId, sku: p.sku }] } });
    expect(read.ok && read.value.archivedAt).toBeInstanceOf(Date);
    expect(read.ok && read.value.variants[0]!.units[0]!.barcodes.map((b) => b.code)).toEqual(["8080"]);
    // Nothing was freed: the barcode and the SKU still block, rows still exist.
    expect(await createProduct({ nameAr: "x", baseUnit: piece(["8080"]) }, a.as("stock"))).toMatchObject({ ok: false, code: "BARCODE_TAKEN" });
    expect(await createProduct({ nameAr: "x", sku: p.sku, baseUnit: piece() }, a.as("stock"))).toMatchObject({ ok: false, code: "SKU_TAKEN" });
    expect(await db.rtVariant.findUniqueOrThrow({ where: { id: p.variantId } })).toMatchObject({ archivedAt: null });
    // An archived product cannot be edited, archived again, or grow.
    expect(await updateProduct({ id: p.productId, expectedVersion: 2, nameAr: "ن" }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await archiveProduct({ id: p.productId, expectedVersion: 2 }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await addVariant({ productId: p.productId, options: { size: "L" }, baseUnit: piece() }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await addUnit({ variantId: p.variantId, name: "كرتون", factor: 6 }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await getProduct({ id: "missing" }, a.as("cashier"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("searchText is filled from every name, the SKU and the barcodes and follows edits", async () => {
    const { a } = await world();
    const p = await product(a, { nameAr: "مدرسة الأطفال", nameCkb: "قوتابخانە", nameEn: "Kids School", baseUnit: piece(["0099"]) });
    const prod = await db.rtProduct.findUniqueOrThrow({ where: { id: p.productId } });
    expect(prod.searchText).toContain("مدرسه الاطفال");
    expect(prod.searchText).toContain("kids school");
    expect(prod.searchText).toContain(normalizeSearchText("قوتابخانە"));
    const v = await db.rtVariant.findUniqueOrThrow({ where: { id: p.variantId } });
    expect(v.searchText).toContain("مدرسه الاطفال");
    expect(v.searchText).toContain(normalizeSearchText(p.sku));
    expect(v.searchText).toContain("0099");

    expect(await updateProduct({ id: p.productId, expectedVersion: 1, nameAr: "حقيبة", nameEn: null }, a.as("stock"))).toMatchObject({ ok: true, value: { version: 2 } });
    const after = await db.rtProduct.findUniqueOrThrow({ where: { id: p.productId } });
    expect(after.searchText).toContain("حقيبه");
    expect(after.searchText).not.toContain("school");
    expect(after.nameCkb).toBe("قوتابخانە");
    const v2 = await db.rtVariant.findUniqueOrThrow({ where: { id: p.variantId } });
    expect(v2.searchText).toContain("حقيبه");
    expect(v2.searchText).not.toContain("مدرسه");

    // An archived barcode leaves the variant's search text.
    const bc = await db.rtBarcode.findFirstOrThrow({ where: { code: "0099" } });
    expect(await archiveBarcode({ id: bc.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
    expect((await db.rtVariant.findUniqueOrThrow({ where: { id: p.variantId } })).searchText).not.toContain("0099");
  });

  it("updateProduct is version checked and audited", async () => {
    const { a } = await world();
    const p = await product(a, { nameAr: "صنف" });
    expect(await updateProduct({ id: p.productId, expectedVersion: 1, descriptionAr: "وصف" }, a.as("stock"))).toMatchObject({ ok: true, value: { descriptionAr: "وصف", version: 2 } });
    expect(await updateProduct({ id: p.productId, expectedVersion: 1, descriptionAr: "آخر" }, a.as("stock"))).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(await updateProduct({ id: p.productId, expectedVersion: 2, nameAr: "  " }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await createProduct({ nameAr: "x".repeat(201), baseUnit: piece() }, a.as("stock"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await db.rtAuditLog.count({ where: { businessId: a.business.id, action: { startsWith: "catalog.product" } } })).toBe(2);
  });
});

type Tracked<T> = { promise: Promise<T>; done: () => boolean };

describe("concurrency: one product lock for every change under a product", () => {
  it("a concurrent soldByWeight switch and a whole-only base unit never both succeed", async () => {
    const { a } = await world();
    for (let round = 0; round < 3; round += 1) {
      const p = await product(a, { nameAr: `وزن ${round}`, baseUnit: { name: "كغم", quantityScale: 3 } });
      let upd: Tracked<Awaited<ReturnType<typeof updateProduct>>> | undefined;
      let unit: Tracked<Awaited<ReturnType<typeof updateUnit>>> | undefined;
      // We hold the product row, so updateProduct stops after its checks; updateUnit then runs.
      await db.$transaction(
        async (t) => {
          await t.$queryRaw`SELECT id FROM "RtProduct" WHERE id = ${p.productId} FOR UPDATE`;
          upd = tracked(updateProduct({ id: p.productId, expectedVersion: 1, soldByWeight: true }, a.as("stock")));
          expect(await untilWaiting(1, upd.done)).toBe(true);
          unit = tracked(updateUnit({ id: p.baseUnitId, expectedVersion: 1, quantityScale: 0 }, a.as("manager")));
          await untilWaiting(2, unit.done);
        },
        { timeout: 20_000 },
      );
      const r = [await upd!.promise, await unit!.promise];
      expect(r.filter((v) => v.ok)).toHaveLength(1);
      const prod = await db.rtProduct.findUniqueOrThrow({ where: { id: p.productId } });
      const base = await db.rtUnit.findUniqueOrThrow({ where: { id: p.baseUnitId } });
      expect(prod.soldByWeight && base.quantityScale < 1).toBe(false);
    }
  });

  it("a concurrent rename and addBarcode leave searchText with the new name and the new barcode", async () => {
    const { a } = await world();
    const p = await product(a, { nameAr: "اسم قديم", baseUnit: piece() });
    let ren: Tracked<Awaited<ReturnType<typeof updateProduct>>> | undefined;
    let bc: Tracked<Awaited<ReturnType<typeof addBarcode>>> | undefined;
    // We hold the variant row, so the rename stops while rebuilding the variant's search text.
    await db.$transaction(
      async (t) => {
        await t.$queryRaw`SELECT id FROM "RtVariant" WHERE id = ${p.variantId} FOR UPDATE`;
        ren = tracked(updateProduct({ id: p.productId, expectedVersion: 1, nameAr: "اسم جديد" }, a.as("stock")));
        expect(await untilWaiting(1, ren.done)).toBe(true);
        bc = tracked(addBarcode({ unitId: p.baseUnitId, code: "4455667" }, a.as("manager")));
        await untilWaiting(2, bc.done);
      },
      { timeout: 20_000 },
    );
    expect(await ren!.promise).toMatchObject({ ok: true });
    expect(await bc!.promise).toMatchObject({ ok: true });
    const prod = await db.rtProduct.findUniqueOrThrow({ where: { id: p.productId } });
    const variant = await db.rtVariant.findUniqueOrThrow({ where: { id: p.variantId } });
    expect(prod.searchText).toContain("اسم جديد");
    expect(prod.searchText).not.toContain("قديم");
    expect(variant.searchText).toContain("اسم جديد");
    expect(variant.searchText).not.toContain("قديم");
    expect(variant.searchText).toContain("4455667");
  });

  it("a concurrent archiveCategory and createProduct never leave an active product in an archived category", async () => {
    const { a } = await world();
    for (let round = 0; round < 4; round += 1) {
      const c = await createCategory({ nameAr: `قسم ${round}` }, a.as("stock"));
      if (!c.ok) throw new Error("category");
      const r = await Promise.all([
        createProduct({ nameAr: `صنف ${round}`, categoryId: c.value.id, baseUnit: piece() }, a.as("stock")),
        archiveCategory({ id: c.value.id, expectedVersion: 1 }, a.as("manager")),
      ]);
      expect(r.filter((v) => v.ok)).toHaveLength(1);
      const cat = await db.rtCategory.findUniqueOrThrow({ where: { id: c.value.id } });
      const active = await db.rtProduct.count({ where: { categoryId: c.value.id, archivedAt: null } });
      expect(cat.archivedAt !== null && active > 0).toBe(false);
    }
  });
});

describe("fix round 1", () => {
  it("addUnit without a price stores factor x the current base price only for a price.change holder", async () => {
    const { a } = await world();
    const p = await product(a, { nameAr: "ماء", price: { currency: "IQD", amountMinor: 250n } }, "manager");
    const pack = await addUnit({ variantId: p.variantId, name: "باكيت", factor: 12 }, a.as("manager"));
    expect(pack).toMatchObject({ ok: true });
    if (!pack.ok) return;
    const packPrices = await db.rtPrice.findMany({ where: { unitId: pack.value.id } });
    expect(packPrices.map((x) => [x.currency, x.amountMinor, x.validTo])).toEqual([["IQD", 3000n, null]]);

    // A stock officer adds a unit: no price row is created for it.
    const box = await addUnit({ variantId: p.variantId, name: "صندوق", factor: 24 }, a.as("stock"));
    expect(box).toMatchObject({ ok: true });
    if (!box.ok) return;
    expect(await db.rtPrice.count({ where: { unitId: box.value.id } })).toBe(0);

    // An explicit amount wins over the suggestion.
    const half = await addUnit({ variantId: p.variantId, name: "نصف", factor: 6, price: { currency: "IQD", amountMinor: 1400n } }, a.as("manager"));
    if (!half.ok) throw new Error("half");
    expect((await db.rtPrice.findMany({ where: { unitId: half.value.id } })).map((x) => x.amountMinor)).toEqual([1400n]);

    // A product with no base price: the manager's unit gets no price either.
    const bare = await product(a, { nameAr: "بلا سعر" }, "manager");
    const u = await addUnit({ variantId: bare.variantId, name: "كرتون", factor: 6 }, a.as("manager"));
    if (!u.ok) throw new Error("unit");
    expect(await db.rtPrice.count({ where: { unitId: u.value.id } })).toBe(0);
  });

  it("price amounts beyond the money ceiling are INVALID_INPUT, never an internal error", async () => {
    const { a } = await world();
    const huge = 10n ** 17n;
    // factor x base overflows the ceiling (10^18).
    expect(
      await createProduct({ nameAr: "غالي", baseUnit: piece(), extraUnits: [{ name: "كرتون", factor: 100 }], price: { currency: "IQD", amountMinor: huge } }, a.as("manager")),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await createProduct({ nameAr: "غالي", baseUnit: piece(), price: { currency: "IQD", amountMinor: 10n ** 18n + 1n } }, a.as("manager"))).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(await createProduct({ nameAr: "غالي", baseUnit: piece(), price: { currency: "IQD", amountMinor: "99999999999999999999" } }, a.as("manager"))).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    const p = await product(a, { nameAr: "غالي", price: { currency: "IQD", amountMinor: huge } }, "manager");
    expect(await addUnit({ variantId: p.variantId, name: "كرتون", factor: 100 }, a.as("manager"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await db.rtUnit.count({ where: { variantId: p.variantId } })).toBe(1);
  });

  it("updateUnit, archiveUnit and archiveBarcode refuse rows of an archived product or variant", async () => {
    const { a } = await world();
    const p = await product(a, { nameAr: "صنف", extraUnits: [{ name: "كرتون", factor: 6, barcodes: ["5050"] }] });
    const carton = await db.rtUnit.findFirstOrThrow({ where: { variantId: p.variantId, isBase: false } });
    const bc = await db.rtBarcode.findFirstOrThrow({ where: { code: "5050" } });
    expect(await archiveProduct({ id: p.productId, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await updateUnit({ id: carton.id, expectedVersion: 1, name: "ك" }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await archiveUnit({ id: carton.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await archiveBarcode({ id: bc.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });

    // An archived variant of an active product.
    const shirt = await product(a, { nameAr: "قميص", options: { size: "M" } });
    const v = await addVariant(
      { productId: shirt.productId, options: { size: "L" }, baseUnit: piece(["6060"]), extraUnits: [{ name: "دزينة", factor: 12 }] },
      a.as("stock"),
    );
    if (!v.ok) throw new Error("variant");
    expect(await archiveVariant({ variantId: v.value.variantId, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
    const dozen = await db.rtUnit.findFirstOrThrow({ where: { variantId: v.value.variantId, isBase: false } });
    const code = await db.rtBarcode.findFirstOrThrow({ where: { code: "6060" } });
    expect(await updateUnit({ id: dozen.id, expectedVersion: 1, name: "ك" }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await archiveUnit({ id: dozen.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await archiveBarcode({ id: code.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("a stock officer sending a price in addVariant or an extra unit amount is FORBIDDEN and nothing is created", async () => {
    const { a } = await world();
    const shirt = await product(a, { nameAr: "قميص", options: { size: "M" } });
    expect(
      await addVariant({ productId: shirt.productId, options: { size: "L" }, baseUnit: piece(["7070"]), price: { currency: "IQD", amountMinor: 5000n } }, a.as("stock")),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(
      await createProduct({ nameAr: "بنطال", baseUnit: piece(["7171"]), extraUnits: [{ name: "دزينة", factor: 12, amountMinor: 50000n }] }, a.as("stock")),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await db.rtVariant.count({ where: { businessId: a.business.id } })).toBe(1);
    expect(await db.rtProduct.count({ where: { businessId: a.business.id } })).toBe(1);
    expect(await db.rtBarcode.count({ where: { businessId: a.business.id } })).toBe(0);
    expect(await db.rtPrice.count({ where: { businessId: a.business.id } })).toBe(0);
  });

  it("updateProduct with a foreign category or brand is NOT_FOUND", async () => {
    const { a, b } = await world();
    const foreignCat = await createCategory({ nameAr: "قسم ب" }, b.as("stock"));
    const foreignBrand = await createBrand({ nameAr: "علامة ب" }, b.as("stock"));
    if (!foreignCat.ok || !foreignBrand.ok) throw new Error("taxonomy");
    const p = await product(a, { nameAr: "صنف" });
    expect(await updateProduct({ id: p.productId, expectedVersion: 1, categoryId: foreignCat.value.id }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await updateProduct({ id: p.productId, expectedVersion: 1, brandId: foreignBrand.value.id }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await db.rtProduct.findUniqueOrThrow({ where: { id: p.productId } })).toMatchObject({ categoryId: null, brandId: null, version: 1 });
  });

  it("archiveVariant keeps SKU and barcodes reserved, refreshes search text and refuses the last active variant", async () => {
    const { a, b } = await world();
    const shirt = await product(a, { nameAr: "قميص", options: { size: "M" }, baseUnit: piece(["8181"]) });
    const large = await addVariant({ productId: shirt.productId, options: { size: "L" }, baseUnit: piece(["8282"]) }, a.as("stock"));
    if (!large.ok) throw new Error("variant");

    expect(await archiveVariant({ variantId: large.value.variantId, expectedVersion: 1 }, a.as("cashier"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await archiveVariant({ variantId: large.value.variantId, expectedVersion: 1 }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await archiveVariant({ variantId: large.value.variantId, expectedVersion: 1 }, a.as("stock"))).toMatchObject({
      ok: true,
      value: { id: large.value.variantId, version: 2 },
    });
    expect(await archiveVariant({ variantId: large.value.variantId, expectedVersion: 2 }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    // Its SKU and barcode stay reserved.
    expect(await createProduct({ nameAr: "x", sku: large.value.sku, baseUnit: piece() }, a.as("stock"))).toMatchObject({ ok: false, code: "SKU_TAKEN" });
    expect(await createProduct({ nameAr: "x", baseUnit: piece(["8282"]) }, a.as("stock"))).toMatchObject({ ok: false, code: "BARCODE_TAKEN" });
    // The product's search text no longer carries the archived variant's SKU.
    const prod = await db.rtProduct.findUniqueOrThrow({ where: { id: shirt.productId } });
    expect(prod.searchText).not.toContain(normalizeSearchText(large.value.sku));
    expect(prod.searchText).toContain(normalizeSearchText(shirt.sku));
    // The same option set can be added again once archived.
    expect(await addVariant({ productId: shirt.productId, options: { size: "L" }, baseUnit: piece() }, a.as("stock"))).toMatchObject({ ok: true });

    // The last active variant cannot be archived: archive the product instead.
    const single = await product(a, { nameAr: "وحيد" });
    expect(await archiveVariant({ variantId: single.variantId, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "LAST_VARIANT" });
    expect(await db.rtVariant.findUniqueOrThrow({ where: { id: single.variantId } })).toMatchObject({ archivedAt: null, version: 1 });
    // Archived product: refused too.
    expect(await archiveProduct({ id: shirt.productId, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await archiveVariant({ variantId: shirt.variantId, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

const lockedAction = defineAction({
  name: "test.unit.locked",
  permission: null,
  input: z.object({ unitId: z.string() }),
  writes: false,
  run: ({ tx, input }) => unitIsLocked(tx, input.unitId),
});

async function locked(w: Shop, unitId: string): Promise<boolean> {
  const r = await lockedAction({ unitId }, w.as("owner"));
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

describe("locks after stock movements", () => {
  /** Posts `quantity` pieces of the variant as an opening or a receipt; a draft is saved but not posted when `postIt` is false. */
  async function stockIn(w: Shop, p: { variantId: string; baseUnitId: string }, opts: { postIt: boolean; batch?: boolean; kind?: "OPENING" | "RECEIPT" }) {
    const branch = await db.rtBranch.findFirstOrThrow({ where: { businessId: w.business.id } });
    if ((await db.rtLocation.count({ where: { businessId: w.business.id } })) === 0) {
      await db.rtLocation.create({ data: { businessId: w.business.id, branchId: branch.id, name: "المخزن الرئيسي" } });
    }
    const expiryDate = new Date(Date.now() + 90 * DAY).toISOString().slice(0, 10);
    const d = await saveStockDraft(
      {
        kind: opts.kind ?? "RECEIPT",
        lines: [
          {
            variantId: p.variantId,
            unitId: p.baseUnitId,
            quantity: "5",
            cost: { amount: "100", currency: "IQD" },
            ...(opts.batch ? { batchCode: "B1", expiryDate } : {}),
          },
        ],
      },
      w.as("owner"),
    );
    if (!d.ok) throw new Error(`draft refused: ${d.code}`);
    if (!opts.postIt) return;
    const r = await postStockDocument({ documentId: d.value.documentId, expectedVersion: d.value.version }, w.as("owner"));
    if (!r.ok) throw new Error(`post refused: ${r.code}`);
  }

  it("a unit with movements cannot change factor, and tracking and expiry flags are locked", async () => {
    const { a } = await world();
    const p = await product(a, { nameAr: "سكر", extraUnits: [{ name: "كيس", factor: 10 }] });
    const bag = await db.rtUnit.findFirstOrThrow({ where: { variantId: p.variantId, isBase: false } });

    // A draft is not a movement: nothing is locked yet.
    await stockIn(a, p, { postIt: false });
    expect(await locked(a, bag.id)).toBe(false);
    expect(await updateUnit({ id: bag.id, expectedVersion: 1, factor: 12 }, a.as("stock"))).toMatchObject({ ok: true, value: { factor: 12, version: 2 } });
    expect(await updateProduct({ id: p.productId, expectedVersion: 1, trackingMode: "BATCH", tracksExpiry: true, expiryAlertDays: 7 }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await updateProduct({ id: p.productId, expectedVersion: 2, trackingMode: "NONE", tracksExpiry: false, expiryAlertDays: null }, a.as("stock"))).toMatchObject({ ok: true });

    // After the first posted movement the factor and both flags are fixed.
    await stockIn(a, p, { postIt: true });
    expect(await locked(a, bag.id)).toBe(true);
    expect(await locked(a, p.baseUnitId)).toBe(true);
    expect(await updateUnit({ id: bag.id, expectedVersion: 2, factor: 24 }, a.as("stock"))).toMatchObject({ ok: false, code: "UNIT_RULE" });
    expect(await updateUnit({ id: p.baseUnitId, expectedVersion: 1, factor: 2 }, a.as("stock"))).toMatchObject({ ok: false, code: "UNIT_RULE" });
    expect(await db.rtUnit.findUniqueOrThrow({ where: { id: bag.id } })).toMatchObject({ factor: 12 });
    expect(await updateProduct({ id: p.productId, expectedVersion: 3, trackingMode: "BATCH" }, a.as("stock"))).toMatchObject({ ok: false, code: "TRACKING_RULE" });
    expect(await updateProduct({ id: p.productId, expectedVersion: 3, trackingMode: "BATCH", tracksExpiry: true }, a.as("stock"))).toMatchObject({ ok: false, code: "TRACKING_RULE" });
    // Unchanged flags, a rename, a name for the unit, a new carton and archiving a non-base unit stay open.
    expect(await updateProduct({ id: p.productId, expectedVersion: 3, nameAr: "سكر ناعم", trackingMode: "NONE", tracksExpiry: false }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await updateUnit({ id: bag.id, expectedVersion: 2, name: "كيس كبير", factor: 12 }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await addUnit({ variantId: p.variantId, name: "كرتون", factor: 40 }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await archiveUnit({ id: bag.id, expectedVersion: 3 }, a.as("stock"))).toMatchObject({ ok: true });

    // Another product of the business, with no movements, is still free.
    const other = await product(a, { nameAr: "رز", extraUnits: [{ name: "كيس", factor: 10 }] });
    const otherBag = await db.rtUnit.findFirstOrThrow({ where: { variantId: other.variantId, isBase: false } });
    expect(await updateUnit({ id: otherBag.id, expectedVersion: 1, factor: 20 }, a.as("stock"))).toMatchObject({ ok: true });
    expect(await updateProduct({ id: other.productId, expectedVersion: 1, trackingMode: "BATCH", tracksExpiry: true }, a.as("stock"))).toMatchObject({ ok: true });

    // A batch product with stock keeps BATCH and its expiry flag, and cannot lose decimals.
    const milk = await product(a, { nameAr: "حليب", trackingMode: "BATCH", tracksExpiry: true, baseUnit: { name: "لتر", quantityScale: 3 } });
    await stockIn(a, milk, { postIt: true, batch: true });
    expect(await updateProduct({ id: milk.productId, expectedVersion: 1, tracksExpiry: false }, a.as("stock"))).toMatchObject({ ok: false, code: "TRACKING_RULE" });
    expect(await updateProduct({ id: milk.productId, expectedVersion: 1, trackingMode: "NONE", tracksExpiry: false }, a.as("stock"))).toMatchObject({ ok: false, code: "TRACKING_RULE" });
    expect(await updateUnit({ id: milk.baseUnitId, expectedVersion: 1, quantityScale: 0 }, a.as("stock"))).toMatchObject({ ok: false, code: "UNIT_RULE" });
    expect(await updateUnit({ id: milk.baseUnitId, expectedVersion: 1, quantityScale: 3 }, a.as("stock"))).toMatchObject({ ok: true });
  });
});
