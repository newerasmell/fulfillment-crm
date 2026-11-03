-- Owner request 2026-11-03: warehouse order ids use the Shopify order number as it is; an optional per-store prefix
-- replaces the store code that used to be put in front ("1EUR-1-EUR2848"). Additive: one nullable column, no backfill
-- (existing shipments keep the externalId they were stored with).
BEGIN;
ALTER TABLE "Store" ADD COLUMN "vendorIdPrefix" TEXT;
COMMIT;
