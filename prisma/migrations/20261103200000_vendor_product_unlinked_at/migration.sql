-- "Съмнителни връзки": a warehouse product a person unlinked is remembered, so no automatic SKU match re-links it.
-- Additive and NULLABLE (no default needed): applies cleanly on a table that already holds rows.
ALTER TABLE "VendorProduct" ADD COLUMN "unlinkedAt" TIMESTAMP(3);
