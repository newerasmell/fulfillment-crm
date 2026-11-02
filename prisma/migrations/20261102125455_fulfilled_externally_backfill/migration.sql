-- Orders imported before FULFILLED_EXTERNALLY existed that Shopify already reported as fulfilled and that nobody
-- has acted on yet (still IMPORTED): move them out of the review queue. Touches nothing else.
BEGIN;
-- Tables have FORCE ROW LEVEL SECURITY; transaction-local bypass for this backfill only.
SELECT set_config('app.bypass_rls', 'on', true);
UPDATE "Order"
SET "status" = 'FULFILLED_EXTERNALLY'
WHERE "status" = 'IMPORTED' AND "source" = 'SHOPIFY' AND "shopifyFulfillmentStatus" = 'FULFILLED';
COMMIT;
