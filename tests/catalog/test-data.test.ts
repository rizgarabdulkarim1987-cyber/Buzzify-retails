import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { commitImport, stageImport, validateImport } from "@/server/catalog/import/actions";
import {
  TEST_REMOVE_SLICE,
  archiveProduct,
  createProduct,
  getProduct,
  registerTrialReferenceCheck,
  removeTestProducts,
  unarchiveProduct,
} from "@/server/catalog/products";
import { searchCatalog } from "@/server/catalog/search";
import { getSetupProgress, setupOverview } from "@/server/setup/progress";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

/*
 * Trial items (setup step 4): products marked isTestData by quick entry or by an import started from
 * the setup wizard, and removeTestProducts, which deletes them (freeing their barcodes and SKUs)
 * before launch. Only staff.manage holders (OWNER, MANAGER) may mark or remove trial items.
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
  await db.rtBusiness.update({ where: { id: w.business.id }, data: { status: "ACTIVE", name: label } });
  await db.rtSubscription.create({
    data: { businessId: w.business.id, planCode: "basic", status: "ACTIVE", currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 30 * DAY) },
  });
  const as = (who: string, k = key()) => ({ userId: w.staff[who]!.user.id, businessId: w.business.id, idempotencyKey: k });
  return { ...w, as };
}
type Shop = Awaited<ReturnType<typeof business>>;

async function world() {
  await createPlan(db, { maxBranches: 3 });
  return { a: await business("A shop"), b: await business("B shop") };
}

function ok<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
  return r.value;
}

const code = (prefix: string, i: number) => `${prefix}${String(i).padStart(10, "0")}`;

/** Imports `count` products (barcode + name + price) through the real import actions. */
async function importItems(w: Shop, count: number, isTestData: boolean, prefix = "629", onChange: "SKIP" | "UPDATE" = "SKIP") {
  const lines = ["الباركود,الاسم,السعر"];
  for (let i = 1; i <= count; i += 1) lines.push(`${code(prefix, i)},صنف ${i},${1000 + i}`);
  const staged = ok(await stageImport({ fileName: "trial.csv", contentBase64: Buffer.from(lines.join("\n")).toString("base64"), isTestData }, w.as("owner")));
  const validated = ok(await validateImport({ batchId: staged.batchId, mapping: staged.suggestedMapping }, w.as("owner")));
  const committed = ok(await commitImport({ batchId: staged.batchId, onChange, expectedVersion: validated.version }, w.as("owner")));
  return { batchId: staged.batchId, validated, committed };
}

const step4 = async (w: Shop) => {
  const r = ok(await getSetupProgress({}, w.as("owner")));
  return r.find((s) => s.step === 4)!.status;
};

const unregister: (() => void)[] = [];
afterEach(() => {
  while (unregister.length) unregister.pop()!();
});

