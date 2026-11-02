-- Orders that Shopify already reports as fulfilled when we first see them (shipped outside the CRM).
-- Additive enum value; it cannot be used in the same transaction, so the backfill is the next migration.
BEGIN;
ALTER TYPE "CrmOrderStatus" ADD VALUE IF NOT EXISTS 'FULFILLED_EXTERNALLY';
COMMIT;
