import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { BRANCH_SCOPED_MODELS, BUSINESS_SCOPED_MODELS } from "@/server/framework/scoped-db";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff } from "../helpers/fixtures";

const { db } = useTestDb();

const CATALOG_MODELS = [
  "RtCategory",
  "RtBrand",
  "RtProduct",
  "RtVariant",
  "RtUnit",
  "RtBarcode",
  "RtPriceList",
  "RtPrice",
  "RtCatalogCounter",
];

const at = (iso: string) => new Date(iso);

/** The error a promise rejects with, as text (message, code and meta), so a test can name the constraint. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return JSON.stringify(e, Object.getOwnPropertyNames(e));
  }
  throw new Error("expected the database to refuse this write");
}

async function business() {
  return (await createBusinessWithStaff(db)).business;
}

let skuSeq = 0;

/** A product with one variant and its base unit (factor 1). */
async function product(client: PrismaClient, businessId: string, sku = `SKU-${++skuSeq}`) {
  const p = await client.rtProduct.create({ data: { businessId, nameAr: "حليب" } });
  const variant = await client.rtVariant.create({ data: { businessId, productId: p.id, sku } });
  const base = await client.rtUnit.create({
    data: { businessId, variantId: variant.id, name: "حبة", factor: 1, isBase: true },
  });
  return { product: p, variant, base };
}

async function priceList(businessId: string, kind: "DEFAULT" | "WHOLESALE" = "DEFAULT") {
  return db.rtPriceList.create({ data: { businessId, name: kind === "DEFAULT" ? "مفرد" : "جملة", kind } });
}

