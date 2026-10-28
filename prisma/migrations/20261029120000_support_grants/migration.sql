-- CreateEnum
CREATE TYPE "SupportScope" AS ENUM ('catalog.read', 'stock.read', 'sales.read');

-- CreateTable
CREATE TABLE "RtSupportGrant" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "granteeId" TEXT NOT NULL,
    "scopes" "SupportScope"[],
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RtSupportGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RtSupportGrant_businessId_createdAt_idx" ON "RtSupportGrant"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "RtSupportGrant_granteeId_idx" ON "RtSupportGrant"("granteeId");

-- AddForeignKey
ALTER TABLE "RtSupportGrant" ADD CONSTRAINT "RtSupportGrant_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtSupportGrant" ADD CONSTRAINT "RtSupportGrant_granteeId_fkey" FOREIGN KEY ("granteeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtSupportGrant" ADD CONSTRAINT "RtSupportGrant_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraints (Prisma cannot express them).

-- A grant states why (at least 10 characters), covers at least one scope, and lives at most 72 hours.
ALTER TABLE "RtSupportGrant"
    ADD CONSTRAINT "RtSupportGrant_reason_min_length" CHECK (char_length("reason") >= 10);
ALTER TABLE "RtSupportGrant"
    ADD CONSTRAINT "RtSupportGrant_scopes_not_empty" CHECK (cardinality("scopes") >= 1);
ALTER TABLE "RtSupportGrant"
    ADD CONSTRAINT "RtSupportGrant_expires_after_created" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "RtSupportGrant"
    ADD CONSTRAINT "RtSupportGrant_max_72_hours" CHECK ("expiresAt" <= "createdAt" + interval '72 hours');
