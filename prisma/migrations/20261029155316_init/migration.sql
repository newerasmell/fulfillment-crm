-- pgvector (Review.embedding). On Render, the database user may create it.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'OPERATOR', 'WAREHOUSE', 'VIEWER');

-- CreateEnum
CREATE TYPE "ConnectionType" AS ENUM ('FHB_V3', 'FHB_JOY', 'EUSHIPMENTS');

-- CreateEnum
CREATE TYPE "LiveMode" AS ENUM ('READ_ONLY', 'DRY_RUN', 'CANARY', 'LIVE');

-- CreateEnum
CREATE TYPE "StoreWriteMode" AS ENUM ('READ_ONLY', 'DRY_RUN', 'LIVE');

-- CreateEnum
CREATE TYPE "InventoryPushMode" AS ENUM ('DISABLED', 'DRY_RUN', 'LIVE');

-- CreateEnum
CREATE TYPE "CrmOrderStatus" AS ENUM ('IMPORTED', 'CHECKING', 'NEEDS_REVIEW', 'READY', 'APPROVED', 'QUEUED', 'SUBMITTING', 'SUBMIT_FAILED', 'ACCEPTED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'COD_PAID', 'RETURNING', 'RETURN_RECEIVED', 'EXCEPTION', 'ON_HOLD', 'BLOCKED', 'CANCELLED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('SHOPIFY', 'MANUAL');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('COD', 'PREPAID');

-- CreateEnum
CREATE TYPE "StockSource" AS ENUM ('PUSH', 'POLL');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVE', 'EDIT_AND_APPROVE', 'HOLD', 'CANCEL', 'REROUTE');

-- CreateEnum
CREATE TYPE "OutboundStatus" AS ENUM ('PENDING', 'PAUSED', 'REFUSED', 'DRY_RUN_RECORDED', 'AWAITING_CONFIRMATION', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "WebhookSource" AS ENUM ('SHOPIFY', 'FHB', 'EUSHIPMENTS');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AiLevel" AS ENUM ('L0', 'L1', 'L2');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalDetails" JSONB,
    "defaultCurrency" TEXT NOT NULL DEFAULT 'EUR',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Sofia',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "outboxPaused" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "totpSecretEnc" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "totpLastStep" INTEGER,
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "locale" TEXT NOT NULL DEFAULT 'bg',
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "hint" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "countries" TEXT[],
    "credentialId" TEXT,
    "webhookStatus" JSONB NOT NULL DEFAULT '{}',
    "syncCursors" JSONB NOT NULL DEFAULT '{}',
    "writeBackMode" "StoreWriteMode" NOT NULL DEFAULT 'READ_ONLY',
    "inventoryPushMode" "InventoryPushMode" NOT NULL DEFAULT 'DISABLED',
    "inventoryBuffer" INTEGER NOT NULL DEFAULT 0,
    "notifyCustomer" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FulfillmentConnection" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "ConnectionType" NOT NULL,
    "name" TEXT NOT NULL,
    "liveMode" "LiveMode" NOT NULL DEFAULT 'READ_ONLY',
    "credentialId" TEXT,
    "vendorIds" JSONB NOT NULL DEFAULT '{}',
    "warehouseIds" TEXT[],
    "skuPrefixRule" JSONB NOT NULL DEFAULT '{}',
    "defaultSender" JSONB,
    "variableSymbolNext" BIGINT NOT NULL DEFAULT 1,
    "features" TEXT[],
    "canaryDailyCap" INTEGER NOT NULL DEFAULT 10,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FulfillmentConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingRule" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "match" JSONB NOT NULL DEFAULT '{}',
    "connectionId" TEXT NOT NULL,
    "parcelService" TEXT,
    "courierId" TEXT,
    "serviceName" TEXT,
    "deliveryPointPolicy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CountrySetting" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "phoneRules" JSONB NOT NULL DEFAULT '{}',
    "defaultCouriers" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "CountrySetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "type" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "isTester" BOOLEAN NOT NULL DEFAULT false,
    "parentProductId" TEXT,
    "weightGrams" INTEGER,
    "lengthMm" INTEGER,
    "widthMm" INTEGER,
    "heightMm" INTEGER,
    "hsCode" TEXT,
    "countryOfOrigin" TEXT,
    "images" TEXT[],
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductEan" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "note" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductEan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreVariantLink" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "shopifyVariantGid" TEXT NOT NULL,
    "shopifyProductGid" TEXT NOT NULL,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "productId" TEXT,
    "matchMethod" TEXT,
    "matchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreVariantLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorProduct" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "productId" TEXT,
    "vendorId" TEXT NOT NULL,
    "vendorCode" TEXT,
    "vendorEan" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "raw" JSONB,

    CONSTRAINT "VendorProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLevel" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "vendorProductId" TEXT NOT NULL,
    "physical" INTEGER NOT NULL DEFAULT 0,
    "free" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "sellable" INTEGER NOT NULL DEFAULT 0,
    "snapshotAt" TIMESTAMP(3) NOT NULL,
    "source" "StockSource" NOT NULL,

    CONSTRAINT "StockLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "vendorProductId" TEXT,
    "externalId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "raw" JSONB,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundShipment" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "vendorId" TEXT,
    "status" TEXT NOT NULL,
    "tracking" TEXT,
    "expectedAt" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundLine" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "inboundId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "expectedQty" INTEGER NOT NULL,
    "receivedQty" INTEGER,
    "comment" TEXT,

    CONSTRAINT "InboundLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "source" "OrderSource" NOT NULL,
    "storeId" TEXT,
    "shopifyOrderGid" TEXT,
    "number" TEXT NOT NULL,
    "status" "CrmOrderStatus" NOT NULL DEFAULT 'IMPORTED',
    "customerName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "shippingAddressOriginal" JSONB,
    "shippingAddress" JSONB,
    "billingAddress" JSONB,
    "currency" TEXT NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "codAmount" DECIMAL(12,2),
    "codLocalAmount" DECIMAL(12,2),
    "codLocalCurrency" TEXT,
    "codRate" DECIMAL(14,6),
    "tags" TEXT[],
    "note" TEXT,
    "risk" JSONB,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "variantLinkId" TEXT,
    "productId" TEXT,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fulfillment" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "variableSymbol" TEXT,
    "vendorUid" TEXT,
    "vendorOrderId" TEXT,
    "carrier" TEXT,
    "deliveryPoint" JSONB,
    "status" "CrmOrderStatus" NOT NULL,
    "rawStatus" TEXT,
    "trackingNumbers" TEXT[],
    "trackingUrls" TEXT[],
    "labelFileKey" TEXT,
    "codStatus" TEXT,
    "returnInfo" JSONB,
    "submittedAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Fulfillment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FulfillmentEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "rawStatus" TEXT,
    "status" "CrmOrderStatus",
    "payload" JSONB,

    CONSTRAINT "FulfillmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FulfillmentLine" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "FulfillmentLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "findings" JSONB NOT NULL DEFAULT '[]',
    "aiSuggestion" JSONB,
    "aiConfidence" DOUBLE PRECISION,
    "decision" "ReviewDecision",
    "diff" JSONB,
    "reasonCode" TEXT,
    "reasonText" TEXT,
    "reviewerId" TEXT,
    "timeSpentMs" INTEGER,
    "embedding" vector(1024),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundRequest" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboundStatus" NOT NULL DEFAULT 'PENDING',
    "evaluatedMode" "LiveMode",
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastResponse" JSONB,
    "lastError" TEXT,
    "fulfillmentId" TEXT,
    "lockedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "source" "WebhookSource" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "headers" JSONB,
    "payload" JSONB NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "isTask" BOOLEAN NOT NULL DEFAULT false,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'WARNING',
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "assigneeId" TEXT,
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiSpecVersion" (
    "id" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hash" TEXT NOT NULL,
    "normalised" JSONB NOT NULL,
    "diff" JSONB,

    CONSTRAINT "ApiSpecVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiPolicy" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "decisionType" TEXT NOT NULL,
    "level" "AiLevel" NOT NULL DEFAULT 'L0',
    "thresholds" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_accountId_idx" ON "Membership"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_accountId_key" ON "Membership"("userId", "accountId");

-- CreateIndex
CREATE INDEX "LoginAttempt_key_createdAt_idx" ON "LoginAttempt"("key", "createdAt");

-- CreateIndex
CREATE INDEX "Credential_accountId_idx" ON "Credential"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_accountId_id_key" ON "Credential"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Store_accountId_id_key" ON "Store"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Store_accountId_code_key" ON "Store"("accountId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Store_accountId_domain_key" ON "Store"("accountId", "domain");

-- CreateIndex
CREATE INDEX "FulfillmentConnection_accountId_idx" ON "FulfillmentConnection"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentConnection_accountId_id_key" ON "FulfillmentConnection"("accountId", "id");

-- CreateIndex
CREATE INDEX "RoutingRule_accountId_priority_idx" ON "RoutingRule"("accountId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "CountrySetting_accountId_country_key" ON "CountrySetting"("accountId", "country");

-- CreateIndex
CREATE UNIQUE INDEX "Product_accountId_id_key" ON "Product"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Product_accountId_sku_key" ON "Product"("accountId", "sku");

-- CreateIndex
CREATE INDEX "ProductEan_accountId_ean_idx" ON "ProductEan"("accountId", "ean");

-- CreateIndex
CREATE INDEX "StoreVariantLink_accountId_productId_idx" ON "StoreVariantLink"("accountId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreVariantLink_accountId_id_key" ON "StoreVariantLink"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StoreVariantLink_storeId_shopifyVariantGid_key" ON "StoreVariantLink"("storeId", "shopifyVariantGid");

-- CreateIndex
CREATE INDEX "VendorProduct_accountId_productId_idx" ON "VendorProduct"("accountId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorProduct_accountId_id_key" ON "VendorProduct"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "VendorProduct_connectionId_vendorId_key" ON "VendorProduct"("connectionId", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLevel_vendorProductId_key" ON "StockLevel"("vendorProductId");

-- CreateIndex
CREATE INDEX "StockLevel_accountId_idx" ON "StockLevel"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLevel_accountId_vendorProductId_key" ON "StockLevel"("accountId", "vendorProductId");

-- CreateIndex
CREATE INDEX "StockMovement_accountId_occurredAt_idx" ON "StockMovement"("accountId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_connectionId_externalId_key" ON "StockMovement"("connectionId", "externalId");

-- CreateIndex
CREATE INDEX "InboundShipment_accountId_idx" ON "InboundShipment"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundShipment_accountId_id_key" ON "InboundShipment"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InboundShipment_connectionId_externalRef_key" ON "InboundShipment"("connectionId", "externalRef");

-- CreateIndex
CREATE INDEX "InboundLine_accountId_idx" ON "InboundLine"("accountId");

-- CreateIndex
CREATE INDEX "Order_accountId_status_placedAt_idx" ON "Order"("accountId", "status", "placedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_accountId_id_key" ON "Order"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Order_accountId_storeId_shopifyOrderGid_key" ON "Order"("accountId", "storeId", "shopifyOrderGid");

-- CreateIndex
CREATE INDEX "OrderLine_accountId_orderId_idx" ON "OrderLine"("accountId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_accountId_id_key" ON "OrderLine"("accountId", "id");

-- CreateIndex
CREATE INDEX "Fulfillment_accountId_status_idx" ON "Fulfillment"("accountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Fulfillment_accountId_id_key" ON "Fulfillment"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Fulfillment_connectionId_externalId_key" ON "Fulfillment"("connectionId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Fulfillment_connectionId_variableSymbol_key" ON "Fulfillment"("connectionId", "variableSymbol");

-- CreateIndex
CREATE INDEX "FulfillmentEvent_accountId_fulfillmentId_occurredAt_idx" ON "FulfillmentEvent"("accountId", "fulfillmentId", "occurredAt");

-- CreateIndex
CREATE INDEX "FulfillmentLine_accountId_idx" ON "FulfillmentLine"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentLine_fulfillmentId_orderLineId_key" ON "FulfillmentLine"("fulfillmentId", "orderLineId");

-- CreateIndex
CREATE INDEX "Review_accountId_createdAt_idx" ON "Review"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "OutboundRequest_accountId_status_idx" ON "OutboundRequest"("accountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundRequest_connectionId_idempotencyKey_key" ON "OutboundRequest"("connectionId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "WebhookEvent_accountId_receivedAt_idx" ON "WebhookEvent"("accountId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_source_dedupeKey_key" ON "WebhookEvent"("source", "dedupeKey");

-- CreateIndex
CREATE INDEX "Alert_accountId_status_createdAt_idx" ON "Alert"("accountId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_accountId_createdAt_idx" ON "AuditLog"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "ApiSpecVersion_vendor_fetchedAt_idx" ON "ApiSpecVersion"("vendor", "fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiPolicy_accountId_decisionType_key" ON "AiPolicy"("accountId", "decisionType");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_accountId_credentialId_fkey" FOREIGN KEY ("accountId", "credentialId") REFERENCES "Credential"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentConnection" ADD CONSTRAINT "FulfillmentConnection_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentConnection" ADD CONSTRAINT "FulfillmentConnection_accountId_credentialId_fkey" FOREIGN KEY ("accountId", "credentialId") REFERENCES "Credential"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CountrySetting" ADD CONSTRAINT "CountrySetting_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_accountId_parentProductId_fkey" FOREIGN KEY ("accountId", "parentProductId") REFERENCES "Product"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEan" ADD CONSTRAINT "ProductEan_accountId_productId_fkey" FOREIGN KEY ("accountId", "productId") REFERENCES "Product"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreVariantLink" ADD CONSTRAINT "StoreVariantLink_accountId_storeId_fkey" FOREIGN KEY ("accountId", "storeId") REFERENCES "Store"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreVariantLink" ADD CONSTRAINT "StoreVariantLink_accountId_productId_fkey" FOREIGN KEY ("accountId", "productId") REFERENCES "Product"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorProduct" ADD CONSTRAINT "VendorProduct_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorProduct" ADD CONSTRAINT "VendorProduct_accountId_productId_fkey" FOREIGN KEY ("accountId", "productId") REFERENCES "Product"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_accountId_vendorProductId_fkey" FOREIGN KEY ("accountId", "vendorProductId") REFERENCES "VendorProduct"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_accountId_vendorProductId_fkey" FOREIGN KEY ("accountId", "vendorProductId") REFERENCES "VendorProduct"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundShipment" ADD CONSTRAINT "InboundShipment_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundLine" ADD CONSTRAINT "InboundLine_accountId_inboundId_fkey" FOREIGN KEY ("accountId", "inboundId") REFERENCES "InboundShipment"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundLine" ADD CONSTRAINT "InboundLine_accountId_productId_fkey" FOREIGN KEY ("accountId", "productId") REFERENCES "Product"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_accountId_storeId_fkey" FOREIGN KEY ("accountId", "storeId") REFERENCES "Store"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_accountId_variantLinkId_fkey" FOREIGN KEY ("accountId", "variantLinkId") REFERENCES "StoreVariantLink"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_accountId_productId_fkey" FOREIGN KEY ("accountId", "productId") REFERENCES "Product"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fulfillment" ADD CONSTRAINT "Fulfillment_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fulfillment" ADD CONSTRAINT "Fulfillment_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentEvent" ADD CONSTRAINT "FulfillmentEvent_accountId_fulfillmentId_fkey" FOREIGN KEY ("accountId", "fulfillmentId") REFERENCES "Fulfillment"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentLine" ADD CONSTRAINT "FulfillmentLine_accountId_fulfillmentId_fkey" FOREIGN KEY ("accountId", "fulfillmentId") REFERENCES "Fulfillment"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentLine" ADD CONSTRAINT "FulfillmentLine_accountId_orderLineId_fkey" FOREIGN KEY ("accountId", "orderLineId") REFERENCES "OrderLine"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundRequest" ADD CONSTRAINT "OutboundRequest_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundRequest" ADD CONSTRAINT "OutboundRequest_accountId_fulfillmentId_fkey" FOREIGN KEY ("accountId", "fulfillmentId") REFERENCES "Fulfillment"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiPolicy" ADD CONSTRAINT "AiPolicy_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
