-- A staged row may name the variant it matched. Same business only (composite FK). When the
-- variant is deleted only matchedVariantId is cleared (the column list needs PostgreSQL 15+);
-- a plain ON DELETE SET NULL would try to null the NOT NULL businessId as well.
ALTER TABLE "RtImportRow" ADD CONSTRAINT "RtImportRow_businessId_matchedVariantId_fkey" FOREIGN KEY ("businessId", "matchedVariantId") REFERENCES "RtVariant"("businessId", "id") ON DELETE SET NULL ("matchedVariantId") ON UPDATE CASCADE;
