-- Shopify customer data requests must remain visible to authenticated merchants.
-- This is additive and does not backfill or alter existing lead/preview records.
CREATE TABLE "PrivacyRequest" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "customerId" TEXT,
  "email" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "exportedAt" TIMESTAMP(3),
  CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PrivacyRequest_shopId_requestId_key" ON "PrivacyRequest"("shopId", "requestId");
CREATE INDEX "PrivacyRequest_shopId_status_createdAt_idx" ON "PrivacyRequest"("shopId", "status", "createdAt");
ALTER TABLE "PrivacyRequest" ADD CONSTRAINT "PrivacyRequest_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
