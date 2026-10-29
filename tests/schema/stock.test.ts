import { describe, expect, it } from "vitest";
import { SCOPE_MODELS } from "@/server/admin/support";
import { BRANCH_SCOPED_MODELS, BUSINESS_SCOPED_MODELS } from "@/server/framework/scoped-db";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff } from "../helpers/fixtures";

const { db } = useTestDb();

/** The error a promise rejects with, as text (message, code and meta), so a test can name the constraint. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return JSON.stringify(e, Object.getOwnPropertyNames(e));
  }
  throw new Error("expected the database to refuse this write");
}

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let skuSeq = 0;

/** A business with one branch, one location, and one product (variant + base unit). */
async function world() {
  const { business, branches } = await createBusinessWithStaff(db);
  const branch = branches.Main!;
  const location = await db.rtLocation.create({ data: { businessId: business.id, branchId: branch.id, name: "المخزن" } });
  const product = await db.rtProduct.create({ data: { businessId: business.id, nameAr: "حليب" } });
  const variant = await db.rtVariant.create({ data: { businessId: business.id, productId: product.id, sku: `S-${++skuSeq}` } });
  const unit = await db.rtUnit.create({ data: { businessId: business.id, variantId: variant.id, name: "حبة", factor: 1, isBase: true } });
  const where = { businessId: business.id, branchId: branch.id, locationId: location.id };
  return { business, branch, location, product, variant, unit, where };
}

type World = Awaited<ReturnType<typeof world>>;

async function draft(w: World, kind: "OPENING" | "RECEIPT" | "ADJUSTMENT" | "WRITE_OFF" = "RECEIPT") {
  return db.rtStockDocument.create({ data: { ...w.where, kind } });
}

async function line(w: World, documentId: string, lineNo = 1) {
  return db.rtStockLine.create({
    data: {
      businessId: w.business.id,
      documentId,
      lineNo,
      variantId: w.variant.id,
      unitId: w.unit.id,
      quantity: 5000n,
      enteredQuantity: "5",
    },
  });
}

/** A posted receipt with one line and one movement of +5 base units worth 2500. */
async function postedWithMovement(w: World) {
  const doc = await db.rtStockDocument.create({
    data: { ...w.where, kind: "RECEIPT", status: "POSTED", number: 1, postedAt: new Date(), postedById: "u1" },
  });
  const l = await line(w, doc.id);
  const movement = await db.rtStockMovement.create({
    data: { ...w.where, documentId: doc.id, lineId: l.id, variantId: w.variant.id, qtyDelta: 5000n, valueDeltaMinor: 2500n },
  });
  return { doc, line: l, movement };
}

const STOCK_MODELS = ["RtBatch", "RtStockDocument", "RtStockLine", "RtStockMovement", "RtStockBalance", "RtStockCounter"];

