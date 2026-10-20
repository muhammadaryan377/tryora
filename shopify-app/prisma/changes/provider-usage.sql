-- Additive schema change for existing installations. Review/apply through the deployment process.
-- This file is not executed by tests or builds, and has not been applied to any service.
CREATE TABLE "ProviderUsage" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "jobId" TEXT,
  "stage" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "costMicros" INTEGER,
  "providerRequestId" TEXT,
  "model" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderUsage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderUsage_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ProviderUsage_shopId_createdAt_idx" ON "ProviderUsage"("shopId", "createdAt");
CREATE INDEX "ProviderUsage_jobId_idx" ON "ProviderUsage"("jobId");
