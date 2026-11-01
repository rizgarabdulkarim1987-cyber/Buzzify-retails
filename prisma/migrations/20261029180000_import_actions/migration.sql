-- AlterTable
ALTER TABLE "RtImportRow" ADD COLUMN     "normalized" JSONB,
ADD COLUMN     "numericCols" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- CreateTable
CREATE TABLE "RtImportMappingPreset" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RtImportMappingPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RtImportMappingPreset_businessId_name_key" ON "RtImportMappingPreset"("businessId", "name");

-- AddForeignKey
ALTER TABLE "RtImportMappingPreset" ADD CONSTRAINT "RtImportMappingPreset_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
