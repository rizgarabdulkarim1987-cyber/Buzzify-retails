-- R2 stock: batches, stock documents and their lines, the append-only movement ledger, balances,
-- the per-business document counter, and the kind of an import batch (existing batches are CATALOG).
--
-- Hand-written parts (Prisma cannot express them, so the drift check does not see them):
-- * NULLS NOT DISTINCT on the RtBatch and RtStockBalance unique keys (PostgreSQL 15+; the tests run
--   on 18, CI on 17). Prisma models them as ordinary @@unique keys with the same names and columns;
--   the drift check compares names and columns only, so it stays empty.
-- * The CHECK constraints and the append-only trigger at the end of this file.

-- CreateEnum
CREATE TYPE "ImportBatchKind" AS ENUM ('CATALOG', 'OPENING_STOCK');

-- CreateEnum
CREATE TYPE "RtStockDocumentKind" AS ENUM ('OPENING', 'RECEIPT', 'ADJUSTMENT', 'WRITE_OFF', 'REVERSAL');

-- CreateEnum
CREATE TYPE "RtStockDocumentStatus" AS ENUM ('DRAFT', 'POSTED');

-- AlterTable
ALTER TABLE "RtImportBatch" ADD COLUMN     "kind" "ImportBatchKind" NOT NULL DEFAULT 'CATALOG';

-- CreateTable
CREATE TABLE "RtBatch" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "code" TEXT,
    "expiryDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RtBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtStockDocument" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "kind" "RtStockDocumentKind" NOT NULL,
    "status" "RtStockDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "number" INTEGER,
    "supplierRef" TEXT,
    "note" TEXT,
    "reason" TEXT,
    "reversesDocumentId" TEXT,
    "importBatchId" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtStockDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtStockLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "variantId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "batchCode" TEXT,
    "expiryDate" DATE,
    "batchId" TEXT,
    "quantity" BIGINT NOT NULL,
    "enteredQuantity" TEXT NOT NULL,
    "currency" "Currency",
    "unitCostMinor" BIGINT,
    "rateMicro" BIGINT,
    "valueMinor" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtStockLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtStockMovement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "batchId" TEXT,
    "qtyDelta" BIGINT NOT NULL,
    "valueDeltaMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RtStockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtStockBalance" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "batchId" TEXT,
    "qty" BIGINT NOT NULL,
    "valueMinor" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtStockBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtStockCounter" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "RtStockCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RtBatch_businessId_id_key" ON "RtBatch"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RtBatch_businessId_variantId_id_key" ON "RtBatch"("businessId", "variantId", "id");

