-- Additive: a new index only (the stock board reads the latest push line per variant × location).
CREATE INDEX IF NOT EXISTS "InventoryPushLine_accountId_variantLinkId_locationGid_idx" ON "InventoryPushLine"("accountId", "variantLinkId", "locationGid");