describe("trial items", () => {
  it("an import started as trial items creates trial products that do not complete step 4; a real import does", async () => {
    const { a } = await world();
    const first = await importItems(a, 3, true);
    expect(first.committed.stats.created).toBe(3);
    expect(await db.rtProduct.count({ where: { businessId: a.business.id, isTestData: true } })).toBe(3);
    expect(await db.rtImportBatch.count({ where: { businessId: a.business.id, isTestData: true } })).toBe(1);
    expect(await step4(a)).toBe("PENDING");

    // A real import: its products are real, and its committed rows complete step 4 even once archived.
    await importItems(a, 2, false, "628");
    expect(await db.rtProduct.count({ where: { businessId: a.business.id, isTestData: false } })).toBe(2);
    expect(await step4(a)).toBe("DONE");
    await db.rtProduct.updateMany({ where: { businessId: a.business.id, isTestData: false }, data: { archivedAt: new Date() } });
    expect(await step4(a)).toBe("DONE");
  });

  it("removeTestProducts deletes every trial item (archived ones too) in slices of 200, audits counts and ids, and frees barcodes and SKUs", async () => {
    const { a, b } = await world();
    const count = TEST_REMOVE_SLICE * 2 + 50;
    const trialImport = await importItems(a, count, true);
    await importItems(b, 2, true);
    const real = ok(await createProduct({ nameAr: "منتج حقيقي", baseUnit: { name: "قطعة", barcodes: ["111"] } }, a.as("owner")));
    const manual = ok(
      await createProduct(
        { nameAr: "تجربة برمز", isTestData: true, sku: "TRIAL.1", baseUnit: { name: "قطعة", barcodes: ["7770001"] }, extraUnits: [{ name: "كرتون", factor: 12, barcodes: ["7770002"] }], price: { currency: "IQD", amountMinor: 500n } },
        a.as("owner"),
      ),
    );
    // An archived trial item is removed too.
    const p = await db.rtProduct.findUniqueOrThrow({ where: { id: manual.productId } });
    ok(await archiveProduct({ id: manual.productId, expectedVersion: p.version }, a.as("owner")));
    // A batch row that points at a trial variant (a later re-import that matched it).
    const again = await importItems(a, 1, false, "629");
    expect(again.validated.summary.skipped).toBe(1);
    const matched = await db.rtImportRow.findFirstOrThrow({ where: { batchId: again.batchId } });
    expect(matched.matchedVariantId).not.toBeNull();

    const k = key();
    const started = Date.now();
    expect(await removeTestProducts({}, a.as("owner", k))).toEqual({ ok: true, value: { removed: count + 1 } });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(await db.rtProduct.count({ where: { businessId: a.business.id, isTestData: true } })).toBe(0);
    expect(await db.rtBarcode.count({ where: { businessId: a.business.id, code: { in: ["7770001", "7770002", code("629", 1)] } } })).toBe(0);
    // The real product and its barcode are untouched; another business's trial items too.
    expect((await db.rtProduct.findUniqueOrThrow({ where: { id: real.productId } })).archivedAt).toBeNull();
    expect(await db.rtBarcode.count({ where: { businessId: a.business.id, code: "111" } })).toBe(1);
    expect(await db.rtProduct.count({ where: { businessId: b.business.id, isTestData: true } })).toBe(2);
    // The import batches and their rows survive; the row's match is cleared.
    expect(await db.rtImportRow.count({ where: { batchId: trialImport.batchId } })).toBe(count);
    expect((await db.rtImportRow.findUniqueOrThrow({ where: { id: matched.id } })).matchedVariantId).toBeNull();

    // One audit row per transaction, with the count and the ids (at most 200 per row).
    const audits = await db.rtAuditLog.findMany({ where: { businessId: a.business.id, action: "catalog.product.removeTestData" } });
    expect(audits).toHaveLength(3);
    const changes = audits.map((x) => x.changes as { removedTestProducts: number; productIds: string[] });
    expect(changes.map((c) => c.removedTestProducts).sort((x, y) => x - y)).toEqual([51, 200, 200]);
    for (const c of changes) expect(c.productIds).toHaveLength(c.removedTestProducts);
    expect(changes.flatMap((c) => c.productIds)).toContain(manual.productId);

    // Same key: replayed, nothing removed twice; a new key finds nothing left.
    expect(await removeTestProducts({}, a.as("owner", k))).toEqual({ ok: true, value: { removed: count + 1 } });
    expect(await removeTestProducts({}, a.as("manager"))).toEqual({ ok: true, value: { removed: 0 } });
    expect(ok(await setupOverview({}, a.as("owner"))).catalog).toEqual({ products: 1, testProducts: 0, ready: true });

    // The freed barcodes and SKU can be used again, by hand and by an import.
    ok(await createProduct({ nameAr: "حقيقي الآن", sku: "TRIAL.1", baseUnit: { name: "قطعة", barcodes: ["7770001"] } }, a.as("owner")));
    const reimport = await importItems(a, 3, false, "629");
    expect(reimport.committed.stats.created).toBe(3);
  });

  it("removeTestProducts needs staff.manage: cashier and stock are refused, READ_ONLY refuses it, a bad key is INVALID_INPUT", async () => {
    const { a } = await world();
    await importItems(a, 2, true);
    expect(await removeTestProducts({}, a.as("cashier"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await removeTestProducts({}, a.as("stock"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await removeTestProducts({}, { ...a.as("owner"), idempotencyKey: "" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    await db.rtBusiness.update({ where: { id: a.business.id }, data: { status: "SUSPENDED" } });
    expect(await removeTestProducts({}, a.as("owner"))).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await db.rtProduct.count({ where: { businessId: a.business.id, isTestData: true } })).toBe(2);
  });

  it("removal is refused when a later table references a trial item (no such table in R1: sales do not exist yet)", async () => {
    const { a } = await world();
    await importItems(a, 2, true);
    // R1 registers no reference check: nothing (no sale, no stock movement) can point at a product yet.
    unregister.push(registerTrialReferenceCheck(async () => true));
    expect(await removeTestProducts({}, a.as("owner"))).toMatchObject({ ok: false, code: "TRIAL_IN_USE" });
    expect(await db.rtProduct.count({ where: { businessId: a.business.id, isTestData: true } })).toBe(2);
  });

  it("only staff.manage may mark a trial item: stock is refused for an explicit true, and products default to real", async () => {
    const { a } = await world();
    const trial = ok(await createProduct({ nameAr: "تجربة", isTestData: true, baseUnit: { name: "قطعة", barcodes: [] } }, a.as("manager")));
    const real = ok(await createProduct({ nameAr: "حقيقي", baseUnit: { name: "قطعة", barcodes: [] } }, a.as("stock")));
    expect((await db.rtProduct.findUniqueOrThrow({ where: { id: trial.productId } })).isTestData).toBe(true);
    expect((await db.rtProduct.findUniqueOrThrow({ where: { id: real.productId } })).isTestData).toBe(false);
    // The list and the product screen can show the trial badge.
    expect(ok(await getProduct({ id: trial.productId }, a.as("cashier"))).isTestData).toBe(true);
    expect(ok(await getProduct({ id: real.productId }, a.as("cashier"))).isTestData).toBe(false);
    const hits = ok(await searchCatalog({ query: "" }, a.as("cashier"))).items;
    expect(hits.find((h) => h.productId === trial.productId)?.isTestData).toBe(true);
    expect(hits.find((h) => h.productId === real.productId)?.isTestData).toBe(false);
    expect(await createProduct({ nameAr: "تجربة مخزن", isTestData: true, baseUnit: { name: "قطعة", barcodes: [] } }, a.as("stock"))).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    // An explicit false is fine for anyone with catalog.manage.
    ok(await createProduct({ nameAr: "حقيقي ٢", isTestData: false, baseUnit: { name: "قطعة", barcodes: [] } }, a.as("stock")));
    expect(await db.rtProduct.count({ where: { businessId: a.business.id, nameAr: "تجربة مخزن" } })).toBe(0);
  });

  it("an UPDATE from a real import adopts the trial product as real; unarchiving keeps the flag", async () => {
    const { a } = await world();
    await importItems(a, 2, true);
    // The real file renames item 1: UPDATE adopts it.
    const lines = ["الباركود,الاسم,السعر", `${code("629", 1)},صنف معتمد,1001`];
    const staged = ok(await stageImport({ fileName: "real.csv", contentBase64: Buffer.from(lines.join("\n")).toString("base64") }, a.as("owner")));
    const validated = ok(await validateImport({ batchId: staged.batchId, mapping: staged.suggestedMapping }, a.as("owner")));
    expect(validated.summary.changed).toBe(1);
    ok(await commitImport({ batchId: staged.batchId, onChange: "UPDATE", expectedVersion: validated.version }, a.as("owner")));
    const adopted = await db.rtProduct.findFirstOrThrow({ where: { businessId: a.business.id, nameAr: "صنف معتمد" } });
    expect(adopted.isTestData).toBe(false);
    const other = await db.rtProduct.findFirstOrThrow({ where: { businessId: a.business.id, nameAr: "صنف 2" } });
    expect(other.isTestData).toBe(true);

    // Archive then unarchive the other one: still a trial item.
    ok(await archiveProduct({ id: other.id, expectedVersion: other.version }, a.as("owner")));
    ok(await unarchiveProduct({ id: other.id, expectedVersion: other.version + 1 }, a.as("owner")));
    expect((await db.rtProduct.findUniqueOrThrow({ where: { id: other.id } })).isTestData).toBe(true);
  });
});
