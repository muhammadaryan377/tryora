import prisma from "../db.server";
import { logAssistant } from "./log.server";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;

/** One row per provider response, including tool rounds. Never persist conversation content. */
export async function recordAssistantTokenUsage(shopId: string, fallbackModel: string, response: any) {
  const usage = response?.usage;
  if (!count(usage?.input_tokens) || !count(usage?.output_tokens)) return;
  const total = usage.input_tokens + usage.output_tokens;
  if (!count(total)) return;
  const data = {
    source: "chatbot",
    shopId,
    providerResponseId: typeof response.id === "string" ? response.id : null,
    model: typeof response.model === "string" ? response.model : fallbackModel,
    outcome: typeof response.status === "string" ? response.status : "completed",
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: count(usage.total_tokens) ? usage.total_tokens : total,
    cachedInputTokens: count(usage.input_tokens_details?.cached_tokens) ? usage.input_tokens_details.cached_tokens : 0,
  };
  try {
    if (data.providerResponseId) {
      await prisma.assistantTokenUsage.upsert({ where: { providerResponseId: data.providerResponseId }, create: data, update: {} });
    } else {
      await prisma.assistantTokenUsage.create({ data });
    }
  } catch {
    // Usage reporting must not fail a shopper's reply or log raw database errors.
    logAssistant("token_usage_save_failure", { shop: shopId, model: fallbackModel });
  }
}
