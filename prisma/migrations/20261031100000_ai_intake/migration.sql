-- R1b AI intake: the owner's AI consent on RtBusiness, intakes (an uploaded purchase receipt and
-- what the AI read from it), their pages (bytes stored in the database), and the monthly AI usage
-- counter per business. Additive only.
--
-- Hand-written parts (Prisma cannot express them, so the drift check does not see them): the CHECK
-- constraints at the end of this file.

-- CreateEnum
CREATE TYPE "RtIntakeKind" AS ENUM ('PURCHASE_RECEIPT');

-- CreateEnum
CREATE TYPE "RtIntakeStatus" AS ENUM ('UPLOADED', 'READING', 'READ', 'FAILED', 'DRAFTED', 'DISCARDED');

-- AlterTable
ALTER TABLE "RtBusiness" ADD COLUMN     "aiConsentAt" TIMESTAMP(3),
ADD COLUMN     "aiConsentVersion" INTEGER;

-- CreateTable
CREATE TABLE "RtIntake" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" "RtIntakeKind" NOT NULL DEFAULT 'PURCHASE_RECEIPT',
    "status" "RtIntakeStatus" NOT NULL DEFAULT 'UPLOADED',
    "createdById" TEXT NOT NULL,
    "filesHash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "usageHalfUnits" INTEGER NOT NULL DEFAULT 0,
    "month" TEXT,
    "result" JSONB,
    "failureCode" TEXT,
    "stockDocumentId" TEXT,
    "refundedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtIntake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtIntakeFile" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "intakeId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RtIntakeFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtAiUsage" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "halfUnits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RtAiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RtIntake_businessId_filesHash_idx" ON "RtIntake"("businessId", "filesHash");

-- CreateIndex
CREATE INDEX "RtIntake_businessId_createdAt_idx" ON "RtIntake"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RtIntake_businessId_id_key" ON "RtIntake"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RtIntakeFile_businessId_intakeId_position_key" ON "RtIntakeFile"("businessId", "intakeId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "RtAiUsage_businessId_month_key" ON "RtAiUsage"("businessId", "month");

-- AddForeignKey
ALTER TABLE "RtIntake" ADD CONSTRAINT "RtIntake_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtIntakeFile" ADD CONSTRAINT "RtIntakeFile_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtIntakeFile" ADD CONSTRAINT "RtIntakeFile_businessId_intakeId_fkey" FOREIGN KEY ("businessId", "intakeId") REFERENCES "RtIntake"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtAiUsage" ADD CONSTRAINT "RtAiUsage_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written constraints (Prisma cannot express them).
-- Usage is counted in half units (2 = one receipt read, 1 = one AI barcode fallback), never below 0.
-- A month is the business-local YYYY-MM.
ALTER TABLE "RtIntake"
    ADD CONSTRAINT "RtIntake_usage_half_units_nonneg" CHECK ("usageHalfUnits" >= 0);
ALTER TABLE "RtIntake"
    ADD CONSTRAINT "RtIntake_month_format" CHECK ("month" IS NULL OR "month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
-- Pages are numbered from 1.
ALTER TABLE "RtIntakeFile"
    ADD CONSTRAINT "RtIntakeFile_position_positive" CHECK ("position" >= 1);
ALTER TABLE "RtAiUsage"
    ADD CONSTRAINT "RtAiUsage_half_units_nonneg" CHECK ("halfUnits" >= 0);
ALTER TABLE "RtAiUsage"
    ADD CONSTRAINT "RtAiUsage_month_format" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
