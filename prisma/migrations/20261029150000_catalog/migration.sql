-- R1 catalog: categories, brands, products, variants, units, barcodes, price lists, dated prices,
-- and the per-business SKU counter. Also the RtStaff(userId) index carried over from R0.

-- Extensions (checked 2026-10-29): both ship as contrib modules. The embedded PostgreSQL used by the
-- tests (embedded-postgres 18.4.0-beta.17, PostgreSQL 18.4) has btree_gist 1.8 and pg_trgm 1.6, and
-- CREATE EXTENSION works in a scratch database. The CI service image (postgres:17, official) bundles
-- contrib (btree_gist 1.7, pg_trgm 1.6). btree_gist has had enum support since 1.5, so the exclusion
-- constraint below can compare the "Currency" enum directly. Hence EXCLUDE USING gist, not a trigger.
-- Prisma does not track extensions (no postgresqlExtensions preview), so these lines are hand-written
-- and invisible to the drift check.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "RtTrackingMode" AS ENUM ('NONE', 'BATCH', 'SERIAL');

-- CreateEnum
CREATE TYPE "RtPriceListKind" AS ENUM ('DEFAULT', 'WHOLESALE');

-- CreateTable
CREATE TABLE "RtCategory" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "parentId" TEXT,
    "nameAr" TEXT NOT NULL,
    "nameCkb" TEXT,
    "nameEn" TEXT,
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtBrand" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameCkb" TEXT,
    "nameEn" TEXT,
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtBrand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtProduct" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameCkb" TEXT,
    "nameEn" TEXT,
    "descriptionAr" TEXT,
    "descriptionCkb" TEXT,
    "descriptionEn" TEXT,
    "categoryId" TEXT,
    "brandId" TEXT,
    "trackingMode" "RtTrackingMode" NOT NULL DEFAULT 'NONE',
    "soldByWeight" BOOLEAN NOT NULL DEFAULT false,
    "tracksExpiry" BOOLEAN NOT NULL DEFAULT false,
    "expiryAlertDays" INTEGER,
    "searchText" TEXT NOT NULL DEFAULT '',
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtVariant" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "options" JSONB,
    "searchText" TEXT NOT NULL DEFAULT '',
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtUnit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "factor" INTEGER NOT NULL,
    "isBase" BOOLEAN NOT NULL DEFAULT false,
    "quantityScale" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtBarcode" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtBarcode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtPriceList" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "RtPriceListKind" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtPriceList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtPrice" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtCatalogCounter" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "nextSku" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "RtCatalogCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RtCategory_businessId_parentId_idx" ON "RtCategory"("businessId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "RtCategory_businessId_id_key" ON "RtCategory"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RtBrand_businessId_id_key" ON "RtBrand"("businessId", "id");

-- CreateIndex
CREATE INDEX "RtProduct_businessId_categoryId_idx" ON "RtProduct"("businessId", "categoryId");

-- CreateIndex
CREATE INDEX "RtProduct_businessId_brandId_idx" ON "RtProduct"("businessId", "brandId");

-- CreateIndex
CREATE INDEX "RtProduct_searchText_idx" ON "RtProduct" USING GIN ("searchText" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "RtProduct_businessId_id_key" ON "RtProduct"("businessId", "id");

-- CreateIndex
CREATE INDEX "RtVariant_businessId_productId_idx" ON "RtVariant"("businessId", "productId");

-- CreateIndex
CREATE INDEX "RtVariant_searchText_idx" ON "RtVariant" USING GIN ("searchText" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "RtVariant_businessId_sku_key" ON "RtVariant"("businessId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "RtVariant_businessId_id_key" ON "RtVariant"("businessId", "id");

-- CreateIndex
CREATE INDEX "RtUnit_businessId_variantId_idx" ON "RtUnit"("businessId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "RtUnit_businessId_id_key" ON "RtUnit"("businessId", "id");

-- CreateIndex
CREATE INDEX "RtBarcode_businessId_unitId_idx" ON "RtBarcode"("businessId", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "RtBarcode_businessId_code_key" ON "RtBarcode"("businessId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "RtPriceList_businessId_kind_key" ON "RtPriceList"("businessId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "RtPriceList_businessId_id_key" ON "RtPriceList"("businessId", "id");

-- CreateIndex
CREATE INDEX "RtPrice_businessId_unitId_priceListId_currency_validFrom_idx" ON "RtPrice"("businessId", "unitId", "priceListId", "currency", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "RtCatalogCounter_businessId_key" ON "RtCatalogCounter"("businessId");

-- CreateIndex
CREATE INDEX "RtStaff_userId_idx" ON "RtStaff"("userId");

-- AddForeignKey
ALTER TABLE "RtCategory" ADD CONSTRAINT "RtCategory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtCategory" ADD CONSTRAINT "RtCategory_businessId_parentId_fkey" FOREIGN KEY ("businessId", "parentId") REFERENCES "RtCategory"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtBrand" ADD CONSTRAINT "RtBrand_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtProduct" ADD CONSTRAINT "RtProduct_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtProduct" ADD CONSTRAINT "RtProduct_businessId_categoryId_fkey" FOREIGN KEY ("businessId", "categoryId") REFERENCES "RtCategory"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtProduct" ADD CONSTRAINT "RtProduct_businessId_brandId_fkey" FOREIGN KEY ("businessId", "brandId") REFERENCES "RtBrand"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtVariant" ADD CONSTRAINT "RtVariant_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtVariant" ADD CONSTRAINT "RtVariant_businessId_productId_fkey" FOREIGN KEY ("businessId", "productId") REFERENCES "RtProduct"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtUnit" ADD CONSTRAINT "RtUnit_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtUnit" ADD CONSTRAINT "RtUnit_businessId_variantId_fkey" FOREIGN KEY ("businessId", "variantId") REFERENCES "RtVariant"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtBarcode" ADD CONSTRAINT "RtBarcode_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtBarcode" ADD CONSTRAINT "RtBarcode_businessId_unitId_fkey" FOREIGN KEY ("businessId", "unitId") REFERENCES "RtUnit"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtPriceList" ADD CONSTRAINT "RtPriceList_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtPrice" ADD CONSTRAINT "RtPrice_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtPrice" ADD CONSTRAINT "RtPrice_businessId_unitId_fkey" FOREIGN KEY ("businessId", "unitId") REFERENCES "RtUnit"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtPrice" ADD CONSTRAINT "RtPrice_businessId_priceListId_fkey" FOREIGN KEY ("businessId", "priceListId") REFERENCES "RtPriceList"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtCatalogCounter" ADD CONSTRAINT "RtCatalogCounter_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written constraints (Prisma cannot express them).

-- Tracking: expiry lives in a batch, so tracksExpiry needs trackingMode BATCH; the alert lead time is positive.
ALTER TABLE "RtProduct"
    ADD CONSTRAINT "RtProduct_expiry_needs_batch" CHECK (NOT "tracksExpiry" OR "trackingMode" = 'BATCH');
ALTER TABLE "RtProduct"
    ADD CONSTRAINT "RtProduct_expiry_alert_days_positive" CHECK ("expiryAlertDays" IS NULL OR "expiryAlertDays" > 0);

-- Units: a positive whole factor to the base unit; the base unit's factor is 1; 0..3 decimal places.
ALTER TABLE "RtUnit"
    ADD CONSTRAINT "RtUnit_factor_positive" CHECK ("factor" > 0);
ALTER TABLE "RtUnit"
    ADD CONSTRAINT "RtUnit_base_factor_one" CHECK (NOT "isBase" OR "factor" = 1);
ALTER TABLE "RtUnit"
    ADD CONSTRAINT "RtUnit_quantity_scale_range" CHECK ("quantityScale" BETWEEN 0 AND 3);
-- At most one base unit per variant (archived ones included: the base unit is never replaced).
-- That every variant has one is enforced by the catalog actions, which create both in one transaction.
CREATE UNIQUE INDEX "RtUnit_one_base_per_variant" ON "RtUnit"("variantId") WHERE "isBase";

-- Prices: never negative (0 = free); a closed period ends after it starts; and no two periods of
-- one (unit, list, currency) overlap. Periods are half-open [validFrom, validTo); a NULL validTo is
-- unbounded, so two open periods always overlap and at most one open period can exist.
ALTER TABLE "RtPrice"
    ADD CONSTRAINT "RtPrice_amount_nonneg" CHECK ("amountMinor" >= 0);
ALTER TABLE "RtPrice"
    ADD CONSTRAINT "RtPrice_valid_to_after_from" CHECK ("validTo" IS NULL OR "validTo" > "validFrom");
ALTER TABLE "RtPrice"
    ADD CONSTRAINT "RtPrice_no_overlap" EXCLUDE USING gist (
        "businessId" WITH =,
        "unitId" WITH =,
        "priceListId" WITH =,
        "currency" WITH =,
        tsrange("validFrom", "validTo", '[)') WITH &&
    );

-- The SKU counter starts at 1.
ALTER TABLE "RtCatalogCounter"
    ADD CONSTRAINT "RtCatalogCounter_next_sku_positive" CHECK ("nextSku" >= 1);
