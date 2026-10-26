-- Additive: historical leads remain unchanged; no customer emails are backfilled.
ALTER TABLE "LeadDelivery"
  ADD COLUMN "email" TEXT,
  ADD COLUMN "firstName" TEXT,
  ADD COLUMN "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "marketingWording" TEXT;
CREATE INDEX "LeadDelivery_shopId_email_idx" ON "LeadDelivery"("shopId", "email");
