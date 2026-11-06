-- Personal settings per user (owner request 2026-11-06: order page design). A NEW table only — additive, nothing
-- existing is altered, so it applies cleanly on a database that already holds data. Global like "User" (no account).
CREATE TABLE "UserPreference" (
    "userId" TEXT NOT NULL,
    "orderDesign" TEXT NOT NULL DEFAULT 'new',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
