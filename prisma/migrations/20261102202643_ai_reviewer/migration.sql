-- Wave 3 AI track (P8-01..P8-04): AI control (kill switch), prompt/response log, suggestions + outcomes, review
-- embeddings (pgvector, extension created by the init migration), audit samples, policy history, rule proposals.
-- New tables only; no existing table or column is changed.
BEGIN;
-- CreateTable
CREATE TABLE "AiControl" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "changedById" TEXT,
    "changedAt" TIMESTAMP(3),
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiControl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiInteraction" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "response" JSONB,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "httpStatus" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSuggestion" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "interactionId" TEXT,
    "model" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "fixes" JSONB NOT NULL DEFAULT '[]',
    "flags" TEXT[],
    "explanationBg" TEXT NOT NULL,
    "guardrails" TEXT[],
    "similarReviewIds" TEXT[],
    "orderStatus" "CrmOrderStatus" NOT NULL,
    "orderFingerprint" TEXT,
    "checkHardCount" INTEGER NOT NULL DEFAULT 0,
    "checkSoftCount" INTEGER NOT NULL DEFAULT 0,
    "reviewId" TEXT,
    "humanDecision" TEXT,
    "decisionAgreed" BOOLEAN,
    "fixesAgreed" BOOLEAN,
    "criticalMiss" BOOLEAN NOT NULL DEFAULT false,
    "evaluatedAt" TIMESTAMP(3),
    "autoApprovedAt" TIMESTAMP(3),
    "autoPolicyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewEmbedding" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "embedding" vector(1024),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAuditSample" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewerId" TEXT,
    "note" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAuditSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiPolicyEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "decisionType" TEXT NOT NULL,
    "fromLevel" "AiLevel",
    "toLevel" "AiLevel",
    "fromEnabled" BOOLEAN,
    "toEnabled" BOOLEAN,
    "cause" TEXT NOT NULL,
    "userId" TEXT,
    "stats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiPolicyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRuleProposal" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "country" TEXT,
    "pattern" JSONB NOT NULL,
    "titleBg" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "examples" JSONB NOT NULL DEFAULT '[]',
    "support" INTEGER NOT NULL,
    "distinctOrders" INTEGER NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "minedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiRuleProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiControl_accountId_key" ON "AiControl"("accountId");

-- CreateIndex
CREATE INDEX "AiInteraction_accountId_createdAt_idx" ON "AiInteraction"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "AiInteraction_accountId_orderId_createdAt_idx" ON "AiInteraction"("accountId", "orderId", "createdAt");

-- CreateIndex
CREATE INDEX "AiSuggestion_accountId_orderId_createdAt_idx" ON "AiSuggestion"("accountId", "orderId", "createdAt");

-- CreateIndex
CREATE INDEX "AiSuggestion_accountId_createdAt_idx" ON "AiSuggestion"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "AiSuggestion_accountId_evaluatedAt_idx" ON "AiSuggestion"("accountId", "evaluatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiSuggestion_accountId_id_key" ON "AiSuggestion"("accountId", "id");

-- CreateIndex
CREATE INDEX "ReviewEmbedding_accountId_provider_idx" ON "ReviewEmbedding"("accountId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewEmbedding_reviewId_provider_key" ON "ReviewEmbedding"("reviewId", "provider");

-- CreateIndex
CREATE INDEX "AiAuditSample_accountId_status_day_idx" ON "AiAuditSample"("accountId", "status", "day");

-- CreateIndex
CREATE UNIQUE INDEX "AiAuditSample_accountId_suggestionId_key" ON "AiAuditSample"("accountId", "suggestionId");

-- CreateIndex
CREATE INDEX "AiPolicyEvent_accountId_decisionType_createdAt_idx" ON "AiPolicyEvent"("accountId", "decisionType", "createdAt");

-- CreateIndex
CREATE INDEX "AiRuleProposal_accountId_status_idx" ON "AiRuleProposal"("accountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AiRuleProposal_accountId_key_key" ON "AiRuleProposal"("accountId", "key");

-- AddForeignKey
ALTER TABLE "AiControl" ADD CONSTRAINT "AiControl_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInteraction" ADD CONSTRAINT "AiInteraction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSuggestion" ADD CONSTRAINT "AiSuggestion_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSuggestion" ADD CONSTRAINT "AiSuggestion_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewEmbedding" ADD CONSTRAINT "ReviewEmbedding_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewEmbedding" ADD CONSTRAINT "ReviewEmbedding_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAuditSample" ADD CONSTRAINT "AiAuditSample_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAuditSample" ADD CONSTRAINT "AiAuditSample_accountId_suggestionId_fkey" FOREIGN KEY ("accountId", "suggestionId") REFERENCES "AiSuggestion"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiPolicyEvent" ADD CONSTRAINT "AiPolicyEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRuleProposal" ADD CONSTRAINT "AiRuleProposal_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Review has no (accountId, id) key, so the FK above is on id only: this trigger keeps an embedding in its
-- review's account (the composite-FK rule of every other business table).
CREATE OR REPLACE FUNCTION crm_review_embedding_same_account() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Review" r WHERE r.id = NEW."reviewId" AND r."accountId" = NEW."accountId") THEN
    RAISE EXCEPTION 'review % is not in account %', NEW."reviewId", NEW."accountId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER review_embedding_same_account BEFORE INSERT OR UPDATE ON "ReviewEmbedding"
  FOR EACH ROW EXECUTE FUNCTION crm_review_embedding_same_account();

-- Row-level security, same policy as every other account-scoped table (see the rls migration).
ALTER TABLE "AiControl" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiControl" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "AiControl" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "AiInteraction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiInteraction" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "AiInteraction" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "AiSuggestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiSuggestion" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "AiSuggestion" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "ReviewEmbedding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewEmbedding" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ReviewEmbedding" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "AiAuditSample" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiAuditSample" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "AiAuditSample" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "AiPolicyEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiPolicyEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "AiPolicyEvent" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "AiRuleProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiRuleProposal" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "AiRuleProposal" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;
