-- Справки (P10-04): additive indexes only (no table or column change). Reports read orders by placement date and
-- shipments by creation date within a bounded Europe/Sofia date range.
BEGIN;

-- CreateIndex
CREATE INDEX "Order_accountId_placedAt_idx" ON "Order"("accountId", "placedAt");

-- CreateIndex
CREATE INDEX "Fulfillment_accountId_createdAt_idx" ON "Fulfillment"("accountId", "createdAt");

COMMIT;
