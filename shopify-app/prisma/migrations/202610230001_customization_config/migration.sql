-- Review and apply only as a separate authorized database rollout.
-- No changes to existing merchant settings, product configurations or credit tables.
CREATE TABLE "CustomizationConfig" (
  "shopId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL DEFAULT 'shopify_native',
  "revision" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "mapping" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomizationConfig_pkey" PRIMARY KEY ("shopId", "productId"),
  CONSTRAINT "CustomizationConfig_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