-- CreateIndex
-- NULLS NOT DISTINCT (hand-written): a batch with no code (or no expiry date) exists once per variant.
CREATE UNIQUE INDEX "RtBatch_businessId_variantId_code_expiryDate_key" ON "RtBatch"("businessId", "variantId", "code", "expiryDate") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "RtStockDocument_businessId_createdAt_idx" ON "RtStockDocument"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "RtStockDocument_businessId_importBatchId_idx" ON "RtStockDocument"("businessId", "importBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "RtStockDocument_businessId_id_key" ON "RtStockDocument"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RtStockDocument_businessId_number_key" ON "RtStockDocument"("businessId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "RtStockDocument_businessId_reversesDocumentId_key" ON "RtStockDocument"("businessId", "reversesDocumentId");

-- CreateIndex
CREATE INDEX "RtStockLine_businessId_variantId_idx" ON "RtStockLine"("businessId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "RtStockLine_businessId_id_key" ON "RtStockLine"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RtStockLine_businessId_documentId_id_key" ON "RtStockLine"("businessId", "documentId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RtStockLine_businessId_documentId_lineNo_key" ON "RtStockLine"("businessId", "documentId", "lineNo");

-- CreateIndex
CREATE INDEX "RtStockMovement_businessId_variantId_createdAt_idx" ON "RtStockMovement"("businessId", "variantId", "createdAt");

-- CreateIndex
CREATE INDEX "RtStockMovement_businessId_documentId_idx" ON "RtStockMovement"("businessId", "documentId");

-- CreateIndex
CREATE INDEX "RtStockBalance_businessId_variantId_idx" ON "RtStockBalance"("businessId", "variantId");

-- CreateIndex
-- NULLS NOT DISTINCT (hand-written): one "no batch" balance row per (location, variant).
CREATE UNIQUE INDEX "RtStockBalance_businessId_locationId_variantId_batchId_key" ON "RtStockBalance"("businessId", "locationId", "variantId", "batchId") NULLS NOT DISTINCT;

-- CreateIndex
CREATE UNIQUE INDEX "RtStockCounter_businessId_key" ON "RtStockCounter"("businessId");

-- AddForeignKey
ALTER TABLE "RtBatch" ADD CONSTRAINT "RtBatch_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtBatch" ADD CONSTRAINT "RtBatch_businessId_variantId_fkey" FOREIGN KEY ("businessId", "variantId") REFERENCES "RtVariant"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockDocument" ADD CONSTRAINT "RtStockDocument_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockDocument" ADD CONSTRAINT "RtStockDocument_businessId_branchId_fkey" FOREIGN KEY ("businessId", "branchId") REFERENCES "RtBranch"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockDocument" ADD CONSTRAINT "RtStockDocument_businessId_branchId_locationId_fkey" FOREIGN KEY ("businessId", "branchId", "locationId") REFERENCES "RtLocation"("businessId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockDocument" ADD CONSTRAINT "RtStockDocument_businessId_reversesDocumentId_fkey" FOREIGN KEY ("businessId", "reversesDocumentId") REFERENCES "RtStockDocument"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockDocument" ADD CONSTRAINT "RtStockDocument_businessId_importBatchId_fkey" FOREIGN KEY ("businessId", "importBatchId") REFERENCES "RtImportBatch"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockLine" ADD CONSTRAINT "RtStockLine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockLine" ADD CONSTRAINT "RtStockLine_businessId_documentId_fkey" FOREIGN KEY ("businessId", "documentId") REFERENCES "RtStockDocument"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockLine" ADD CONSTRAINT "RtStockLine_businessId_variantId_fkey" FOREIGN KEY ("businessId", "variantId") REFERENCES "RtVariant"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockLine" ADD CONSTRAINT "RtStockLine_businessId_unitId_fkey" FOREIGN KEY ("businessId", "unitId") REFERENCES "RtUnit"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockLine" ADD CONSTRAINT "RtStockLine_businessId_variantId_batchId_fkey" FOREIGN KEY ("businessId", "variantId", "batchId") REFERENCES "RtBatch"("businessId", "variantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockMovement" ADD CONSTRAINT "RtStockMovement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockMovement" ADD CONSTRAINT "RtStockMovement_businessId_branchId_fkey" FOREIGN KEY ("businessId", "branchId") REFERENCES "RtBranch"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockMovement" ADD CONSTRAINT "RtStockMovement_businessId_branchId_locationId_fkey" FOREIGN KEY ("businessId", "branchId", "locationId") REFERENCES "RtLocation"("businessId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockMovement" ADD CONSTRAINT "RtStockMovement_businessId_documentId_fkey" FOREIGN KEY ("businessId", "documentId") REFERENCES "RtStockDocument"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockMovement" ADD CONSTRAINT "RtStockMovement_businessId_documentId_lineId_fkey" FOREIGN KEY ("businessId", "documentId", "lineId") REFERENCES "RtStockLine"("businessId", "documentId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockMovement" ADD CONSTRAINT "RtStockMovement_businessId_variantId_fkey" FOREIGN KEY ("businessId", "variantId") REFERENCES "RtVariant"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockMovement" ADD CONSTRAINT "RtStockMovement_businessId_variantId_batchId_fkey" FOREIGN KEY ("businessId", "variantId", "batchId") REFERENCES "RtBatch"("businessId", "variantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockBalance" ADD CONSTRAINT "RtStockBalance_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockBalance" ADD CONSTRAINT "RtStockBalance_businessId_branchId_fkey" FOREIGN KEY ("businessId", "branchId") REFERENCES "RtBranch"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockBalance" ADD CONSTRAINT "RtStockBalance_businessId_branchId_locationId_fkey" FOREIGN KEY ("businessId", "branchId", "locationId") REFERENCES "RtLocation"("businessId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockBalance" ADD CONSTRAINT "RtStockBalance_businessId_variantId_fkey" FOREIGN KEY ("businessId", "variantId") REFERENCES "RtVariant"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockBalance" ADD CONSTRAINT "RtStockBalance_businessId_variantId_batchId_fkey" FOREIGN KEY ("businessId", "variantId", "batchId") REFERENCES "RtBatch"("businessId", "variantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtStockCounter" ADD CONSTRAINT "RtStockCounter_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraints (Prisma cannot express them).
-- Batches: a lot code, when given, is not blank (no code is NULL).
ALTER TABLE "RtBatch"
    ADD CONSTRAINT "RtBatch_code_not_blank" CHECK ("code" IS NULL OR btrim("code") <> '');
-- Documents: a POSTED document has its number and posting time; numbers start at 1. Only a REVERSAL
-- names a reversed document, it always does, and never itself. (Unique reversesDocumentId above:
-- a document is reversed at most once.)
ALTER TABLE "RtStockDocument"
    ADD CONSTRAINT "RtStockDocument_posted_has_number" CHECK ("status" = 'DRAFT' OR ("number" IS NOT NULL AND "postedAt" IS NOT NULL));
ALTER TABLE "RtStockDocument"
    ADD CONSTRAINT "RtStockDocument_number_positive" CHECK ("number" IS NULL OR "number" >= 1);
ALTER TABLE "RtStockDocument"
    ADD CONSTRAINT "RtStockDocument_reversal_names_document" CHECK (("kind" = 'REVERSAL') = ("reversesDocumentId" IS NOT NULL));
ALTER TABLE "RtStockDocument"
    ADD CONSTRAINT "RtStockDocument_not_self_reversal" CHECK ("reversesDocumentId" IS NULL OR "reversesDocumentId" <> "id");
-- Lines: numbered from 1; a positive quantity (the direction comes from the document); costs and
-- values never negative; a rate is positive; a cost names its currency.
ALTER TABLE "RtStockLine"
    ADD CONSTRAINT "RtStockLine_line_no_positive" CHECK ("lineNo" >= 1);
ALTER TABLE "RtStockLine"
    ADD CONSTRAINT "RtStockLine_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "RtStockLine"
    ADD CONSTRAINT "RtStockLine_values_nonneg" CHECK (("unitCostMinor" IS NULL OR "unitCostMinor" >= 0) AND ("valueMinor" IS NULL OR "valueMinor" >= 0));
ALTER TABLE "RtStockLine"
    ADD CONSTRAINT "RtStockLine_rate_positive" CHECK ("rateMicro" IS NULL OR "rateMicro" > 0);
ALTER TABLE "RtStockLine"
    ADD CONSTRAINT "RtStockLine_cost_has_currency" CHECK ("unitCostMinor" IS NULL OR "currency" IS NOT NULL);
-- Movements: every movement moves stock, and its value moves the same way as the quantity (an
-- inflow never lowers the value, an outflow never raises it; 0 is allowed both ways).
ALTER TABLE "RtStockMovement"
    ADD CONSTRAINT "RtStockMovement_qty_nonzero" CHECK ("qtyDelta" <> 0);
ALTER TABLE "RtStockMovement"
    ADD CONSTRAINT "RtStockMovement_value_follows_qty" CHECK ("valueDeltaMinor" = 0 OR ("valueDeltaMinor" > 0) = ("qtyDelta" > 0));
-- Balances: never negative stock. valueMinor is not checked: a batch row's value can drop below
-- zero because an outflow takes the variant's average cost across its batches.
ALTER TABLE "RtStockBalance"
    ADD CONSTRAINT "RtStockBalance_qty_nonneg" CHECK ("qty" >= 0);
-- The document counter starts at 1.
ALTER TABLE "RtStockCounter"
    ADD CONSTRAINT "RtStockCounter_next_number_positive" CHECK ("nextNumber" >= 1);

-- The ledger is append-only: any UPDATE or DELETE of a movement raises (a correction is a new
-- REVERSAL document). TRUNCATE is not covered (the test suite truncates between tests).
CREATE FUNCTION "RtStockMovement_append_only"() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    -- Default SQLSTATE P0001 (raise_exception): the client keeps this message. An integrity code
    -- such as restrict_violation would be reported by Prisma as a bare foreign key error.
    RAISE EXCEPTION 'RtStockMovement is append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER "RtStockMovement_append_only"
    BEFORE UPDATE OR DELETE ON "RtStockMovement"
    FOR EACH ROW EXECUTE FUNCTION "RtStockMovement_append_only"();
