import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { commitImport, stageImport, validateImport } from "@/server/catalog/import/actions";
import { TEST_ARCHIVE_SLICE, archiveTestProducts, createProduct } from "@/server/catalog/products";
import { getSetupProgress, setupOverview } from "@/server/setup/progress";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

/*
 * Trial items (setup step 4): products marked isTestData by quick entry or by an import started from
 * the setup wizard, and archiveTestProducts, which archives them before launch.
 */

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

/** Imports `count` products (barcode + name + price) through the real import actions. */
async function importItems(w: Shop, count: number, isTestData: boolean, prefix = "629") {
  const lines = ["الباركود,الاسم,السعر"];
  for (let i = 1; i <= count; i += 1) lines.push(`${prefix}${String(i).padStart(10, "0")},صنف ${i},${1000 + i}`);
  const staged = ok(await stageImport({ fileName: "trial.csv", contentBase64: Buffer.from(lines.join("\n")).toString("base64"), isTestData }, w.as("owner")));
  const validated = ok(await validateImport({ batchId: staged.batchId, mapping: staged.suggestedMapping }, w.as("owner")));
  expect(validated.summary.ok).toBe(count);
  const committed = ok(await commitImport({ batchId: staged.batchId, onChange: "SKIP", expectedVersion: validated.version }, w.as("owner")));
  expect(committed.stats.created).toBe(count);
  return staged.batchId;
}

const step4 = async (w: Shop) => {
  const r = ok(await getSetupProgress({}, w.as("owner")));
  return r.find((s) => s.step === 4)!.status;
};

describe("trial items", () => {
  it("an import started as trial items creates trial products that do not complete step 4; a real import does", async () => {
    const { a } = await world();
    await importItems(a, 3, true);
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

  it("archiveTestProducts archives every active trial item in slices of 200, audits the counts, and leaves real products alone", async () => {
    const { a, b } = await world();
    const count = TEST_ARCHIVE_SLICE * 2 + 50;
    await importItems(a, count, true);
    await importItems(b, 2, true);
    const real = ok(await createProduct({ nameAr: "منتج حقيقي", baseUnit: { name: "قطعة", barcodes: ["111"] } }, a.as("owner")));
    const auditsBefore = await db.rtAuditLog.count({ where: { businessId: a.business.id, action: "catalog.product.archiveTestData" } });
    expect(auditsBefore).toBe(0);

    const k = key();
    const started = Date.now();
    expect(await archiveTestProducts({}, a.as("stock", k))).toEqual({ ok: true, value: { archived: count } });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(await db.rtProduct.count({ where: { businessId: a.business.id, isTestData: true, archivedAt: null } })).toBe(0);
    expect(await db.rtProduct.count({ where: { businessId: a.business.id, isTestData: true, archivedAt: { not: null } } })).toBe(count);
    expect((await db.rtProduct.findUniqueOrThrow({ where: { id: real.productId } })).archivedAt).toBeNull();
    // Another business's trial items are untouched.
    expect(await db.rtProduct.count({ where: { businessId: b.business.id, isTestData: true, archivedAt: null } })).toBe(2);

    // One audit row per transaction, with the count only.
    const audits = await db.rtAuditLog.findMany({ where: { businessId: a.business.id, action: "catalog.product.archiveTestData" } });
    expect(audits).toHaveLength(3);
    expect(audits.map((x) => (x.changes as { archivedTestProducts: number }).archivedTestProducts).sort((p, q) => p - q)).toEqual([50, 200, 200]);

    // Same key: replayed, nothing archived twice; a new key finds nothing left.
    expect(await archiveTestProducts({}, a.as("stock", k))).toEqual({ ok: true, value: { archived: count } });
    expect(await archiveTestProducts({}, a.as("owner"))).toEqual({ ok: true, value: { archived: 0 } });
    expect(ok(await setupOverview({}, a.as("owner"))).catalog).toEqual({ products: 1, testProducts: 0, ready: true });
  });

  it("archiveTestProducts: a cashier is refused, READ_ONLY refuses it, and a bad key is INVALID_INPUT", async () => {
    const { a } = await world();
    await importItems(a, 2, true);
    expect(await archiveTestProducts({}, a.as("cashier"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await archiveTestProducts({}, { ...a.as("owner"), idempotencyKey: "" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    await db.rtBusiness.update({ where: { id: a.business.id }, data: { status: "SUSPENDED" } });
    expect(await archiveTestProducts({}, a.as("owner"))).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await db.rtProduct.count({ where: { businessId: a.business.id, archivedAt: null } })).toBe(2);
  });

  it("quick entry's trial flag is stored; products default to real", async () => {
    const { a } = await world();
    const trial = ok(await createProduct({ nameAr: "تجربة", isTestData: true, baseUnit: { name: "قطعة", barcodes: [] } }, a.as("owner")));
    const real = ok(await createProduct({ nameAr: "حقيقي", baseUnit: { name: "قطعة", barcodes: [] } }, a.as("owner")));
    expect((await db.rtProduct.findUniqueOrThrow({ where: { id: trial.productId } })).isTestData).toBe(true);
    expect((await db.rtProduct.findUniqueOrThrow({ where: { id: real.productId } })).isTestData).toBe(false);
  });
});
