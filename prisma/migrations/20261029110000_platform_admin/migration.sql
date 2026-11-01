-- CreateEnum
CREATE TYPE "Capability" AS ENUM ('VARIANTS', 'SERIAL', 'BATCH', 'WEIGHT', 'MULTI_UNIT', 'WARRANTY', 'WHOLESALE', 'LOYALTY', 'CREDIT', 'HOLDS', 'TRANSFERS');

-- CreateTable
CREATE TABLE "RtPlatformAdmin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RtPlatformAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtCapability" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "capability" "Capability" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RtCapability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtInvitation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RtInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RtPlatformAdmin_userId_key" ON "RtPlatformAdmin"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RtCapability_businessId_capability_key" ON "RtCapability"("businessId", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "RtInvitation_tokenHash_key" ON "RtInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "RtInvitation_businessId_createdAt_idx" ON "RtInvitation"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "RtPlatformAdmin" ADD CONSTRAINT "RtPlatformAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtCapability" ADD CONSTRAINT "RtCapability_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtInvitation" ADD CONSTRAINT "RtInvitation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Hand-written constraints (Prisma cannot express them).

-- Only the sha256 hex digest of an invitation token is ever stored, never the raw token.
ALTER TABLE "RtInvitation"
    ADD CONSTRAINT "RtInvitation_tokenHash_sha256_hex" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

-- Invitation emails are stored lowercase (acceptance compares case-insensitively).
ALTER TABLE "RtInvitation"
    ADD CONSTRAINT "RtInvitation_email_lowercase" CHECK ("email" = lower("email"));

-- At most one open (unused, not superseded) invitation per business: only the newest link works.
CREATE UNIQUE INDEX "RtInvitation_one_open_per_business"
    ON "RtInvitation"("businessId")
    WHERE "usedAt" IS NULL AND "supersededAt" IS NULL;