describe("catalog schema", () => {
  it("applies defaults and keeps a barcode's leading zeros", async () => {
    const b = await business();
    const { product: p, variant, base } = await product(db, b.id);
    expect(p).toMatchObject({
      trackingMode: "NONE",
      soldByWeight: false,
      tracksExpiry: false,
      expiryAlertDays: null,
      searchText: "",
      archivedAt: null,
      version: 1,
    });
    expect(variant).toMatchObject({ options: null, searchText: "", archivedAt: null, version: 1 });
    expect(base).toMatchObject({ quantityScale: 0, archivedAt: null, version: 1 });
    const code = await db.rtBarcode.create({ data: { businessId: b.id, unitId: base.id, code: "0012345" } });
    expect(code.code).toBe("0012345");
    const counter = await db.rtCatalogCounter.create({ data: { businessId: b.id } });
    expect(counter.nextSku).toBe(1);
    await expect(db.rtCatalogCounter.create({ data: { businessId: b.id } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("barcode is unique per business across units and variants, archived ones included", async () => {
    const b = await business();
    const milk = await product(db, b.id);
    const carton = await db.rtUnit.create({
      data: { businessId: b.id, variantId: milk.variant.id, name: "كرتون", factor: 24, isBase: false },
    });
    const juice = await product(db, b.id);
    await db.rtBarcode.create({ data: { businessId: b.id, unitId: milk.base.id, code: "6260001" } });

    // Another unit of the same variant, and a unit of another product.
    for (const unitId of [carton.id, juice.base.id]) {
      await expect(
        db.rtBarcode.create({ data: { businessId: b.id, unitId, code: "6260001" } }),
      ).rejects.toMatchObject({ code: "P2002" });
    }

    // An archived barcode stays reserved.
    await db.rtBarcode.create({
      data: { businessId: b.id, unitId: carton.id, code: "6260002", archivedAt: new Date() },
    });
    await expect(
      db.rtBarcode.create({ data: { businessId: b.id, unitId: juice.base.id, code: "6260002" } }),
    ).rejects.toMatchObject({ code: "P2002" });
    // Leading zeros are significant: "06260001" is another code.
    await db.rtBarcode.create({ data: { businessId: b.id, unitId: juice.base.id, code: "06260001" } });
    expect(await db.rtBarcode.count({ where: { businessId: b.id } })).toBe(3);
  });

  it("the same code can exist in two different businesses", async () => {
    const a = await business();
    const other = await business();
    const inA = await product(db, a.id);
    const inB = await product(db, other.id);
    await db.rtBarcode.create({ data: { businessId: a.id, unitId: inA.base.id, code: "6260001" } });
    await db.rtBarcode.create({ data: { businessId: other.id, unitId: inB.base.id, code: "6260001" } });
    expect(await db.rtBarcode.count({ where: { code: "6260001" } })).toBe(2);
  });

  it("a catalog row can never point at another business's rows", async () => {
    const a = await business();
    const other = await business();
    const inB = await product(db, other.id);
    const listB = await priceList(other.id);
    const listA = await priceList(a.id);
    const inA = await product(db, a.id);

    await expect(
      db.rtUnit.create({ data: { businessId: a.id, variantId: inB.variant.id, name: "x", factor: 2, isBase: false } }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      db.rtVariant.create({ data: { businessId: a.id, productId: inB.product.id, sku: "CROSS" } }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      db.rtBarcode.create({ data: { businessId: a.id, unitId: inB.base.id, code: "1" } }),
    ).rejects.toMatchObject({ code: "P2003" });
    const price = { currency: "IQD" as const, amountMinor: 1000n, validFrom: at("2026-01-01T00:00:00Z") };
    await expect(
      db.rtPrice.create({ data: { ...price, businessId: a.id, unitId: inB.base.id, priceListId: listA.id } }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      db.rtPrice.create({ data: { ...price, businessId: a.id, unitId: inA.base.id, priceListId: listB.id } }),
    ).rejects.toMatchObject({ code: "P2003" });

    const catB = await db.rtCategory.create({ data: { businessId: other.id, nameAr: "ألبان" } });
    const brandB = await db.rtBrand.create({ data: { businessId: other.id, nameAr: "المراعي" } });
    await expect(
      db.rtCategory.create({ data: { businessId: a.id, nameAr: "فرعي", parentId: catB.id } }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      db.rtProduct.create({ data: { businessId: a.id, nameAr: "x", categoryId: catB.id } }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      db.rtProduct.create({ data: { businessId: a.id, nameAr: "x", brandId: brandB.id } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("two open price periods for one unit, list and currency are refused by the database", async () => {
    const b = await business();
    const { base } = await product(db, b.id);
    const list = await priceList(b.id);
    const row = { businessId: b.id, unitId: base.id, priceListId: list.id, amountMinor: 1000n };
    await db.rtPrice.create({ data: { ...row, currency: "IQD", validFrom: at("2026-01-01T00:00:00Z") } });

    expect(
      await failure(
        db.rtPrice.create({ data: { ...row, currency: "IQD", validFrom: at("2026-06-01T00:00:00Z") } }),
      ),
    ).toContain("RtPrice_no_overlap");

    // Another currency, or another list, has its own open period.
    await db.rtPrice.create({ data: { ...row, currency: "USD", validFrom: at("2026-06-01T00:00:00Z") } });
    const wholesale = await priceList(b.id, "WHOLESALE");
    await db.rtPrice.create({
      data: { ...row, priceListId: wholesale.id, currency: "IQD", validFrom: at("2026-06-01T00:00:00Z") },
    });
    expect(await db.rtPrice.count({ where: { validTo: null } })).toBe(3);
  });

  it("overlapping price periods are refused", async () => {
    const b = await business();
    const { base } = await product(db, b.id);
    const list = await priceList(b.id);
    const row = { businessId: b.id, unitId: base.id, priceListId: list.id, currency: "IQD" as const, amountMinor: 1000n };
    await db.rtPrice.create({
      data: { ...row, validFrom: at("2026-01-01T00:00:00Z"), validTo: at("2026-03-01T00:00:00Z") },
    });

    // Overlaps the closed period from inside, from the left, and as an open period starting inside it.
    for (const [from, to] of [
      ["2026-02-01T00:00:00Z", "2026-02-10T00:00:00Z"],
      ["2025-12-01T00:00:00Z", "2026-01-02T00:00:00Z"],
      ["2026-02-28T00:00:00Z", null],
    ] as const) {
      expect(
        await failure(
          db.rtPrice.create({ data: { ...row, validFrom: at(from), validTo: to === null ? null : at(to) } }),
        ),
      ).toContain("RtPrice_no_overlap");
    }

    // Periods are half-open [validFrom, validTo): the next one may start exactly where the last ended.
    await db.rtPrice.create({ data: { ...row, amountMinor: 1250n, validFrom: at("2026-03-01T00:00:00Z") } });
    // A period must end after it starts.
    expect(
      await failure(
        db.rtPrice.create({
          data: { ...row, validFrom: at("2025-06-01T00:00:00Z"), validTo: at("2025-06-01T00:00:00Z") },
        }),
      ),
    ).toContain("RtPrice_valid_to_after_from");
    expect(await db.rtPrice.count()).toBe(2);
  });

  it("amountMinor must be non-negative; factor must be positive; exactly one base unit with factor 1 per variant", async () => {
    const b = await business();
    const { variant, base } = await product(db, b.id);
    const list = await priceList(b.id);
    const price = { businessId: b.id, unitId: base.id, priceListId: list.id, currency: "IQD" as const };

    expect(
      await failure(db.rtPrice.create({ data: { ...price, amountMinor: -1n, validFrom: at("2026-01-01T00:00:00Z") } })),
    ).toContain("RtPrice_amount_nonneg");
    // Zero is a valid price (a free item).
    await db.rtPrice.create({ data: { ...price, amountMinor: 0n, validFrom: at("2026-01-01T00:00:00Z") } });

    const unit = { businessId: b.id, variantId: variant.id, name: "كرتون", isBase: false };
    for (const factor of [0, -24]) {
      expect(await failure(db.rtUnit.create({ data: { ...unit, factor } }))).toContain("RtUnit_factor_positive");
    }
    // A second base unit for the same variant.
    await expect(
      db.rtUnit.create({ data: { ...unit, name: "قطعة", factor: 1, isBase: true } }),
    ).rejects.toMatchObject({ code: "P2002" });
    // A base unit with a factor other than 1 (on a fresh variant, so only the CHECK can refuse it).
    const other = await db.rtVariant.create({ data: { businessId: b.id, productId: variant.productId, sku: "SKU-B2" } });
    expect(
      await failure(db.rtUnit.create({ data: { ...unit, variantId: other.id, factor: 6, isBase: true } })),
    ).toContain("RtUnit_base_factor_one");
    // Quantity precision is 0..3 decimal places.
    for (const quantityScale of [-1, 4]) {
      expect(await failure(db.rtUnit.create({ data: { ...unit, factor: 6, quantityScale } }))).toContain(
        "RtUnit_quantity_scale_range",
      );
    }
    await db.rtUnit.create({ data: { ...unit, factor: 24 } });
    await db.rtUnit.create({ data: { ...unit, variantId: other.id, name: "كغم", factor: 1, isBase: true, quantityScale: 3 } });
    expect(await db.rtUnit.count({ where: { isBase: true } })).toBe(2);
  });

  it("tracksExpiry requires trackingMode BATCH", async () => {
    const b = await business();
    const row = { businessId: b.id, nameAr: "لبن" };
    for (const trackingMode of ["NONE", "SERIAL"] as const) {
      expect(
        await failure(db.rtProduct.create({ data: { ...row, trackingMode, tracksExpiry: true } })),
      ).toContain("RtProduct_expiry_needs_batch");
    }
    expect(
      await failure(
        db.rtProduct.create({ data: { ...row, trackingMode: "BATCH", tracksExpiry: true, expiryAlertDays: 0 } }),
      ),
    ).toContain("RtProduct_expiry_alert_days_positive");
    const ok = await db.rtProduct.create({
      data: { ...row, trackingMode: "BATCH", tracksExpiry: true, expiryAlertDays: 14 },
    });
    expect(ok).toMatchObject({ trackingMode: "BATCH", tracksExpiry: true, expiryAlertDays: 14 });
  });

  it("SKU is unique per business", async () => {
    const a = await business();
    const other = await business();
    await product(db, a.id, "SKU-000001");
    const p = await db.rtProduct.create({ data: { businessId: a.id, nameAr: "عصير" } });
    await expect(
      db.rtVariant.create({ data: { businessId: a.id, productId: p.id, sku: "SKU-000001" } }),
    ).rejects.toMatchObject({ code: "P2002" });
    // Another business may use the same SKU.
    await product(db, other.id, "SKU-000001");
  });

  it("at most one price list of each kind per business", async () => {
    const a = await business();
    const other = await business();
    await priceList(a.id, "DEFAULT");
    await priceList(a.id, "WHOLESALE");
    await expect(priceList(a.id, "DEFAULT")).rejects.toMatchObject({ code: "P2002" });
    await priceList(other.id, "DEFAULT");
  });

  it("the migration installs btree_gist and pg_trgm and indexes searchText with trigrams", async () => {
    const ext = await db.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname IN ('btree_gist', 'pg_trgm') ORDER BY extname`;
    expect(ext.map((e) => e.extname)).toEqual(["btree_gist", "pg_trgm"]);
    const idx = await db.$queryRaw<{ tablename: string; indexdef: string }[]>`
      SELECT tablename, indexdef FROM pg_indexes
      WHERE tablename IN ('RtProduct', 'RtVariant') AND indexdef LIKE '%gin_trgm_ops%' ORDER BY tablename`;
    expect(idx.map((i) => i.tablename)).toEqual(["RtProduct", "RtVariant"]);
    const staff = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'RtStaff' AND indexname = 'RtStaff_userId_idx'`;
    expect(staff).toHaveLength(1);
  });

  it("every new model is classified in scoped-db", () => {
    expect(BUSINESS_SCOPED_MODELS).toEqual(expect.arrayContaining(CATALOG_MODELS));
    // The catalog is business-level: no catalog model is branch-scoped.
    for (const model of CATALOG_MODELS) expect(BRANCH_SCOPED_MODELS).not.toContain(model);
  });
});
