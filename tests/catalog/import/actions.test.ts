import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// Every real role that holds catalog.import also holds price.change, so the "without price.change"
// path is reached by withholding that one permission while `flags.denyPrice` is set.
const flags = vi.hoisted(() => ({ denyPrice: false }));
vi.mock("@/server/domain/permissions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/domain/permissions")>();
  return { ...real, can: (role: Parameters<typeof real.can>[0], p: Parameters<typeof real.can>[1]) => (flags.denyPrice && p === "price.change" ? false : real.can(role, p)) };
});

import {
  MAX_BASE64_LENGTH,
  SLICE_SIZE,
  commitImport,
  commitImportSlice,
  deleteImportBatch,
  deleteMappingPreset,
  downloadRejected,
  getImportBatch,
  listImportBatches,
  listMappingPresets,
  neutralizeCell,
  purgeStaleImportBatches,
  saveMappingPreset,
  stageImport,
  validateImport,
} from "@/server/catalog/import/actions";
import { autoMapHeaders } from "@/server/catalog/import/mapping";
import { setPrice } from "@/server/catalog/prices";
import { createProduct, getProduct, updateProduct } from "@/server/catalog/products";
import { searchCatalog } from "@/server/catalog/search";
import { createCategory } from "@/server/catalog/taxonomy";
import { useTestDb } from "../../helpers/db";
import { createBusinessWithStaff, createPlan } from "../../helpers/fixtures";

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
  await db.rtBusiness.update({
    where: { id: w.business.id },
    data: { status: "ACTIVE", name: label, defaultCurrency: "IQD", enabledCurrencies: ["IQD", "USD"] },
  });
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

const HEADERS = ["الباركود", "الاسم", "القسم", "الماركة", "الوحدة", "معامل", "السعر", "العملة", "SKU"];

/** A CSV file (UTF-8) from rows of cells; cells with a comma, quote or newline are quoted. */
function csv(rows: string[][], headers = HEADERS): string {
  const cell = (c: string) => (/[",\r\n\t]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\n");
}
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** One row: barcode, name, category, brand, unit, factor, price, currency, sku. */
const row = (o: Partial<Record<"barcode" | "name" | "category" | "brand" | "unit" | "factor" | "price" | "currency" | "sku", string>>) => [
  o.barcode ?? "",
  o.name ?? "",
  o.category ?? "",
  o.brand ?? "",
  o.unit ?? "",
  o.factor ?? "",
  o.price ?? "",
  o.currency ?? "",
  o.sku ?? "",
];

function value<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
  return r.value;
}

async function stage(w: Shop, text: string, who = "owner", fileName = "items.csv") {
  return value(await stageImport({ fileName, contentBase64: b64(text) }, w.as(who)));
}

async function stageAndValidate(w: Shop, text: string, who = "owner") {
  const staged = await stage(w, text, who);
  const validated = value(await validateImport({ batchId: staged.batchId, mapping: staged.suggestedMapping }, w.as(who)));
  return { ...staged, ...validated };
}

const productCount = (w: Shop) => db.rtProduct.count({ where: { businessId: w.business.id } });

async function existing(w: Shop, nameAr: string, code: string, amountMinor?: bigint) {
  return value(
    await createProduct(
      { nameAr, baseUnit: { name: "حبة", barcodes: [code] }, ...(amountMinor !== undefined ? { price: { currency: "IQD", amountMinor } } : {}) },
      w.as("owner"),
    ),
  );
}

