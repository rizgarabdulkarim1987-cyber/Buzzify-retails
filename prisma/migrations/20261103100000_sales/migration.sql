-- R3 sales, first slice (a market's cash desk): shifts, sales, sale lines, payments and the per-branch
-- sale number counter, and the SALE stock document kind (the stock side of a sale). Additive only.
--
-- Hand-written part (Prisma cannot express it, so the drift check does not see it): the partial
-- unique index and the CHECKs at the end of this file.
-- CreateEnum
CREATE TYPE "RtShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "RtSaleStatus" AS ENUM ('POSTED');

-- CreateEnum
CREATE TYPE "RtPaymentMethod" AS ENUM ('CASH', 'CARD');

-- AlterEnum
ALTER TYPE "RtStockDocumentKind" ADD VALUE 'SALE';

-- CreateTable
CREATE TABLE "RtShift" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "terminalId" TEXT,
    "openedById" TEXT NOT NULL,
    "status" "RtShiftStatus" NOT NULL DEFAULT 'OPEN',
    "currency" "Currency" NOT NULL,
    "openingCashMinor" BIGINT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "countedCashMinor" BIGINT,
    "expectedCashMinor" BIGINT,
    "differenceMinor" BIGINT,
    "closeNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtSale" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "stockDocumentId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "saleKey" TEXT NOT NULL,
    "status" "RtSaleStatus" NOT NULL DEFAULT 'POSTED',
    "currency" "Currency" NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "paidMinor" BIGINT NOT NULL,
    "changeMinor" BIGINT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "cashierId" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RtSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtSaleLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "variantId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameCkb" TEXT,
    "nameEn" TEXT,
    "unitName" TEXT NOT NULL,
    "enteredQuantity" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "listPriceMinor" BIGINT NOT NULL,
    "unitPriceMinor" BIGINT NOT NULL,
    "priceId" TEXT,
    "lineTotalMinor" BIGINT NOT NULL,
    "costMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RtSaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtPayment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "method" "RtPaymentMethod" NOT NULL,
    "currency" "Currency" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "tenderedMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RtPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtSaleCounter" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "RtSaleCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RtShift_businessId_branchId_status_idx" ON "RtShift"("businessId", "branchId", "status");

-- CreateIndex
CREATE INDEX "RtShift_businessId_openedById_status_idx" ON "RtShift"("businessId", "openedById", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RtShift_businessId_id_key" ON "RtShift"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RtShift_businessId_branchId_id_key" ON "RtShift"("businessId", "branchId", "id");

-- CreateIndex
CREATE INDEX "RtSale_businessId_shiftId_idx" ON "RtSale"("businessId", "shiftId");

-- CreateIndex
CREATE INDEX "RtSale_businessId_branchId_postedAt_idx" ON "RtSale"("businessId", "branchId", "postedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RtSale_businessId_id_key" ON "RtSale"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RtSale_businessId_branchId_id_key" ON "RtSale"("businessId", "branchId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RtSale_businessId_branchId_number_key" ON "RtSale"("businessId", "branchId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "RtSale_businessId_saleKey_key" ON "RtSale"("businessId", "saleKey");

-- CreateIndex
CREATE UNIQUE INDEX "RtSale_businessId_branchId_locationId_stockDocumentId_key" ON "RtSale"("businessId", "branchId", "locationId", "stockDocumentId");

-- CreateIndex
CREATE INDEX "RtSaleLine_businessId_variantId_idx" ON "RtSaleLine"("businessId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "RtSaleLine_businessId_saleId_lineNo_key" ON "RtSaleLine"("businessId", "saleId", "lineNo");

-- CreateIndex
CREATE INDEX "RtPayment_businessId_saleId_idx" ON "RtPayment"("businessId", "saleId");

-- CreateIndex
CREATE INDEX "RtPayment_businessId_shiftId_idx" ON "RtPayment"("businessId", "shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "RtSaleCounter_businessId_branchId_key" ON "RtSaleCounter"("businessId", "branchId");

-- AddForeignKey
ALTER TABLE "RtShift" ADD CONSTRAINT "RtShift_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtShift" ADD CONSTRAINT "RtShift_businessId_branchId_fkey" FOREIGN KEY ("businessId", "branchId") REFERENCES "RtBranch"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtShift" ADD CONSTRAINT "RtShift_businessId_branchId_locationId_fkey" FOREIGN KEY ("businessId", "branchId", "locationId") REFERENCES "RtLocation"("businessId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtSale" ADD CONSTRAINT "RtSale_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtSale" ADD CONSTRAINT "RtSale_businessId_branchId_shiftId_fkey" FOREIGN KEY ("businessId", "branchId", "shiftId") REFERENCES "RtShift"("businessId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtSale" ADD CONSTRAINT "RtSale_businessId_branchId_locationId_stockDocumentId_fkey" FOREIGN KEY ("businessId", "branchId", "locationId", "stockDocumentId") REFERENCES "RtStockDocument"("businessId", "branchId", "locationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtSaleLine" ADD CONSTRAINT "RtSaleLine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtSaleLine" ADD CONSTRAINT "RtSaleLine_businessId_branchId_saleId_fkey" FOREIGN KEY ("businessId", "branchId", "saleId") REFERENCES "RtSale"("businessId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtSaleLine" ADD CONSTRAINT "RtSaleLine_businessId_variantId_fkey" FOREIGN KEY ("businessId", "variantId") REFERENCES "RtVariant"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtSaleLine" ADD CONSTRAINT "RtSaleLine_businessId_unitId_fkey" FOREIGN KEY ("businessId", "unitId") REFERENCES "RtUnit"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtPayment" ADD CONSTRAINT "RtPayment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtPayment" ADD CONSTRAINT "RtPayment_businessId_branchId_saleId_fkey" FOREIGN KEY ("businessId", "branchId", "saleId") REFERENCES "RtSale"("businessId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtPayment" ADD CONSTRAINT "RtPayment_businessId_branchId_shiftId_fkey" FOREIGN KEY ("businessId", "branchId", "shiftId") REFERENCES "RtShift"("businessId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtSaleCounter" ADD CONSTRAINT "RtSaleCounter_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtSaleCounter" ADD CONSTRAINT "RtSaleCounter_businessId_branchId_fkey" FOREIGN KEY ("businessId", "branchId") REFERENCES "RtBranch"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraints.
-- One OPEN shift per person in a business (a closed shift never blocks a new one).
CREATE UNIQUE INDEX "RtShift_one_open_per_person" ON "RtShift"("businessId", "openedById") WHERE "status" = 'OPEN';
ALTER TABLE "RtShift"
    ADD CONSTRAINT "RtShift_opening_nonneg" CHECK ("openingCashMinor" >= 0),
    ADD CONSTRAINT "RtShift_counted_nonneg" CHECK ("countedCashMinor" IS NULL OR "countedCashMinor" >= 0),
    ADD CONSTRAINT "RtShift_closed_fields" CHECK (
        ("status" = 'CLOSED') = ("closedAt" IS NOT NULL)
        AND ("status" = 'CLOSED') = ("closedById" IS NOT NULL)
        AND ("status" = 'CLOSED') = ("countedCashMinor" IS NOT NULL)
        AND ("status" = 'CLOSED') = ("expectedCashMinor" IS NOT NULL)
        AND ("status" = 'CLOSED') = ("differenceMinor" IS NOT NULL)
    ),
    ADD CONSTRAINT "RtShift_difference" CHECK ("status" <> 'CLOSED' OR "differenceMinor" = "countedCashMinor" - "expectedCashMinor");

ALTER TABLE "RtSale"
    ADD CONSTRAINT "RtSale_number_positive" CHECK ("number" >= 1),
    ADD CONSTRAINT "RtSale_totals_nonneg" CHECK ("totalMinor" >= 0 AND "paidMinor" >= "totalMinor"),
    ADD CONSTRAINT "RtSale_change" CHECK ("changeMinor" = "paidMinor" - "totalMinor"),
    ADD CONSTRAINT "RtSale_has_lines" CHECK ("lineCount" >= 1),
    ADD CONSTRAINT "RtSale_key_not_blank" CHECK (length("saleKey") >= 1);

ALTER TABLE "RtSaleLine"
    ADD CONSTRAINT "RtSaleLine_line_no_positive" CHECK ("lineNo" >= 1),
    ADD CONSTRAINT "RtSaleLine_quantity_positive" CHECK ("quantity" > 0),
    ADD CONSTRAINT "RtSaleLine_amounts_nonneg" CHECK (
        "listPriceMinor" >= 0 AND "unitPriceMinor" >= 0 AND "lineTotalMinor" >= 0 AND "costMinor" >= 0
    );

ALTER TABLE "RtPayment"
    ADD CONSTRAINT "RtPayment_amount_positive" CHECK ("amountMinor" > 0),
    ADD CONSTRAINT "RtPayment_tendered" CHECK ("tenderedMinor" >= "amountMinor"),
    ADD CONSTRAINT "RtPayment_card_exact" CHECK ("method" <> 'CARD' OR "tenderedMinor" = "amountMinor");

ALTER TABLE "RtSaleCounter"
    ADD CONSTRAINT "RtSaleCounter_next_positive" CHECK ("nextNumber" >= 1);