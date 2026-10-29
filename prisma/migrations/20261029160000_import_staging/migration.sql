-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('STAGED', 'VALIDATED', 'COMMITTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('OK', 'REJECTED', 'SKIPPED', 'CHANGED', 'COMMITTED');

-- CreateTable
CREATE TABLE "RtImportBatch" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'STAGED',
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "mapping" JSONB,
    "stats" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtImportRow" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "status" "ImportRowStatus" NOT NULL,
    "reason" TEXT,
    "matchedVariantId" TEXT,
    "diff" JSONB,
    "resolution" TEXT,

    CONSTRAINT "RtImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RtImportBatch_businessId_createdAt_idx" ON "RtImportBatch"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RtImportBatch_businessId_id_key" ON "RtImportBatch"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RtImportRow_businessId_batchId_rowNumber_key" ON "RtImportRow"("businessId", "batchId", "rowNumber");

-- AddForeignKey
ALTER TABLE "RtImportBatch" ADD CONSTRAINT "RtImportBatch_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtImportRow" ADD CONSTRAINT "RtImportRow_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtImportRow" ADD CONSTRAINT "RtImportRow_businessId_batchId_fkey" FOREIGN KEY ("businessId", "batchId") REFERENCES "RtImportBatch"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written constraints (Prisma cannot express them).
ALTER TABLE "RtImportRow"
    ADD CONSTRAINT "RtImportRow_row_number_positive" CHECK ("rowNumber" >= 1);
ALTER TABLE "RtImportRow"
    ADD CONSTRAINT "RtImportRow_resolution_values" CHECK ("resolution" IS NULL OR "resolution" IN ('UPDATE', 'SKIP'));