describe("catalog import actions", () => {
  it("importing 1200 rows with mixed errors saves only the valid ones and keeps the rest with reasons", async () => {
    const { a } = await world();
    await existing(a, "حليب قديم", "6290000000001", 1000n);
    const rows: string[][] = [];
    const expected = { ok: 0, rejected: 0, changed: 0 };
    for (let i = 1; i <= 1200; i += 1) {
      const code = `62810${String(i).padStart(8, "0")}`;
      if (i === 1) {
        rows.push(row({ barcode: "6290000000001", name: "حليب جديد", price: "1000" })); // CHANGED (name)
        expected.changed += 1;
      } else if (i % 50 === 0) {
        rows.push(row({ barcode: code, name: `صنف ${i}`, price: "-5" })); // NEGATIVE_PRICE
        expected.rejected += 1;
      } else if (i % 50 === 1) {
        rows.push(row({ barcode: code, name: `صنف ${i}`, price: "10", currency: "EUR" })); // UNKNOWN_CURRENCY
        expected.rejected += 1;
      } else if (i % 50 === 2) {
        rows.push(row({ barcode: code, name: "", price: "10" })); // MISSING_NAME
        expected.rejected += 1;
      } else if (i % 50 === 5) {
        rows.push(row({ barcode: `62810${String(i - 1).padStart(8, "0")}`, name: `مكرر ${i}`, price: "10" })); // DUPLICATE_IN_FILE (row i-1 is valid)
        expected.rejected += 1;
      } else {
        rows.push(
          row({
            barcode: code,
            name: `صنف ${i}`,
            category: i % 3 === 0 ? "ألبان" : "معلبات",
            brand: i % 2 ? "المراعي" : "",
            price: String(250 * (i % 7) + 250),
            unit: i % 10 === 4 ? "كرتون" : "",
            factor: i % 10 === 4 ? "24" : "",
            sku: i % 5 === 0 ? `IMP-${i}` : "",
          }),
        );
        expected.ok += 1;
      }
    }
    const started = Date.now();
    const v = await stageAndValidate(a, csv(rows));
    const validatedAt = Date.now();
    expect(v.rowCount).toBe(1200);
    expect(v.summary).toEqual({ ok: expected.ok, changed: expected.changed, skipped: 0, rejected: expected.rejected, total: 1200 });
    expect(v.firstRejected).toHaveLength(50);
    expect(new Set(v.firstRejected.map((r) => r.reason))).toEqual(new Set(["NEGATIVE_PRICE", "UNKNOWN_CURRENCY", "MISSING_NAME", "DUPLICATE_IN_FILE"]));

    const c = value(await commitImport({ batchId: v.batchId, onChange: "SKIP" }, a.as("owner")));
    const committedAt = Date.now();
    console.info(`[import 1200 rows] stage+validate ${validatedAt - started} ms, commit ${committedAt - validatedAt} ms`);
    expect(c).toEqual({
      alreadyCommitted: false,
      stats: {
        total: 1200,
        created: expected.ok,
        updated: 0,
        priceNotPermitted: 0,
        priceNotApplied: 0,
        // Carton rows (factor 24) make a base piece without a price: reported, not hidden.
        withoutBasePrice: rows.filter((r) => r[5] === "24").length,
        skipped: expected.changed,
        rejected: expected.rejected,
      },
    });

    expect(await productCount(a)).toBe(expected.ok + 1);
    expect(await db.rtCategory.count({ where: { businessId: a.business.id } })).toBe(2);
    expect(await db.rtBrand.count({ where: { businessId: a.business.id } })).toBe(1);
    // The CHANGED row was skipped (no choice made for it): the old name stays.
    expect(await db.rtProduct.count({ where: { businessId: a.business.id, nameAr: "حليب قديم" } })).toBe(1);
    // Every new product has a variant, a base unit, its barcode and a DEFAULT price.
    expect(await db.rtVariant.count({ where: { businessId: a.business.id } })).toBe(expected.ok + 1);
    expect(await db.rtBarcode.count({ where: { businessId: a.business.id } })).toBe(expected.ok + 1);
    expect(await db.rtPrice.count({ where: { businessId: a.business.id } })).toBe(expected.ok + 1);
    expect(await db.rtVariant.count({ where: { businessId: a.business.id, sku: { startsWith: "IMP-" } } })).toBe(
      rows.filter((r) => r[8]!.startsWith("IMP-")).length,
    );
    // A row with a factor makes a base piece plus the carton, which carries the barcode and the price.
    const carton = await db.rtBarcode.findFirstOrThrow({ where: { businessId: a.business.id, code: "6281000000004" }, include: { unit: true } });
    expect(carton.unit).toMatchObject({ name: "كرتون", factor: 24, isBase: false });
    const cartonPrice = await db.rtPrice.findFirstOrThrow({ where: { unitId: carton.unitId } });
    expect(cartonPrice.amountMinor).toBe(250n * 4n + 250n);
    expect(await db.rtUnit.count({ where: { variantId: carton.unit.variantId } })).toBe(2);

    // The rejected rows stay in the batch with their reasons; the rest are COMMITTED.
    const batchRows = await db.rtImportRow.groupBy({ by: ["status"], where: { batchId: v.batchId }, _count: true });
    expect(Object.fromEntries(batchRows.map((r) => [r.status, r._count]))).toEqual({
      COMMITTED: expected.ok,
      REJECTED: expected.rejected,
      CHANGED: expected.changed,
    });
    const rejected = value(await getImportBatch({ batchId: v.batchId, status: "REJECTED" }, a.as("owner")));
    expect(rejected).toMatchObject({ status: "COMMITTED", rowCount: expected.rejected });
    expect(rejected.rows).toHaveLength(50);
    expect(rejected.rows.every((r) => r.reason)).toBe(true);
    const file = value(await downloadRejected({ batchId: v.batchId }, a.as("owner")));
    expect(file.trimEnd().split("\r\n")).toHaveLength(expected.rejected + 1);

    // The audit holds counts, not cells.
    const audit = await db.rtAuditLog.findMany({ where: { businessId: a.business.id, action: { startsWith: "catalog.import" } } });
    expect(audit.map((x) => x.action)).toContain("catalog.import.stage");
    expect(audit.filter((x) => x.action === "catalog.import.commit").length).toBe(Math.ceil(expected.ok / SLICE_SIZE) + 1);
    expect(JSON.stringify(audit.map((x) => x.changes))).not.toContain("صنف 4");
  }, 120_000);

  it("uploading the same file again changes nothing", async () => {
    const { a } = await world();
    const text = csv([
      row({ barcode: "0012345", name: "قلم", category: "قرطاسية", price: "500" }),
      row({ sku: "NOTE-1", name: "دفتر", brand: "سنان", price: "2.50", currency: "USD" }),
      row({ barcode: "6281111111111", name: "ممحاة" }),
    ]);
    const first = await stageAndValidate(a, text);
    expect(first.summary).toMatchObject({ ok: 3 });
    value(await commitImport({ batchId: first.batchId, onChange: "SKIP" }, a.as("owner")));
    const snapshot = async () => ({
      products: await db.rtProduct.findMany({ where: { businessId: a.business.id }, select: { id: true, nameAr: true, version: true, categoryId: true, brandId: true } }),
      prices: await db.rtPrice.count({ where: { businessId: a.business.id } }),
      codes: await db.rtBarcode.findMany({ where: { businessId: a.business.id }, select: { code: true } }),
      categories: await db.rtCategory.count({ where: { businessId: a.business.id } }),
    });
    const before = await snapshot();
    expect(before.codes.map((c) => c.code).sort()).toEqual(["0012345", "6281111111111"]);

    const again = await stageAndValidate(a, text);
    expect(again.sameFileBatchId).toBe(first.batchId);
    expect(again.summary).toEqual({ ok: 0, changed: 0, skipped: 3, rejected: 0, total: 3 });
    const rows = await db.rtImportRow.findMany({ where: { batchId: again.batchId } });
    expect(rows.every((r) => r.reason === "UNCHANGED" && r.matchedVariantId)).toBe(true);
    const c = value(await commitImport({ batchId: again.batchId, onChange: "UPDATE" }, a.as("owner")));
    expect(c.stats).toMatchObject({ created: 0, updated: 0, skipped: 3 });
    expect(await snapshot()).toEqual(before);
  });

  it("two commits of one batch create nothing the second time", async () => {
    const { a } = await world();
    const v = await stageAndValidate(a, csv([row({ barcode: "111", name: "واحد" }), row({ barcode: "222", name: "اثنان" })]));
    const k = key();
    const first = value(await commitImport({ batchId: v.batchId, onChange: "SKIP" }, a.as("owner", k)));
    expect(first).toMatchObject({ alreadyCommitted: false, stats: { created: 2 } });
    // The same request again (same key) and a new request (new key): nothing more is created.
    expect(value(await commitImport({ batchId: v.batchId, onChange: "SKIP" }, a.as("owner", k)))).toMatchObject({ stats: { created: 2 } });
    const second = value(await commitImport({ batchId: v.batchId, onChange: "UPDATE" }, a.as("manager")));
    expect(second).toEqual({ alreadyCommitted: true, stats: first.stats });
    expect(await productCount(a)).toBe(2);
    // Two commits racing on the same batch: the batch lock queues them, one does the work.
    const v2 = await stageAndValidate(a, csv([row({ barcode: "333", name: "ثلاثة" })]));
    const raced = await Promise.all([
      commitImport({ batchId: v2.batchId, onChange: "SKIP" }, a.as("owner")),
      commitImport({ batchId: v2.batchId, onChange: "SKIP" }, a.as("manager")),
    ]);
    expect(raced.every((r) => r.ok)).toBe(true);
    expect(await productCount(a)).toBe(3);
    // A batch that was never validated cannot be committed.
    const staged = await stage(a, csv([row({ barcode: "444", name: "أربعة" })]));
    expect(await commitImport({ batchId: staged.batchId, onChange: "SKIP" }, a.as("owner"))).toMatchObject({ ok: false, code: "IMPORT_NOT_VALIDATED" });
  });

  it("a crash after one slice, then a retry, resumes without duplicates", async () => {
    const { a } = await world();
    const rows = Array.from({ length: 250 }, (_, i) => row({ barcode: `9${String(i).padStart(7, "0")}`, name: `صنف ${i}`, price: "100" }));
    const v = await stageAndValidate(a, csv(rows));
    // Only the first slice runs, as if the server stopped after it.
    expect(value(await commitImportSlice({ batchId: v.batchId, onChange: "SKIP" }, a.as("owner")))).toMatchObject({ done: false, created: SLICE_SIZE });
    expect(await productCount(a)).toBe(SLICE_SIZE);
    expect(await db.rtImportBatch.findUniqueOrThrow({ where: { id: v.batchId } })).toMatchObject({ status: "VALIDATED" });
    // Re-validating now would change rows that are already in the catalog.
    expect(await validateImport({ batchId: v.batchId, mapping: v.suggestedMapping }, a.as("owner"))).toMatchObject({ ok: false, code: "IMPORT_ALREADY_COMMITTED" });
    const c = value(await commitImport({ batchId: v.batchId, onChange: "SKIP" }, a.as("owner")));
    expect(c.stats).toMatchObject({ created: 250, rejected: 0 });
    expect(await productCount(a)).toBe(250);
    expect(await db.rtBarcode.count({ where: { businessId: a.business.id } })).toBe(250);
    const skus = await db.rtVariant.findMany({ where: { businessId: a.business.id }, select: { sku: true } });
    expect(new Set(skus.map((s) => s.sku)).size).toBe(250);
  });

  it("CHANGED rows are only applied when the user chose UPDATE", async () => {
    const { a } = await world();
    const p1 = await existing(a, "شاي", "501");
    const p2 = await existing(a, "قهوة", "502");
    const p3 = await existing(a, "سكر", "503");
    const text = csv([
      row({ barcode: "501", name: "شاي أخضر", category: "مشروبات" }),
      row({ barcode: "502", name: "قهوة عربية" }),
      row({ barcode: "503", name: "سكر ناعم" }),
      row({ barcode: "504", name: "ملح" }),
    ]);
    const v = await stageAndValidate(a, text);
    expect(v.summary).toMatchObject({ ok: 1, changed: 3 });
    const diff = value(await getImportBatch({ batchId: v.batchId, status: "CHANGED" }, a.as("owner")));
    expect(diff.rows[0]!.diff).toEqual([
      { field: "name", before: "شاي", after: "شاي أخضر" },
      { field: "category", before: null, after: "مشروبات" },
    ]);
    // Row 1 UPDATE, row 2 SKIP, row 3 no choice (skipped, never silently updated).
    const c = value(await commitImport({ batchId: v.batchId, onChange: { "1": "UPDATE", "2": "SKIP" } }, a.as("owner")));
    expect(c.stats).toMatchObject({ created: 1, updated: 1, skipped: 2 });
    const name = async (id: string) => (await db.rtProduct.findUniqueOrThrow({ where: { id } })).nameAr;
    expect([await name(p1.productId), await name(p2.productId), await name(p3.productId)]).toEqual(["شاي أخضر", "قهوة", "سكر"]);
    const updated = await db.rtProduct.findUniqueOrThrow({ where: { id: p1.productId }, include: { category: true } });
    expect(updated).toMatchObject({ version: 2, category: { nameAr: "مشروبات" } });
    expect(updated.searchText).toContain("شاي اخضر");
    const stored = await db.rtImportRow.findMany({ where: { batchId: v.batchId }, orderBy: { rowNumber: "asc" } });
    expect(stored.map((r) => [r.status, r.resolution, r.reason])).toEqual([
      ["COMMITTED", "UPDATE", "UPDATED"],
      ["CHANGED", "SKIP", null],
      ["CHANGED", "SKIP", null],
      ["COMMITTED", null, "CREATED"],
    ]);
    // The SKU is never changed by an update.
    expect((await db.rtVariant.findUniqueOrThrow({ where: { id: p1.variantId } })).sku).toBe(p1.sku);

    // onChange "UPDATE" applies every CHANGED row.
    const all = await stageAndValidate(a, csv([row({ barcode: "502", name: "قهوة تركية" }), row({ barcode: "503", name: "سكر خشن" })]));
    value(await commitImport({ batchId: all.batchId, onChange: "UPDATE" }, a.as("owner")));
    expect([await name(p2.productId), await name(p3.productId)]).toEqual(["قهوة تركية", "سكر خشن"]);
  });

  it("an update that changes the price closes the old price, and needs price.change", async () => {
    const { a } = await world();
    const milk = await existing(a, "حليب", "700", 1000n);
    const oldPrice = await db.rtPrice.findFirstOrThrow({ where: { unitId: milk.baseUnitId } });
    const v = await stageAndValidate(a, csv([row({ barcode: "700", name: "حليب", price: "1500" })]));
    expect(v.summary).toMatchObject({ changed: 1 });
    expect(value(await commitImport({ batchId: v.batchId, onChange: "UPDATE" }, a.as("manager"))).stats).toMatchObject({ updated: 1 });
    const prices = await db.rtPrice.findMany({ where: { unitId: milk.baseUnitId }, orderBy: { validFrom: "asc" } });
    expect(prices).toHaveLength(2);
    expect(prices[0]).toMatchObject({ id: oldPrice.id, amountMinor: 1000n });
    expect(prices[0]!.validTo).toEqual(prices[1]!.validFrom);
    expect(prices[1]).toMatchObject({ amountMinor: 1500n, validTo: null });

    // A carton's barcode changes the carton's price, not the piece's.
    const box = value(
      await createProduct(
        {
          nameAr: "عصير",
          baseUnit: { name: "حبة", barcodes: ["800"] },
          extraUnits: [{ name: "كرتون", factor: 12, barcodes: ["801"] }],
          price: { currency: "IQD", amountMinor: 500n },
        },
        a.as("owner"),
      ),
    );
    const vb = await stageAndValidate(a, csv([row({ barcode: "801", name: "عصير", price: "5500", factor: "12" })]));
    value(await commitImport({ batchId: vb.batchId, onChange: "UPDATE" }, a.as("owner")));
    const units = await db.rtUnit.findMany({ where: { variantId: box.variantId } });
    const open = async (unitId: string) => (await db.rtPrice.findFirstOrThrow({ where: { unitId, validTo: null } })).amountMinor;
    expect(await open(units.find((u) => u.isBase)!.id)).toBe(500n);
    expect(await open(units.find((u) => !u.isBase)!.id)).toBe(5500n);

    // Without price.change: the name is updated, the price stays, the row says why.
    flags.denyPrice = true;
    try {
      const v2 = await stageAndValidate(a, csv([row({ barcode: "700", name: "حليب طازج", price: "2000" })]), "manager");
      const c = value(await commitImport({ batchId: v2.batchId, onChange: "UPDATE" }, a.as("manager")));
      expect(c.stats).toMatchObject({ updated: 1, priceNotPermitted: 1 });
      expect((await db.rtImportRow.findFirstOrThrow({ where: { batchId: v2.batchId } })).reason).toBe("PRICE_NOT_PERMITTED");
      // A new product keeps no price either.
      const v3 = await stageAndValidate(a, csv([row({ barcode: "701", name: "لبن", price: "750" })]), "manager");
      expect(value(await commitImport({ batchId: v3.batchId, onChange: "SKIP" }, a.as("manager"))).stats).toMatchObject({ created: 1, priceNotPermitted: 1 });
      expect(await db.rtPrice.count({ where: { unit: { barcodes: { some: { code: "701" } } } } })).toBe(0);
    } finally {
      flags.denyPrice = false;
    }
    expect((await db.rtProduct.findUniqueOrThrow({ where: { id: milk.productId } })).nameAr).toBe("حليب طازج");
    expect(await open(milk.baseUnitId)).toBe(1500n);
  });

  it("a manager imports, a stock officer and a cashier cannot", async () => {
    const { a } = await world();
    const text = csv([row({ barcode: "901", name: "مادة" })]);
    const v = await stageAndValidate(a, text, "manager");
    const preset = value(await saveMappingPreset({ name: "ملفي", mapping: v.suggestedMapping }, a.as("manager")));
    for (const who of ["stock", "cashier"]) {
      const results = [
        await stageImport({ fileName: "x.csv", contentBase64: b64(text) }, a.as(who)),
        await validateImport({ batchId: v.batchId, mapping: v.suggestedMapping }, a.as(who)),
        await commitImport({ batchId: v.batchId, onChange: "SKIP" }, a.as(who)),
        await downloadRejected({ batchId: v.batchId }, a.as(who)),
        await listImportBatches({}, a.as(who)),
        await getImportBatch({ batchId: v.batchId }, a.as(who)),
        await deleteImportBatch({ batchId: v.batchId }, a.as(who)),
        await saveMappingPreset({ name: "x", mapping: v.suggestedMapping }, a.as(who)),
        await listMappingPresets({}, a.as(who)),
        await deleteMappingPreset({ id: preset.id }, a.as(who)),
      ];
      for (const r of results) expect(r).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    expect(value(await commitImport({ batchId: v.batchId, onChange: "SKIP" }, a.as("manager"))).stats).toMatchObject({ created: 1 });
    expect(value(await listImportBatches({}, a.as("manager")))).toHaveLength(1);
  });

  it("READ_ONLY refuses every import step", async () => {
    const { a } = await world();
    const text = csv([row({ barcode: "902", name: "مادة" })]);
    const v = await stageAndValidate(a, text);
    const preset = value(await saveMappingPreset({ name: "ملفي", mapping: v.suggestedMapping }, a.as("owner")));
    await db.rtBusiness.update({ where: { id: a.business.id }, data: { status: "SUSPENDED" } });
    const writes = [
      await stageImport({ fileName: "x.csv", contentBase64: b64(text) }, a.as("owner")),
      await validateImport({ batchId: v.batchId, mapping: v.suggestedMapping }, a.as("owner")),
      await commitImport({ batchId: v.batchId, onChange: "SKIP" }, a.as("owner")),
      await deleteImportBatch({ batchId: v.batchId }, a.as("owner")),
      await saveMappingPreset({ name: "آخر", mapping: v.suggestedMapping }, a.as("owner")),
      await deleteMappingPreset({ id: preset.id }, a.as("owner")),
    ];
    for (const r of writes) expect(r).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await productCount(a)).toBe(0);
    // Ruling: reads stay allowed in READ_ONLY (list, get, the rejected-rows file, presets): they
    // change nothing, and an owner whose subscription lapsed can still see and fix the file.
    expect(value(await listImportBatches({}, a.as("owner")))).toHaveLength(1);
    expect(value(await getImportBatch({ batchId: v.batchId }, a.as("owner")))).toMatchObject({ status: "VALIDATED" });
    expect(value(await downloadRejected({ batchId: v.batchId }, a.as("owner")))).toContain("reason");
    expect(value(await listMappingPresets({}, a.as("owner")))).toHaveLength(1);
  });

  it("the rejected-rows file neutralises formula-looking cells", async () => {
    const { a } = await world();
    const text = csv([
      row({ name: "=HYPERLINK(\"http://evil.example\",\"x\")" }), // MISSING_IDENTIFIER
      row({ barcode: "+123", name: "@SUM(A1)", price: "-1" }),
      row({ barcode: "903", name: "  -2+3", price: "abc" }),
      row({ barcode: "904", name: "＝1+1", price: "x, \"y\"" }),
      row({ barcode: "905", name: "عادي" }),
    ]);
    const v = await stageAndValidate(a, text);
    expect(v.summary).toMatchObject({ rejected: 4, ok: 1 });
    const file = value(await downloadRejected({ batchId: v.batchId }, a.as("owner")));
    expect(file.startsWith("﻿")).toBe(true);
    const lines = file.slice(1).trimEnd().split("\r\n");
    expect(lines[0]).toBe([...HEADERS, "reason"].join(","));
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe(`,"'=HYPERLINK(""http://evil.example"",""x"")",,,,,,,,MISSING_IDENTIFIER`);
    expect(lines[2]!.split(",").slice(0, 2)).toEqual(["'+123", "'@SUM(A1)"]);
    expect(lines[2]!.split(",")[6]).toBe("'-1");
    // The raw cell is kept as written: the leading spaces stay, behind the apostrophe.
    expect(lines[3]).toBe("903,'  -2+3,,,,,abc,,,BAD_PRICE");
    expect(lines[4]).toContain("'＝1+1");
    expect(lines[4]).toContain(`"x, ""y"""`);
    expect(file).not.toContain("عادي");
    // Tab and carriage return first, and the full-width signs.
    for (const c of ["\t=1", "\r=1", "＋1", "－1", "＠x", "=1", "+1", "-1", "@x", " =1"]) expect(neutralizeCell(c)).toBe(`'${c}`);
    for (const c of ["1", "abc", "a=b", "", "1-2"]) expect(neutralizeCell(c)).toBe(c);
  });

  it("another business cannot read or commit this batch", async () => {
    const { a, b } = await world();
    const v = await stageAndValidate(a, csv([row({ barcode: "906", name: "مادة" })]));
    const results = [
      await validateImport({ batchId: v.batchId, mapping: v.suggestedMapping }, b.as("owner")),
      await commitImport({ batchId: v.batchId, onChange: "SKIP" }, b.as("owner")),
      await downloadRejected({ batchId: v.batchId }, b.as("owner")),
      await getImportBatch({ batchId: v.batchId }, b.as("owner")),
      await deleteImportBatch({ batchId: v.batchId }, b.as("owner")),
    ];
    for (const r of results) expect(r).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(value(await listImportBatches({}, b.as("owner")))).toHaveLength(0);
    expect(await productCount(b)).toBe(0);
    expect(await productCount(a)).toBe(0);
    // A user of A cannot reach it through B either (not a member of B).
    expect(await getImportBatch({ batchId: v.batchId }, { ...a.as("owner"), businessId: b.business.id })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    // Presets are per business.
    value(await saveMappingPreset({ name: "ملفي", mapping: v.suggestedMapping }, a.as("owner")));
    expect(value(await listMappingPresets({}, b.as("owner")))).toHaveLength(0);
  });

  it("a batch whose rows were committed cannot be deleted", async () => {
    const { a } = await world();
    const v = await stageAndValidate(a, csv([row({ barcode: "907", name: "مادة" })]));
    value(await commitImport({ batchId: v.batchId, onChange: "SKIP" }, a.as("owner")));
    expect(await deleteImportBatch({ batchId: v.batchId }, a.as("owner"))).toMatchObject({ ok: false, code: "IMPORT_ALREADY_COMMITTED" });
    expect(await validateImport({ batchId: v.batchId, mapping: v.suggestedMapping }, a.as("owner"))).toMatchObject({ ok: false, code: "IMPORT_ALREADY_COMMITTED" });
    expect(await db.rtImportRow.count({ where: { batchId: v.batchId } })).toBe(1);
    // A batch that was only staged (or validated) is deleted with its rows.
    const staged = await stage(a, csv([row({ barcode: "908", name: "مادة" })]));
    expect(value(await deleteImportBatch({ batchId: staged.batchId }, a.as("owner")))).toEqual({ batchId: staged.batchId, rows: 1 });
    expect(await db.rtImportBatch.count({ where: { id: staged.batchId } })).toBe(0);
    expect(await db.rtImportRow.count({ where: { batchId: staged.batchId } })).toBe(0);
  });

  it("imported products are found by search afterwards", async () => {
    const { a } = await world();
    const v = await stageAndValidate(a, csv([row({ barcode: "0012399", name: "زيت زيتون", price: "4000" }), row({ sku: "RICE-5", name: "رز بسمتي" })]));
    value(await commitImport({ batchId: v.batchId, onChange: "SKIP" }, a.as("owner")));
    const find = async (query: string) => value(await searchCatalog({ query }, a.as("cashier"))).items;
    expect((await find("زيت")).map((h) => h.productId)).toHaveLength(1);
    expect(await find("0012399")).toHaveLength(1);
    expect(await find("rice-5")).toHaveLength(1);
    // Same text as the per-product actions build.
    const hit = (await find("بسمتي"))[0]!;
    const before = await db.rtVariant.findFirstOrThrow({ where: { productId: hit.productId } });
    const p = value(await getProduct({ id: hit.productId }, a.as("owner")));
    expect(p.variants[0]!.sku).toBe("RICE-5");
    expect(before.searchText).toBe("رز بسمتي rice-5");
  });

  it("a barcode taken between validate and commit is rejected for that row only", async () => {
    const { a } = await world();
    const v = await stageAndValidate(a, csv([row({ barcode: "910", name: "أول" }), row({ barcode: "911", name: "ثان" }), row({ sku: "S-1", name: "ثالث" })]));
    await existing(a, "سابق", "911");
    value(await createProduct({ nameAr: "حاجز", sku: "S-1", baseUnit: { name: "حبة", barcodes: [] } }, a.as("owner")));
    const c = value(await commitImport({ batchId: v.batchId, onChange: "SKIP" }, a.as("owner")));
    expect(c.stats).toMatchObject({ created: 1, rejected: 2 });
    const stored = await db.rtImportRow.findMany({ where: { batchId: v.batchId }, orderBy: { rowNumber: "asc" } });
    expect(stored.map((r) => [r.status, r.reason])).toEqual([
      ["COMMITTED", "CREATED"],
      ["REJECTED", "BARCODE_TAKEN"],
      ["REJECTED", "SKU_TAKEN"],
    ]);
    expect(await productCount(a)).toBe(3);
  });

  it("a product created with the same barcode while the commit runs costs that row only", async () => {
    const { a } = await world();
    const holder = await existing(a, "حامل", "920");
    const v = await stageAndValidate(a, csv([row({ barcode: "921", name: "أول" }), row({ barcode: "RACE-9", name: "متسابق" }), row({ barcode: "922", name: "ثالث" })]));
    let pending: ReturnType<typeof commitImport> | undefined;
    // Our uncommitted insert is invisible to the commit's check; its own insert then waits on the
    // unique index (polled below) and fails when we commit: the slice is retried and that row rejected.
    await db.$transaction(
      async (t) => {
        await t.rtBarcode.create({ data: { businessId: a.business.id, unitId: holder.baseUnitId, code: "RACE-9" } });
        pending = commitImport({ batchId: v.batchId, onChange: "SKIP" }, a.as("owner"));
        expect(await untilWaiting(1)).toBe(true);
      },
      { timeout: 15_000 },
    );
    const c = value(await pending!);
    expect(c.stats).toMatchObject({ created: 2, rejected: 1 });
    const stored = await db.rtImportRow.findMany({ where: { batchId: v.batchId }, orderBy: { rowNumber: "asc" } });
    expect(stored.map((r) => r.reason)).toEqual(["CREATED", "BARCODE_TAKEN", "CREATED"]);
    expect(await db.rtBarcode.count({ where: { businessId: a.business.id, code: "RACE-9" } })).toBe(1);
    expect(await productCount(a)).toBe(3);
  });

  it("a file over the size limit is refused before it is decoded; categories are found by name", async () => {
    const { a } = await world();
    expect(await stageImport({ fileName: "big.csv", contentBase64: "A".repeat(MAX_BASE64_LENGTH + 4) }, a.as("owner"))).toMatchObject({
      ok: false,
      code: "IMPORT_TOO_LARGE",
    });
    expect(await stageImport({ fileName: "x.xls", contentBase64: b64("a,b") }, a.as("owner"))).toMatchObject({ ok: false, code: "IMPORT_UNREADABLE" });
    const cat = value(await createCategory({ nameAr: "ألبان" }, a.as("owner")));
    const v = await stageAndValidate(a, csv([row({ barcode: "930", name: "جبن", category: "البان" })]));
    // A mapping pointing outside the file, or without a name column, is refused.
    expect(await validateImport({ batchId: v.batchId, mapping: { ...v.suggestedMapping, sku: 40 } }, a.as("owner"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await validateImport({ batchId: v.batchId, mapping: { ...v.suggestedMapping, name: null } }, a.as("owner"))).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
      details: { problems: "MISSING_NAME" },
    });
    value(await validateImport({ batchId: v.batchId, mapping: v.suggestedMapping }, a.as("owner")));
    value(await commitImport({ batchId: v.batchId, onChange: "SKIP" }, a.as("owner")));
    expect((await db.rtProduct.findFirstOrThrow({ where: { businessId: a.business.id } })).categoryId).toBe(cat.id);
    expect(await db.rtCategory.count({ where: { businessId: a.business.id } })).toBe(1);
    // The staged rows of an xlsx-less CSV carry no numeric cells and keep the header width.
    expect(autoMapHeaders(HEADERS)).toEqual(v.suggestedMapping);
  });

  it("mapping presets are saved per business, replaced by name, listed and deleted", async () => {
    const { a } = await world();
    const mapping = autoMapHeaders(HEADERS);
    const first = value(await saveMappingPreset({ name: "النظام القديم", mapping }, a.as("owner")));
    const again = value(await saveMappingPreset({ name: "النظام القديم", mapping: { ...mapping, sku: null } }, a.as("manager")));
    expect(again.id).toBe(first.id);
    expect(value(await listMappingPresets({}, a.as("owner")))).toEqual([expect.objectContaining({ name: "النظام القديم", mapping: { ...mapping, sku: null } })]);
    expect(await saveMappingPreset({ name: "سيء", mapping: { ...mapping, price: -1 } }, a.as("owner"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(value(await deleteMappingPreset({ id: first.id }, a.as("owner")))).toEqual({ id: first.id });
    expect(await deleteMappingPreset({ id: first.id }, a.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("stale batches that were never committed are purged after 7 days", async () => {
    const { a } = await world();
    const old = await stage(a, csv([row({ barcode: "940", name: "قديم" })]));
    const half = await stageAndValidate(a, csv(Array.from({ length: SLICE_SIZE + 1 }, (_, i) => row({ barcode: `95${i}`, name: `ن ${i}` }))));
    value(await commitImportSlice({ batchId: half.batchId, onChange: "SKIP" }, a.as("owner")));
    const done = await stageAndValidate(a, csv([row({ barcode: "941", name: "محفوظ" })]));
    value(await commitImport({ batchId: done.batchId, onChange: "SKIP" }, a.as("owner")));
    const fresh = await stage(a, csv([row({ barcode: "942", name: "جديد" })]));
    const longAgo = new Date(Date.now() - 8 * DAY);
    await db.rtImportBatch.updateMany({ where: { id: { in: [old.batchId, half.batchId, done.batchId] } }, data: { createdAt: longAgo } });

    expect(await purgeStaleImportBatches(db)).toBe(1);
    const left = await db.rtImportBatch.findMany({ select: { id: true } });
    expect(left.map((b) => b.id).sort()).toEqual([half.batchId, done.batchId, fresh.batchId].sort());
    expect(await db.rtImportRow.count({ where: { batchId: old.batchId } })).toBe(0);
  });

  it("a row whose product changed after validation is not written (STALE_ROW)", async () => {
    const { a } = await world();
    const bread = await existing(a, "خبز", "960", 250n);
    const tea = await existing(a, "شاي", "961");
    const v = await stageAndValidate(a, csv([row({ barcode: "960", name: "خبز", price: "300" }), row({ barcode: "961", name: "شاي أخضر" })]));
    // Someone sets the price of one and renames the other in the meantime.
    value(await setPrice({ unitId: bread.baseUnitId, listKind: "DEFAULT", currency: "IQD", amountMinor: 275n }, a.as("owner")));
    value(await updateProduct({ id: tea.productId, expectedVersion: 1, nameAr: "شاي أسود" }, a.as("owner")));
    const c = value(await commitImport({ batchId: v.batchId, onChange: "UPDATE", expectedVersion: v.version }, a.as("owner")));
    expect(c.stats).toMatchObject({ updated: 0, rejected: 2 });
    const stored = await db.rtImportRow.findMany({ where: { batchId: v.batchId }, orderBy: { rowNumber: "asc" } });
    expect(stored.map((r) => r.reason)).toEqual(["STALE_ROW", "STALE_ROW"]);
    expect((await db.rtProduct.findUniqueOrThrow({ where: { id: tea.productId } })).nameAr).toBe("شاي أسود");
    const prices = await db.rtPrice.findMany({ where: { unitId: bread.baseUnitId }, orderBy: { validFrom: "asc" } });
    expect(prices.map((r) => r.amountMinor)).toEqual([250n, 275n]);
  });

  it("a SKU-matched row adds its new barcode on UPDATE, and a code taken meanwhile rejects the row", async () => {
    const { a } = await world();
    const oil = value(await createProduct({ nameAr: "زيت", sku: "OIL-1", baseUnit: { name: "حبة", barcodes: [] } }, a.as("owner")));
    value(await createProduct({ nameAr: "سمن", sku: "GHEE-1", baseUnit: { name: "حبة", barcodes: [] } }, a.as("owner")));
    const v = await stageAndValidate(a, csv([row({ sku: "OIL-1", name: "زيت", barcode: "7001" }), row({ sku: "GHEE-1", name: "سمن", barcode: "7002" })]));
    expect(v.summary).toMatchObject({ changed: 2 });
    const changed = value(await getImportBatch({ batchId: v.batchId, status: "CHANGED" }, a.as("owner")));
    expect(changed.rows[0]!.diff).toEqual([{ field: "barcode", before: null, after: "7001" }]);
    await existing(a, "سابق", "7002");
    const c = value(await commitImport({ batchId: v.batchId, onChange: "UPDATE" }, a.as("owner")));
    expect(c.stats).toMatchObject({ updated: 1, rejected: 1 });
    expect(await db.rtBarcode.findFirstOrThrow({ where: { businessId: a.business.id, code: "7001" } })).toMatchObject({ unitId: oil.baseUnitId });
    expect((await db.rtImportRow.findFirstOrThrow({ where: { batchId: v.batchId, rowNumber: 2 } })).reason).toBe("BARCODE_TAKEN");
    expect(value(await searchCatalog({ query: "7001" }, a.as("cashier"))).items.map((h) => h.productId)).toEqual([oil.productId]);
    // A carton's barcode with no factor, a barcode with another SKU, a SKU with no unit of that factor: refused.
    value(
      await createProduct(
        { nameAr: "عصير", sku: "J-1", baseUnit: { name: "حبة", barcodes: ["7100"] }, extraUnits: [{ name: "كرتون", factor: 12, barcodes: ["7101"] }] },
        a.as("owner"),
      ),
    );
    const bad = await stageAndValidate(
      a,
      csv([row({ barcode: "7101", name: "عصير" }), row({ barcode: "7100", name: "عصير", sku: "J-2" }), row({ sku: "J-1", name: "عصير", factor: "6" })]),
    );
    const reasons = await db.rtImportRow.findMany({ where: { batchId: bad.batchId }, orderBy: { rowNumber: "asc" }, select: { reason: true } });
    expect(reasons.map((r) => r.reason)).toEqual(["UNIT_MISMATCH", "SKU_MISMATCH", "UNIT_MISMATCH"]);
  });

  it("commit refuses a batch re-validated since the caller looked (expectedVersion)", async () => {
    const { a } = await world();
    const v = await stageAndValidate(a, csv([row({ barcode: "980", name: "واحد" })]));
    const again = value(await validateImport({ batchId: v.batchId, mapping: v.suggestedMapping }, a.as("owner")));
    expect(again.version).toBe(v.version + 1);
    expect(await commitImport({ batchId: v.batchId, onChange: "SKIP", expectedVersion: v.version }, a.as("owner"))).toMatchObject({
      ok: false,
      code: "VERSION_CONFLICT",
    });
    expect(await productCount(a)).toBe(0);
    const c = value(await commitImport({ batchId: v.batchId, onChange: "SKIP", expectedVersion: again.version }, a.as("owner")));
    expect(c.stats).toMatchObject({ created: 1 });
  });

  it("the idempotency records of stage and validate keep no cells of the file", async () => {
    const { a } = await world();
    const k1 = key();
    const k2 = key();
    const file = b64(csv([row({ barcode: "990", name: "سري-جدا", price: "-1" })]));
    const staged = value(await stageImport({ fileName: "s.csv", contentBase64: file }, a.as("owner", k1)));
    const v = value(await validateImport({ batchId: staged.batchId, mapping: staged.suggestedMapping }, a.as("owner", k2)));
    expect(v.firstRejected[0]!.raw).toContain("سري-جدا");
    const stored = JSON.stringify(await db.rtIdempotency.findMany({ where: { scope: a.business.id } }));
    expect(stored).not.toContain("سري-جدا");
    expect(stored).not.toContain("الباركود"); // a header
    // A replay returns the redacted values; the data stays readable through getImportBatch.
    const replay = value(await validateImport({ batchId: staged.batchId, mapping: staged.suggestedMapping }, a.as("owner", k2)));
    expect(replay.firstRejected[0]).toMatchObject({ reason: "NEGATIVE_PRICE", raw: [] });
    const restaged = value(await stageImport({ fileName: "s.csv", contentBase64: file }, a.as("owner", k1)));
    expect(restaged).toMatchObject({ batchId: staged.batchId, headers: [] });
  });

  it("a scheduled price leaves the update standing without its price, counted apart", async () => {
    const { a } = await world();
    const salt = await existing(a, "ملح", "995", 100n);
    value(
      await setPrice({ unitId: salt.baseUnitId, listKind: "DEFAULT", currency: "IQD", amountMinor: 150n, validFrom: new Date(Date.now() + 5 * DAY) }, a.as("owner")),
    );
    const v = await stageAndValidate(a, csv([row({ barcode: "995", name: "ملح ناعم", price: "120" })]));
    const c = value(await commitImport({ batchId: v.batchId, onChange: "UPDATE" }, a.as("owner")));
    expect(c.stats).toMatchObject({ updated: 1, priceNotApplied: 1 });
    expect((await db.rtImportRow.findFirstOrThrow({ where: { batchId: v.batchId } })).reason).toBe("PRICE_NOT_APPLIED");
    expect((await db.rtProduct.findUniqueOrThrow({ where: { id: salt.productId } })).nameAr).toBe("ملح ناعم");
    expect(await db.rtPrice.count({ where: { unitId: salt.baseUnitId } })).toBe(2);
  });

  it("resolutions are stored by the first slice; a resumed commit cannot change them", async () => {
    const { a } = await world();
    const sugar = await existing(a, "سكر", "8000");
    const rows = Array.from({ length: SLICE_SIZE + 20 }, (_, i) => row({ barcode: "81" + String(i).padStart(4, "0"), name: "صنف " + i }));
    rows.push(row({ barcode: "8000", name: "سكر ناعم" }));
    const v = await stageAndValidate(a, csv(rows));
    value(await commitImportSlice({ batchId: v.batchId, onChange: "SKIP" }, a.as("owner")));
    // Partial progress is visible.
    expect(value(await listImportBatches({}, a.as("owner")))[0]).toMatchObject({ committedRows: SLICE_SIZE, status: "VALIDATED" });
    expect(value(await getImportBatch({ batchId: v.batchId }, a.as("owner")))).toMatchObject({ committedRows: SLICE_SIZE });
    const c = value(await commitImport({ batchId: v.batchId, onChange: "UPDATE" }, a.as("owner")));
    expect(c.stats).toMatchObject({ created: SLICE_SIZE + 20, updated: 0, skipped: 1 });
    expect((await db.rtProduct.findUniqueOrThrow({ where: { id: sugar.productId } })).nameAr).toBe("سكر");
    expect(value(await getImportBatch({ batchId: v.batchId }, a.as("owner")))).toMatchObject({ committedRows: SLICE_SIZE + 20 });
  });

  it("a carton-only row is created and reported as without a base price", async () => {
    const { a } = await world();
    const v = await stageAndValidate(a, csv([row({ barcode: "9100", name: "مياه", unit: "كرتون", factor: "12", price: "3000" })]));
    const c = value(await commitImport({ batchId: v.batchId, onChange: "SKIP" }, a.as("owner")));
    expect(c.stats).toMatchObject({ created: 1, withoutBasePrice: 1 });
    const shown = value(await getImportBatch({ batchId: v.batchId }, a.as("owner")));
    expect(shown.rows[0]).toMatchObject({ status: "COMMITTED", reason: "CREATED_WITHOUT_BASE_PRICE" });
  });

  it("a carton-only row without any price is a plain CREATED, not flagged", async () => {
    const { a } = await world();
    const v = await stageAndValidate(a, csv([row({ barcode: "9101", name: "مياه", unit: "كرتون", factor: "12" })]));
    const c = value(await commitImport({ batchId: v.batchId, onChange: "SKIP" }, a.as("owner")));
    expect(c.stats).toMatchObject({ created: 1, withoutBasePrice: 0 });
    expect((await db.rtImportRow.findFirstOrThrow({ where: { batchId: v.batchId } })).reason).toBe("CREATED");
  });

  it("rows matching one variant twice give the same result wherever the slices split", async () => {
    // Two runs: the duplicate pairs inside one slice, and across the slice boundary.
    const { a: first, b: second } = await world();
    const outcome = async (a: Shop, gap: number) => {
      const juice = value(
        await createProduct(
          { nameAr: "عصير", sku: "JU-1", baseUnit: { name: "حبة", barcodes: ["5100"] }, extraUnits: [{ name: "كرتون", factor: 12, barcodes: ["5112"] }] },
          a.as("owner"),
        ),
      );
      const filler = Array.from({ length: gap }, (_, i) => row({ barcode: "52" + String(i).padStart(4, "0"), name: "حشو " + i }));
      const rows = [
        ...filler,
        row({ barcode: "5100", name: "عصير 1" }),
        row({ sku: "JU-1", name: "عصير 2" }),
        row({ barcode: "5112", name: "عصير 3", factor: "12" }),
      ];
      const v = await stageAndValidate(a, csv(rows));
      const c = value(await commitImport({ batchId: v.batchId, onChange: "UPDATE" }, a.as("owner")));
      const tail = await db.rtImportRow.findMany({ where: { batchId: v.batchId, rowNumber: { gt: gap } }, orderBy: { rowNumber: "asc" } });
      const name = (await db.rtProduct.findUniqueOrThrow({ where: { id: juice.productId } })).nameAr;
      return { stats: { ...c.stats, created: c.stats.created - gap, total: c.stats.total - gap }, tail: tail.map((r) => [r.status, r.reason]), name };
    };
    const inside = await outcome(first, 0);
    expect(inside.tail).toEqual([
      ["COMMITTED", "UPDATED"],
      ["REJECTED", "DUPLICATE_MATCH"],
      ["REJECTED", "DUPLICATE_MATCH"],
    ]);
    expect(inside.name).toBe("عصير 1");
    const across = await outcome(second, SLICE_SIZE - 1);
    expect(across).toEqual(inside);
  }, 60_000);
});

/** Polls until at least `n` sessions wait for a lock (files run one at a time, so the count is ours). */
async function untilWaiting(n: number, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const [r] = await db.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (Number(r!.count) >= n) return true;
    await new Promise((res) => setTimeout(res, 15));
  }
  return false;
}
