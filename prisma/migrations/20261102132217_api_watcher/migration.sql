-- Phase 9 (API change watcher): one new global table; nothing existing is altered.
BEGIN;

-- CreateTable
CREATE TABLE "ApiWatchSource" (
    "id" TEXT NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "lastError" TEXT,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiWatchSource_pkey" PRIMARY KEY ("id")
);

COMMIT;
