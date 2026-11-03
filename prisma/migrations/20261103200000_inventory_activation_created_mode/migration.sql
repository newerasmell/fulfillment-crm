-- Auditor fix 2026-11-03: remember the inventory push mode the owner confirmed an activation under, so a job
-- confirmed as a dry run is never sent live after the mode is raised. Additive only: one NULLABLE column on a
-- table that has never shipped; existing rows (none in production) read as "not confirmed live".
-- AlterTable
ALTER TABLE "InventoryActivation" ADD COLUMN "createdMode" "InventoryPushMode";
