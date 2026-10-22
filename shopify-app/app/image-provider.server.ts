import OpenAI from "openai";
import { MockImageProvider, type ImageProvider } from "./core/provider";
import { boundedOpenAIFetch, OpenAIImageProvider } from "./openai-image-provider.server";

export function createImageProvider(env: NodeJS.ProcessEnv = process.env): ImageProvider {
  const selected = env.IMAGE_PROVIDER ?? "mock";
  if (selected === "mock") return new MockImageProvider(1500);
  if (selected !== "openai") throw new Error("IMAGE_PROVIDER must be mock or openai");
  if (!env.OPENAI_API_KEY?.trim()) throw new Error("OPENAI_API_KEY is required for IMAGE_PROVIDER=openai");
  if (env.OPENAI_IMAGE_PRIVACY_ACKNOWLEDGED !== "true") {
    throw new Error("Review OpenAI data controls and set OPENAI_IMAGE_PRIVACY_ACKNOWLEDGED=true before enabling");
  }
  return new OpenAIImageProvider(new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0,
    timeout: 150_000, fetch: boundedOpenAIFetch, logLevel: "off" }), env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2");
}
