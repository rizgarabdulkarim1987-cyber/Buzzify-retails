-- CreateTable
CREATE TABLE "RtLoginAttempt" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RtLoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RtLoginAttempt_key_at_idx" ON "RtLoginAttempt"("key", "at");
