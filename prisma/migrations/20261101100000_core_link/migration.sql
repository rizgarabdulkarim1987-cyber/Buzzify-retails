-- Core link (Studio unified admin): link columns on RtBusiness and User, and the single-use handoff
-- token ids table. Additive only.
-- AlterTable
ALTER TABLE "RtBusiness" ADD COLUMN     "coreBusinessId" TEXT,
ADD COLUMN     "coreOwnerUserId" TEXT,
ADD COLUMN     "coreStateVersion" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "coreUserId" TEXT;

-- CreateTable
CREATE TABLE "RtCoreNonce" (
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtCoreNonce_pkey" PRIMARY KEY ("jti")
);

-- CreateIndex
CREATE INDEX "RtCoreNonce_expiresAt_idx" ON "RtCoreNonce"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RtBusiness_coreBusinessId_key" ON "RtBusiness"("coreBusinessId");

-- CreateIndex
CREATE UNIQUE INDEX "User_coreUserId_key" ON "User"("coreUserId");

