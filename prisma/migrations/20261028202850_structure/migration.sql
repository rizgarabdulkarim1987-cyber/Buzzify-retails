-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('IQD', 'USD');

-- CreateEnum
CREATE TYPE "RtBusinessStatus" AS ENUM ('SETUP', 'ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RtActivityType" AS ENUM ('MARKET', 'CLOTHING', 'ELECTRONICS', 'BEAUTY', 'STATIONERY', 'MIXED');

-- CreateTable
CREATE TABLE "RtBusiness" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "activityType" "RtActivityType" NOT NULL,
    "status" "RtBusinessStatus" NOT NULL DEFAULT 'SETUP',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Baghdad',
    "defaultCurrency" "Currency" NOT NULL,
    "enabledCurrencies" "Currency"[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtBusiness_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtBranch" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtBranch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtLocation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sellable" BOOLEAN NOT NULL DEFAULT true,
    "central" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtTerminal" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtTerminal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RtBranch_businessId_id_key" ON "RtBranch"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RtLocation_businessId_branchId_id_key" ON "RtLocation"("businessId", "branchId", "id");

-- AddForeignKey
ALTER TABLE "RtBranch" ADD CONSTRAINT "RtBranch_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtLocation" ADD CONSTRAINT "RtLocation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtLocation" ADD CONSTRAINT "RtLocation_businessId_branchId_fkey" FOREIGN KEY ("businessId", "branchId") REFERENCES "RtBranch"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtTerminal" ADD CONSTRAINT "RtTerminal_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtTerminal" ADD CONSTRAINT "RtTerminal_businessId_branchId_fkey" FOREIGN KEY ("businessId", "branchId") REFERENCES "RtBranch"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtTerminal" ADD CONSTRAINT "RtTerminal_businessId_branchId_locationId_fkey" FOREIGN KEY ("businessId", "branchId", "locationId") REFERENCES "RtLocation"("businessId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
