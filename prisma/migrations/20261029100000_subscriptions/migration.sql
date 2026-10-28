-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'GRACE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SubscriptionPaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'ZAINCASH', 'FIB', 'QI_CARD', 'OTHER');

-- CreateTable
CREATE TABLE "RtPlan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxBranches" INTEGER NOT NULL,
    "maxTerminals" INTEGER NOT NULL,
    "maxUsers" INTEGER NOT NULL,
    "storageMb" INTEGER NOT NULL,
    "aiMonthly" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtSubscription" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "planCode" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "graceDays" INTEGER NOT NULL DEFAULT 7,
    "cancelledAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtSubscriptionEvent" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromStatus" "SubscriptionStatus",
    "toStatus" "SubscriptionStatus" NOT NULL,
    "actorId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB NOT NULL,

    CONSTRAINT "RtSubscriptionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtSubscriptionPayment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "method" "SubscriptionPaymentMethod" NOT NULL,
    "reference" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "coversFrom" TIMESTAMP(3) NOT NULL,
    "coversTo" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "recordedById" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RtSubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtFeatureOverride" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RtFeatureOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RtPlan_code_key" ON "RtPlan"("code");

-- CreateIndex
CREATE INDEX "RtSubscription_businessId_createdAt_idx" ON "RtSubscription"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "RtSubscriptionEvent_subscriptionId_occurredAt_idx" ON "RtSubscriptionEvent"("subscriptionId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "RtSubscriptionPayment_idempotencyKey_key" ON "RtSubscriptionPayment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "RtSubscriptionPayment_subscriptionId_paidAt_idx" ON "RtSubscriptionPayment"("subscriptionId", "paidAt");

-- CreateIndex
CREATE INDEX "RtFeatureOverride_businessId_feature_idx" ON "RtFeatureOverride"("businessId", "feature");

-- AddForeignKey
ALTER TABLE "RtSubscription" ADD CONSTRAINT "RtSubscription_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtSubscription" ADD CONSTRAINT "RtSubscription_planCode_fkey" FOREIGN KEY ("planCode") REFERENCES "RtPlan"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtSubscriptionEvent" ADD CONSTRAINT "RtSubscriptionEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "RtSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtSubscriptionEvent" ADD CONSTRAINT "RtSubscriptionEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtSubscriptionPayment" ADD CONSTRAINT "RtSubscriptionPayment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtSubscriptionPayment" ADD CONSTRAINT "RtSubscriptionPayment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "RtSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RtFeatureOverride" ADD CONSTRAINT "RtFeatureOverride_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written constraints (Prisma cannot express them).

-- At most one live (TRIAL, ACTIVE, GRACE) subscription per business.
CREATE UNIQUE INDEX "RtSubscription_one_live_per_business"
    ON "RtSubscription"("businessId")
    WHERE "status" IN ('TRIAL', 'ACTIVE', 'GRACE');

-- A manual feature override must carry a real reason.
ALTER TABLE "RtFeatureOverride"
    ADD CONSTRAINT "RtFeatureOverride_reason_min_length" CHECK (char_length("reason") >= 10);

ALTER TABLE "RtSubscription"
    ADD CONSTRAINT "RtSubscription_graceDays_nonneg" CHECK ("graceDays" >= 0);

ALTER TABLE "RtSubscriptionPayment"
    ADD CONSTRAINT "RtSubscriptionPayment_amount_positive" CHECK ("amountMinor" > 0);
