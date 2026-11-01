-- R2 stock adjustments (Task 5): the direction of an ADJUSTMENT / WRITE_OFF document. A line's
-- quantity is always positive, so the way the stock moves is kept on the document.
--
-- Hand-written part (Prisma cannot express it, so the drift check does not see it): the two CHECKs
-- at the end of this file.

-- CreateEnum
CREATE TYPE "RtStockDirection" AS ENUM ('IN', 'OUT');

-- AlterTable
ALTER TABLE "RtStockDocument" ADD COLUMN     "direction" "RtStockDirection";

-- Hand-written constraints.
-- A direction is set exactly for an ADJUSTMENT or a WRITE_OFF, and a WRITE_OFF always goes OUT
-- (a REVERSAL takes its way from the movements it negates, so it has none).
ALTER TABLE "RtStockDocument"
    ADD CONSTRAINT "RtStockDocument_direction_of_kind" CHECK (
        ("kind" IN ('ADJUSTMENT', 'WRITE_OFF')) = ("direction" IS NOT NULL)
        AND ("kind" <> 'WRITE_OFF' OR "direction" = 'OUT')
    );
-- An ADJUSTMENT or a WRITE_OFF always says why (spec 3.9).
ALTER TABLE "RtStockDocument"
    ADD CONSTRAINT "RtStockDocument_adjustment_has_reason" CHECK ("kind" NOT IN ('ADJUSTMENT', 'WRITE_OFF') OR "reason" IS NOT NULL);
