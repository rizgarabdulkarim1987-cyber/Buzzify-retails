-- CreateEnum
CREATE TYPE "RtSetupStatus" AS ENUM ('PENDING', 'DONE', 'SKIPPED');

-- CreateTable
CREATE TABLE "RtSetupProgress" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "status" "RtSetupStatus" NOT NULL DEFAULT 'PENDING',
    "isTestData" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtSetupProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RtSetupProgress_businessId_step_key" ON "RtSetupProgress"("businessId", "step");

-- AddForeignKey
ALTER TABLE "RtSetupProgress" ADD CONSTRAINT "RtSetupProgress_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "RtBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written constraints (Prisma cannot express them).

-- The wizard has nine steps, numbered 1 to 9.
ALTER TABLE "RtSetupProgress"
    ADD CONSTRAINT "RtSetupProgress_step_range" CHECK ("step" BETWEEN 1 AND 9);
-- A DONE step has a completion time; a PENDING one has none.
ALTER TABLE "RtSetupProgress"
    ADD CONSTRAINT "RtSetupProgress_completed_at_matches_status" CHECK (("status" = 'DONE') = ("completedAt" IS NOT NULL));
