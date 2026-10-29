import { describe, expect, it } from "vitest";
import { SCOPE_MODELS } from "@/server/admin/support";
import { BRANCH_SCOPED_MODELS, BUSINESS_SCOPED_MODELS } from "@/server/framework/scoped-db";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff } from "../helpers/fixtures";

const { db } = useTestDb();

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return JSON.stringify(e, Object.getOwnPropertyNames(e));
  }
  throw new Error("expected the database to refuse this write");
}

async function batch(businessId: string) {
  return db.rtImportBatch.create({
    data: { businessId, fileName: "items.csv", fileHash: "a".repeat(64), columns: ["barcode", "name"], stats: {}, createdById: "u1" },
  });
}

describe("import staging schema", () => {
  it("applies defaults and deletes rows with their batch", async () => {
    const { business } = await createBusinessWithStaff(db);
    const b = await batch(business.id);
    expect(b).toMatchObject({ status: "STAGED", version: 1, mapping: null });
    await db.rtImportRow.createMany({
      data: [1, 2].map((rowNumber) => ({ businessId: business.id, batchId: b.id, rowNumber, raw: ["1", "x"], status: "OK" as const })),
    });
    await db.rtImportBatch.delete({ where: { id: b.id } });
    expect(await db.rtImportRow.count()).toBe(0);
  });

  it("a row number is unique inside a batch, positive, and the resolution is UPDATE or SKIP", async () => {
    const { business } = await createBusinessWithStaff(db);
    const b = await batch(business.id);
    const data = { businessId: business.id, batchId: b.id, raw: [], status: "CHANGED" as const };
    await db.rtImportRow.create({ data: { ...data, rowNumber: 1, resolution: "UPDATE" } });
    expect(await failure(db.rtImportRow.create({ data: { ...data, rowNumber: 1 } }))).toContain("Unique");
    expect(await failure(db.rtImportRow.create({ data: { ...data, rowNumber: 0 } }))).toContain("RtImportRow_row_number_positive");
    expect(await failure(db.rtImportRow.create({ data: { ...data, rowNumber: 2, resolution: "DELETE" } }))).toContain(
      "RtImportRow_resolution_values",
    );
  });

  it("a row can not point at another business's batch", async () => {
    const a = (await createBusinessWithStaff(db)).business;
    const other = (await createBusinessWithStaff(db)).business;
    const b = await batch(a.id);
    const err = await failure(
      db.rtImportRow.create({ data: { businessId: other.id, batchId: b.id, rowNumber: 1, raw: [], status: "OK" } }),
    );
    expect(err).toContain("RtImportRow_businessId_batchId_fkey");
  });

  it("matchedVariantId is tenant-safe and cleared when the variant is deleted", async () => {
    const a = (await createBusinessWithStaff(db)).business;
    const other = (await createBusinessWithStaff(db)).business;
    const mk = async (businessId: string, sku: string) => {
      const p = await db.rtProduct.create({ data: { businessId, nameAr: "حليب" } });
      return db.rtVariant.create({ data: { businessId, productId: p.id, sku } });
    };
    const mine = await mk(a.id, "S-A");
    const theirs = await mk(other.id, "S-B");
    const b = await batch(a.id);
    const base = { businessId: a.id, batchId: b.id, raw: [], status: "CHANGED" as const };
    const err = await failure(db.rtImportRow.create({ data: { ...base, rowNumber: 1, matchedVariantId: theirs.id } }));
    expect(err).toContain("RtImportRow_businessId_matchedVariantId_fkey");
    const row = await db.rtImportRow.create({ data: { ...base, rowNumber: 2, matchedVariantId: mine.id } });
    await db.rtVariant.delete({ where: { id: mine.id } });
    const after = await db.rtImportRow.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ matchedVariantId: null, businessId: a.id });
  });

  it("is classified as business-scoped, never branch-scoped, and not readable by support", () => {
    for (const m of ["RtImportBatch", "RtImportRow"]) {
      expect(BUSINESS_SCOPED_MODELS).toContain(m);
      expect(BRANCH_SCOPED_MODELS).not.toContain(m);
      for (const models of Object.values(SCOPE_MODELS)) expect(models).not.toContain(m);
    }
  });
});
