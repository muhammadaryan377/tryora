CREATE TABLE "AssistantTokenUsage" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "providerResponseId" TEXT,
    "model" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'chatbot',
    "outcome" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "totalTokens" INTEGER NOT NULL,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssistantTokenUsage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AssistantTokenUsage_providerResponseId_key" ON "AssistantTokenUsage"("providerResponseId");
CREATE INDEX "AssistantTokenUsage_shopId_createdAt_idx" ON "AssistantTokenUsage"("shopId", "createdAt");
ALTER TABLE "AssistantTokenUsage" ADD CONSTRAINT "AssistantTokenUsage_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderUsage" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'image',
    ADD COLUMN "inputTokens" INTEGER,
    ADD COLUMN "outputTokens" INTEGER,
    ADD COLUMN "totalTokens" INTEGER;
