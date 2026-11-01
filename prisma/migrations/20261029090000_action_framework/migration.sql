-- CreateTable
CREATE TABLE "RtIdempotency" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RtIdempotency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RtAuditLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RtAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RtIdempotency_scope_key_key" ON "RtIdempotency"("scope", "key");

-- CreateIndex
CREATE INDEX "RtAuditLog_businessId_at_idx" ON "RtAuditLog"("businessId", "at");

-- CreateIndex
CREATE INDEX "RtAuditLog_entity_entityId_idx" ON "RtAuditLog"("entity", "entityId");
