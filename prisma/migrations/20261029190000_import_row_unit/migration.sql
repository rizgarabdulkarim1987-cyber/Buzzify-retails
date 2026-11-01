-- The existing unit a row was compared with. Same business only (composite FK); when the unit is
-- deleted only matchedUnitId is cleared (column list, PostgreSQL 15+), as for matchedVariantId.
ALTER TABLE "RtImportRow" ADD COLUMN "matchedUnitId" TEXT;

ALTER TABLE "RtImportRow" ADD CONSTRAINT "RtImportRow_businessId_matchedUnitId_fkey" FOREIGN KEY ("businessId", "matchedUnitId") REFERENCES "RtUnit"("businessId", "id") ON DELETE SET NULL ("matchedUnitId") ON UPDATE CASCADE;
