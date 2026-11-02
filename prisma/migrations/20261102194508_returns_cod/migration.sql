-- Wave 3 returns + COD (P6-01, P6-02): new tables only (nothing existing is altered).
BEGIN;

-- CreateTable
CREATE TABLE "ReturnCase" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "caseKey" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "fulfillmentId" TEXT,
    "orderId" TEXT,
    "companyId" TEXT,
    "sources" TEXT[],
    "state" TEXT NOT NULL,
    "rawStatus" TEXT,
    "returnType" TEXT,
    "reference" TEXT NOT NULL,
    "trackingNumbers" TEXT[],
    "returnTracking" TEXT[],
    "items" JSONB NOT NULL DEFAULT '[]',
    "photos" JSONB NOT NULL DEFAULT '[]',
    "localReturnUid" TEXT,
    "returningSince" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "processedById" TEXT,
    "processedNote" TEXT,
    "supportNotifyRequestedAt" TIMESTAMP(3),
    "supportNotifiedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnNotification" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "returnCaseId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENDING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "ReturnNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnPhoto" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "returnCaseId" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "contentType" TEXT,
    "bytes" BYTEA,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fetchedAt" TIMESTAMP(3),

    CONSTRAINT "ReturnPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnsCodSettings" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "returnOverdueDays" INTEGER NOT NULL DEFAULT 14,
    "codMissingDays" INTEGER NOT NULL DEFAULT 14,
    "notifySupport" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnsCodSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReturnCase_accountId_state_processedAt_idx" ON "ReturnCase"("accountId", "state", "processedAt");

-- CreateIndex
CREATE INDEX "ReturnCase_accountId_fulfillmentId_idx" ON "ReturnCase"("accountId", "fulfillmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnCase_accountId_id_key" ON "ReturnCase"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnCase_accountId_caseKey_key" ON "ReturnCase"("accountId", "caseKey");

-- CreateIndex
CREATE INDEX "ReturnNotification_accountId_createdAt_idx" ON "ReturnNotification"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnNotification_returnCaseId_channel_key" ON "ReturnNotification"("returnCaseId", "channel");

-- CreateIndex
CREATE INDEX "ReturnPhoto_accountId_status_idx" ON "ReturnPhoto"("accountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnPhoto_accountId_id_key" ON "ReturnPhoto"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnPhoto_returnCaseId_photoId_key" ON "ReturnPhoto"("returnCaseId", "photoId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnsCodSettings_accountId_key" ON "ReturnsCodSettings"("accountId");

-- AddForeignKey
ALTER TABLE "ReturnCase" ADD CONSTRAINT "ReturnCase_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnCase" ADD CONSTRAINT "ReturnCase_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnNotification" ADD CONSTRAINT "ReturnNotification_accountId_returnCaseId_fkey" FOREIGN KEY ("accountId", "returnCaseId") REFERENCES "ReturnCase"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnPhoto" ADD CONSTRAINT "ReturnPhoto_accountId_returnCaseId_fkey" FOREIGN KEY ("accountId", "returnCaseId") REFERENCES "ReturnCase"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnsCodSettings" ADD CONSTRAINT "ReturnsCodSettings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security, same policy as every other account-scoped table (see the rls migration).
ALTER TABLE "ReturnCase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReturnCase" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ReturnCase" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "ReturnNotification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReturnNotification" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ReturnNotification" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "ReturnPhoto" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReturnPhoto" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ReturnPhoto" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "ReturnsCodSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReturnsCodSettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ReturnsCodSettings" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;
