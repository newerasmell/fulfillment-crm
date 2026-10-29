-- Row-level security: second line of defence behind the repository layer (src/server/db).
-- Every request runs inside a transaction that sets `app.account_id` (SET LOCAL via set_config).
-- System jobs that legitimately work across accounts set `app.bypass_rls = 'on'` instead.
-- Without either setting no rows are visible and no rows can be written.
-- FORCE makes the policies apply to the table owner too (the app role owns the tables).

CREATE OR REPLACE FUNCTION crm_rls_allows(row_account_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.bypass_rls', true), '') = 'on'
      OR (row_account_id IS NOT NULL AND row_account_id = nullif(current_setting('app.account_id', true), ''))
$$;

ALTER TABLE "Account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Account" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "Account" USING (crm_rls_allows("id")) WITH CHECK (crm_rls_allows("id"));

ALTER TABLE "AiPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiPolicy" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "AiPolicy" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "Alert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Alert" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "Alert" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "AuditLog" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "CountrySetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CountrySetting" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "CountrySetting" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "Credential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Credential" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "Credential" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "Fulfillment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Fulfillment" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "Fulfillment" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "FulfillmentConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FulfillmentConnection" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "FulfillmentConnection" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "FulfillmentEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FulfillmentEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "FulfillmentEvent" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "InboundLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboundLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "InboundLine" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "InboundShipment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboundShipment" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "InboundShipment" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "Membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Membership" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "Membership" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "Order" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "OrderLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "OrderLine" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "OutboundRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutboundRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "OutboundRequest" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "Product" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Product" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "Product" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "ProductEan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductEan" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ProductEan" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "Review" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Review" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "Review" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "RoutingRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RoutingRule" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "RoutingRule" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "StockLevel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockLevel" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "StockLevel" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "StockMovement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockMovement" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "StockMovement" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "Store" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Store" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "Store" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "StoreVariantLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoreVariantLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "StoreVariantLink" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "VendorProduct" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VendorProduct" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "VendorProduct" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "WebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "WebhookEvent" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

