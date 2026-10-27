CREATE TABLE "LeadVisit" (
  "shopId" TEXT NOT NULL,
  "visitorHash" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "satisfied" BOOLEAN NOT NULL DEFAULT false,
  "firstPreviewUsed" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeadVisit_pkey" PRIMARY KEY ("shopId", "visitorHash", "channel")
);

ALTER TABLE "LeadVisit" ADD CONSTRAINT "LeadVisit_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
