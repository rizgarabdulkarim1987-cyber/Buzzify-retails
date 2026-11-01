-- AlterTable
ALTER TABLE "RtVariant" ADD COLUMN     "stockStartedAt" TIMESTAMP(3);

-- Backfill: the first movement of each variant (any branch).
UPDATE "RtVariant" v
SET "stockStartedAt" = m."first"
FROM (SELECT "variantId", min("createdAt") AS "first" FROM "RtStockMovement" GROUP BY "variantId") m
WHERE m."variantId" = v."id";