describe("stock schema", () => {
  it("applies defaults: a draft document, a counter at 1, and catalog import batches", async () => {
    const w = await world();
    const doc = await draft(w);
    expect(doc).toMatchObject({ status: "DRAFT", number: null, reversesDocumentId: null, importBatchId: null, postedAt: null, version: 1 });
    const counter = await db.rtStockCounter.create({ data: { businessId: w.business.id } });
    expect(counter.nextNumber).toBe(1);
    await expect(db.rtStockCounter.create({ data: { businessId: w.business.id } })).rejects.toMatchObject({ code: "P2002" });
    const batch = await db.rtImportBatch.create({
      data: { businessId: w.business.id, fileName: "x.csv", fileHash: "a".repeat(64), columns: [], stats: {}, createdById: "u1" },
    });
    expect(batch.kind).toBe("CATALOG");
    const stock = await db.rtImportBatch.create({
      data: { businessId: w.business.id, kind: "OPENING_STOCK", fileName: "s.csv", fileHash: "b".repeat(64), columns: [], stats: {}, createdById: "u1" },
    });
    expect(stock.kind).toBe("OPENING_STOCK");
  });

  it("UPDATE and DELETE on a movement fail in the database", async () => {
    const w = await world();
    const { movement, line: l, doc } = await postedWithMovement(w);
    expect(await failure(db.rtStockMovement.update({ where: { id: movement.id }, data: { qtyDelta: 1n } }))).toContain(
      "RtStockMovement is append-only",
    );
    expect(await failure(db.rtStockMovement.delete({ where: { id: movement.id } }))).toContain("RtStockMovement is append-only");
    expect(await failure(db.$executeRaw`UPDATE "RtStockMovement" SET "valueDeltaMinor" = 0`)).toContain(
      "RtStockMovement is append-only",
    );
    expect(await failure(db.$executeRaw`DELETE FROM "RtStockMovement"`)).toContain("RtStockMovement is append-only");
    // Neither the line nor the document can be deleted out from under the ledger.
    expect(await failure(db.rtStockLine.delete({ where: { id: l.id } }))).toContain("RtStockMovement");
    expect(await failure(db.rtStockDocument.delete({ where: { id: doc.id } }))).toContain("RtStockMovement");
    const after = await db.rtStockMovement.findUniqueOrThrow({ where: { id: movement.id } });
    expect(after).toMatchObject({ qtyDelta: 5000n, valueDeltaMinor: 2500n });
    expect(Object.keys(after)).not.toContain("updatedAt");
  });

  it("a movement moves stock and its value goes the same way", async () => {
    const w = await world();
    const { doc, line: l } = await postedWithMovement(w);
    const base = { ...w.where, documentId: doc.id, lineId: l.id, variantId: w.variant.id };
    expect(await failure(db.rtStockMovement.create({ data: { ...base, qtyDelta: 0n, valueDeltaMinor: 0n } }))).toContain(
      "RtStockMovement_qty_nonzero",
    );
    expect(await failure(db.rtStockMovement.create({ data: { ...base, qtyDelta: -1000n, valueDeltaMinor: 10n } }))).toContain(
      "RtStockMovement_value_follows_qty",
    );
    expect(await failure(db.rtStockMovement.create({ data: { ...base, qtyDelta: 1000n, valueDeltaMinor: -10n } }))).toContain(
      "RtStockMovement_value_follows_qty",
    );
    await db.rtStockMovement.create({ data: { ...base, qtyDelta: -1000n, valueDeltaMinor: -500n } });
    await db.rtStockMovement.create({ data: { ...base, qtyDelta: 1000n, valueDeltaMinor: 0n } });
  });

  it("a balance with negative qty is refused", async () => {
    const w = await world();
    const bal = await db.rtStockBalance.create({ data: { ...w.where, variantId: w.variant.id, qty: 0n, valueMinor: 0n } });
    expect(await failure(db.rtStockBalance.update({ where: { id: bal.id }, data: { qty: -1n } }))).toContain(
      "RtStockBalance_qty_nonneg",
    );
    expect(await failure(db.$executeRaw`UPDATE "RtStockBalance" SET "qty" = "qty" - 1`)).toContain("RtStockBalance_qty_nonneg");
    expect((await db.rtStockBalance.findUniqueOrThrow({ where: { id: bal.id } })).qty).toBe(0n);
  });

  it("two no-batch balances for one location and variant are refused", async () => {
    const w = await world();
    const data = { ...w.where, variantId: w.variant.id, qty: 1000n, valueMinor: 100n };
    await db.rtStockBalance.create({ data });
    expect(await failure(db.rtStockBalance.create({ data }))).toContain("P2002");
    // One row per batch is fine, and the same batch twice is not.
    const batch = await db.rtBatch.create({ data: { businessId: w.business.id, variantId: w.variant.id, code: "L1" } });
    await db.rtStockBalance.create({ data: { ...data, batchId: batch.id } });
    expect(await failure(db.rtStockBalance.create({ data: { ...data, batchId: batch.id } }))).toContain("P2002");
    const idx = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'RtStockBalance' AND indexdef LIKE '%NULLS NOT DISTINCT%'`;
    expect(idx).toHaveLength(1);
  });

  it("two identical batches are refused even with null code", async () => {
    const w = await world();
    const base = { businessId: w.business.id, variantId: w.variant.id };
    await db.rtBatch.create({ data: { ...base, expiryDate: day("2027-01-31") } });
    expect(await failure(db.rtBatch.create({ data: { ...base, expiryDate: day("2027-01-31") } }))).toContain("P2002");
    await db.rtBatch.create({ data: { ...base, code: "L1" } });
    expect(await failure(db.rtBatch.create({ data: { ...base, code: "L1" } }))).toContain("P2002");
    await db.rtBatch.create({ data: { ...base } });
    expect(await failure(db.rtBatch.create({ data: { ...base } }))).toContain("P2002");
    // Different code or date: a different batch. expiryDate is a date (no time part).
    const other = await db.rtBatch.create({ data: { ...base, code: "L1", expiryDate: day("2027-01-31") } });
    expect(other.expiryDate?.toISOString()).toBe("2027-01-31T00:00:00.000Z");
    expect(await failure(db.rtBatch.create({ data: { ...base, code: " " } }))).toContain("RtBatch_code_not_blank");
  });

  it("a posted document number is unique per business", async () => {
    const w = await world();
    const other = await world();
    const posted = { kind: "RECEIPT" as const, status: "POSTED" as const, number: 1, postedAt: new Date(), postedById: "u1" };
    await db.rtStockDocument.create({ data: { ...w.where, ...posted } });
    await db.rtStockDocument.create({ data: { ...other.where, ...posted } });
    expect(await failure(db.rtStockDocument.create({ data: { ...w.where, ...posted } }))).toContain("P2002");
    // Drafts have no number yet, any number of them.
    await draft(w);
    await draft(w);
    // A posted document always has a number and a time; numbers start at 1.
    expect(await failure(db.rtStockDocument.create({ data: { ...w.where, ...posted, number: null } }))).toContain(
      "RtStockDocument_posted_has_number",
    );
    expect(await failure(db.rtStockDocument.create({ data: { ...w.where, ...posted, number: 0 } }))).toContain(
      "RtStockDocument_number_positive",
    );
    expect(await failure(db.rtStockCounter.create({ data: { businessId: w.business.id, nextNumber: 0 } }))).toContain(
      "RtStockCounter_next_number_positive",
    );
  });

  it("a document can reverse at most one other document", async () => {
    const w = await world();
    const { doc } = await postedWithMovement(w);
    const reversal = { ...w.where, kind: "REVERSAL" as const, reversesDocumentId: doc.id };
    await db.rtStockDocument.create({ data: reversal });
    expect(await failure(db.rtStockDocument.create({ data: reversal }))).toContain("P2002");
    // Only a REVERSAL names a document, and a REVERSAL always names one (never itself).
    const target = await db.rtStockDocument.create({
      data: { ...w.where, kind: "OPENING", status: "POSTED", number: 2, postedAt: new Date(), postedById: "u1" },
    });
    expect(await failure(db.rtStockDocument.create({ data: { ...w.where, kind: "ADJUSTMENT", reversesDocumentId: target.id } }))).toContain(
      "RtStockDocument_reversal_names_document",
    );
    expect(await failure(db.rtStockDocument.create({ data: { ...w.where, kind: "REVERSAL" } }))).toContain(
      "RtStockDocument_reversal_names_document",
    );
    const self = await draft(w);
    expect(
      await failure(db.rtStockDocument.update({ where: { id: self.id }, data: { kind: "REVERSAL", reversesDocumentId: self.id } })),
    ).toContain("RtStockDocument_not_self_reversal");
  });

  it("line quantities are positive and line values never negative", async () => {
    const w = await world();
    const doc = await draft(w);
    const base = { businessId: w.business.id, documentId: doc.id, variantId: w.variant.id, unitId: w.unit.id, enteredQuantity: "1" };
    expect(await failure(db.rtStockLine.create({ data: { ...base, lineNo: 1, quantity: 0n } }))).toContain("RtStockLine_quantity_positive");
    expect(await failure(db.rtStockLine.create({ data: { ...base, lineNo: 1, quantity: -5n } }))).toContain("RtStockLine_quantity_positive");
    expect(await failure(db.rtStockLine.create({ data: { ...base, lineNo: 0, quantity: 1n } }))).toContain("RtStockLine_line_no_positive");
    expect(
      await failure(db.rtStockLine.create({ data: { ...base, lineNo: 1, quantity: 1n, currency: "IQD", unitCostMinor: -1n } })),
    ).toContain("RtStockLine_values_nonneg");
    expect(await failure(db.rtStockLine.create({ data: { ...base, lineNo: 1, quantity: 1n, valueMinor: -1n } }))).toContain(
      "RtStockLine_values_nonneg",
    );
    expect(
      await failure(db.rtStockLine.create({ data: { ...base, lineNo: 1, quantity: 1n, currency: "USD", unitCostMinor: 100n, rateMicro: 0n } })),
    ).toContain("RtStockLine_rate_positive");
    expect(await failure(db.rtStockLine.create({ data: { ...base, lineNo: 1, quantity: 1n, unitCostMinor: 100n } }))).toContain(
      "RtStockLine_cost_has_currency",
    );
    const ok = await db.rtStockLine.create({
      data: { ...base, lineNo: 1, quantity: 1000n, currency: "USD", unitCostMinor: 150n, rateMicro: 1_310_000_000n, valueMinor: 1965n, expiryDate: day("2027-02-01"), batchCode: "L9" },
    });
    expect(await failure(db.rtStockLine.create({ data: { ...base, lineNo: 1, quantity: 1n } }))).toContain("P2002");
    // A draft's lines go with it.
    await db.rtStockDocument.delete({ where: { id: doc.id } });
    expect(await db.rtStockLine.count({ where: { id: ok.id } })).toBe(0);
  });

  it("composite foreign keys keep every row in one business", async () => {
    const w = await world();
    const x = await world();
    const mine = await postedWithMovement(w);
    const xBatch = await db.rtBatch.create({ data: { businessId: x.business.id, variantId: x.variant.id, code: "X" } });
    const wBatch = await db.rtBatch.create({ data: { businessId: w.business.id, variantId: w.variant.id, code: "W" } });

    // A batch of another business's variant.
    expect(await failure(db.rtBatch.create({ data: { businessId: w.business.id, variantId: x.variant.id } }))).toContain(
      "RtBatch_businessId_variantId_fkey",
    );
    // Documents: another business's branch/location, or a location of another branch; foreign import batch or reversed doc.
    const xImport = await db.rtImportBatch.create({
      data: { businessId: x.business.id, kind: "OPENING_STOCK", fileName: "s.csv", fileHash: "c".repeat(64), columns: [], stats: {}, createdById: "u1" },
    });
    expect(await failure(db.rtStockDocument.create({ data: { ...w.where, branchId: x.branch.id, locationId: x.location.id, kind: "RECEIPT" } }))).toContain(
      "RtStockDocument_businessId_branchId_fkey",
    );
    const otherBranch = await db.rtBranch.create({ data: { businessId: w.business.id, name: "B2" } });
    expect(await failure(db.rtStockDocument.create({ data: { ...w.where, branchId: otherBranch.id, kind: "RECEIPT" } }))).toContain(
      "RtStockDocument_businessId_branchId_locationId_fkey",
    );
    expect(await failure(db.rtStockDocument.create({ data: { ...w.where, kind: "OPENING", importBatchId: xImport.id } }))).toContain(
      "RtStockDocument_businessId_importBatchId_fkey",
    );
    const xPosted = await postedWithMovement(x);
    expect(
      await failure(db.rtStockDocument.create({ data: { ...w.where, kind: "REVERSAL", reversesDocumentId: xPosted.doc.id } })),
    ).toContain("RtStockDocument_businessId_reversesDocumentId_fkey");

    // Lines: foreign document, variant, unit, batch; a batch of another variant.
    const doc = await draft(w);
    const lineBase = { businessId: w.business.id, documentId: doc.id, lineNo: 1, variantId: w.variant.id, unitId: w.unit.id, quantity: 1n, enteredQuantity: "1" };
    expect(await failure(db.rtStockLine.create({ data: { ...lineBase, documentId: xPosted.doc.id } }))).toContain(
      "RtStockLine_businessId_documentId_fkey",
    );
    expect(await failure(db.rtStockLine.create({ data: { ...lineBase, variantId: x.variant.id } }))).toContain(
      "RtStockLine_businessId_variantId_fkey",
    );
    expect(await failure(db.rtStockLine.create({ data: { ...lineBase, unitId: x.unit.id } }))).toContain("RtStockLine_businessId_unitId_fkey");
    expect(await failure(db.rtStockLine.create({ data: { ...lineBase, batchId: xBatch.id } }))).toContain(
      "RtStockLine_businessId_variantId_batchId_fkey",
    );
    const otherVariant = await db.rtVariant.create({ data: { businessId: w.business.id, productId: w.product.id, sku: `S-${++skuSeq}` } });
    const otherBatch = await db.rtBatch.create({ data: { businessId: w.business.id, variantId: otherVariant.id, code: "OV" } });
    expect(await failure(db.rtStockLine.create({ data: { ...lineBase, batchId: otherBatch.id } }))).toContain(
      "RtStockLine_businessId_variantId_batchId_fkey",
    );

    // Movements: foreign location, document, a line of another document, foreign batch.
    const mvBase = { ...w.where, documentId: mine.doc.id, lineId: mine.line.id, variantId: w.variant.id, qtyDelta: 1n, valueDeltaMinor: 0n };
    expect(await failure(db.rtStockMovement.create({ data: { ...mvBase, branchId: x.branch.id, locationId: x.location.id } }))).toContain(
      "RtStockMovement_businessId_branchId_fkey",
    );
    expect(await failure(db.rtStockMovement.create({ data: { ...mvBase, documentId: xPosted.doc.id } }))).toContain(
      "RtStockMovement_businessId_documentId_fkey",
    );
    const otherDoc = await draft(w);
    const otherLine = await line(w, otherDoc.id);
    expect(await failure(db.rtStockMovement.create({ data: { ...mvBase, lineId: otherLine.id } }))).toContain(
      "RtStockMovement_businessId_documentId_lineId_fkey",
    );
    expect(await failure(db.rtStockMovement.create({ data: { ...mvBase, batchId: xBatch.id } }))).toContain(
      "RtStockMovement_businessId_variantId_batchId_fkey",
    );
    await db.rtStockMovement.create({ data: { ...mvBase, batchId: wBatch.id } });

    // Balances: foreign location, variant, batch.
    const balBase = { ...w.where, variantId: w.variant.id, qty: 0n, valueMinor: 0n };
    expect(await failure(db.rtStockBalance.create({ data: { ...balBase, locationId: x.location.id } }))).toContain(
      "RtStockBalance_businessId_branchId_locationId_fkey",
    );
    expect(await failure(db.rtStockBalance.create({ data: { ...balBase, variantId: x.variant.id } }))).toContain(
      "RtStockBalance_businessId_variantId_fkey",
    );
    expect(await failure(db.rtStockBalance.create({ data: { ...balBase, batchId: xBatch.id } }))).toContain(
      "RtStockBalance_businessId_variantId_batchId_fkey",
    );
  });

  it("every new model is classified in scoped-db and in the STOCK_READ support scope", () => {
    expect(BUSINESS_SCOPED_MODELS).toEqual(expect.arrayContaining(STOCK_MODELS));
    // Documents, movements and balances live in a branch's location: branch-scoped (a branch-limited
    // actor sees only its branches). Lines follow their document; batches and the counter are business-level.
    expect(BRANCH_SCOPED_MODELS).toEqual(expect.arrayContaining(["RtStockDocument", "RtStockMovement", "RtStockBalance"]));
    for (const m of ["RtBatch", "RtStockLine", "RtStockCounter"]) expect(BRANCH_SCOPED_MODELS).not.toContain(m);
    expect([...SCOPE_MODELS.STOCK_READ].sort()).toEqual(
      ["RtBatch", "RtStockBalance", "RtStockDocument", "RtStockLine", "RtStockMovement"].sort(),
    );
    // The counter is bookkeeping, readable by no support scope (like RtCatalogCounter).
    for (const models of Object.values(SCOPE_MODELS)) expect(models).not.toContain("RtStockCounter");
  });
});
