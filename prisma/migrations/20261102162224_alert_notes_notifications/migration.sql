-- Wave 2 fulfill track (P4-08): alert/task history (assign, resolve with note) and idempotent notifications.
-- New tables only; the Alert table itself is not changed.
BEGIN;
-- CreateTable
CREATE TABLE "AlertNote" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertNotification" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENDING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "AlertNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlertNote_accountId_alertId_createdAt_idx" ON "AlertNote"("accountId", "alertId", "createdAt");

-- CreateIndex
CREATE INDEX "AlertNotification_accountId_createdAt_idx" ON "AlertNotification"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlertNotification_alertId_channel_key" ON "AlertNotification"("alertId", "channel");

-- AddForeignKey
ALTER TABLE "AlertNote" ADD CONSTRAINT "AlertNote_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertNote" ADD CONSTRAINT "AlertNote_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertNotification" ADD CONSTRAINT "AlertNotification_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertNotification" ADD CONSTRAINT "AlertNotification_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Alert has no (accountId, id) key, so the FK above is on id only: this trigger keeps a note / notification in
-- its alert's account (the composite-FK rule of every other business table).
CREATE OR REPLACE FUNCTION crm_alert_child_same_account() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Alert" a WHERE a.id = NEW."alertId" AND a."accountId" = NEW."accountId") THEN
    RAISE EXCEPTION 'alert % is not in account %', NEW."alertId", NEW."accountId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER alert_note_same_account BEFORE INSERT OR UPDATE ON "AlertNote"
  FOR EACH ROW EXECUTE FUNCTION crm_alert_child_same_account();
CREATE TRIGGER alert_notification_same_account BEFORE INSERT OR UPDATE ON "AlertNotification"
  FOR EACH ROW EXECUTE FUNCTION crm_alert_child_same_account();

-- Row-level security, same policy as every other account-scoped table (see the rls migration).
ALTER TABLE "AlertNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AlertNote" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "AlertNote" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "AlertNotification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AlertNotification" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "AlertNotification" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;
