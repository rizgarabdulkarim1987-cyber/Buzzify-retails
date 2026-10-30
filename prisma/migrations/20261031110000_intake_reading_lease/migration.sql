-- R1b intake, review round 1: the read lease on RtIntake (readingStartedAt, readingAttemptId) and the
-- byte size of each stored page (RtIntakeFile.size, summed against the plan's storageMb). Additive only.
--
-- Hand-written parts: the backfill of size from the stored bytes and the CHECK size >= 0.

-- AlterTable
ALTER TABLE "RtIntake" ADD COLUMN     "readingAttemptId" TEXT,
ADD COLUMN     "readingStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RtIntakeFile" ADD COLUMN     "size" INTEGER NOT NULL DEFAULT 0;

UPDATE "RtIntakeFile" SET "size" = octet_length("bytes");

ALTER TABLE "RtIntakeFile" ADD CONSTRAINT "RtIntakeFile_size_nonneg" CHECK ("size" >= 0);
