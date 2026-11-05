-- CreateEnum
CREATE TYPE "RtExpenseCategory" AS ENUM ('SUPPLIES', 'TRANSPORT', 'UTILITIES', 'CLEANING', 'MAINTENANCE', 'WAGES', 'MEALS', 'OTHER');

-- CreateTable
CREATE TABLE "RtExpense" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "categoryKey" "RtExpenseCategory" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "note" TEXT,
    "expenseKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "RtExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RtExpense_businessId_shiftId_idx" ON "RtExpense"("businessId", "shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "RtExpense_businessId_expenseKey_key" ON "RtExpense"("businessId", "expenseKey");

-- AddForeignKey
ALTER TABLE "RtExpense" ADD CONSTRAINT "RtExpense_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtExpense" ADD CONSTRAINT "RtExpense_businessId_branchId_shiftId_fkey" FOREIGN KEY ("businessId", "branchId", "shiftId") REFERENCES "RtShift"("businessId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraints.
ALTER TABLE "RtExpense"
    ADD CONSTRAINT "RtExpense_amount_positive" CHECK ("amountMinor" > 0),
    ADD CONSTRAINT "RtExpense_void_together" CHECK (
        ("voidedAt" IS NULL) = ("voidedById" IS NULL)
        AND ("voidedAt" IS NULL) = ("voidReason" IS NULL)
    ),
    ADD CONSTRAINT "RtExpense_other_note" CHECK ("categoryKey" <> 'OTHER' OR length(btrim(COALESCE("note", ''))) > 0);
