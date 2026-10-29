import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ upsert: vi.fn(), create: vi.fn(), log: vi.fn() }));
vi.mock("../app/db.server", () => ({ default: { assistantTokenUsage: { upsert: mocks.upsert, create: mocks.create } } }));
vi.mock("../app/assistant/log.server", () => ({ logAssistant: mocks.log }));
import { recordAssistantTokenUsage } from "../app/assistant/token-usage.server";
beforeEach(() => vi.resetAllMocks());
const response = { id: "resp_1", model: "chat-model", status: "completed", usage: {
  input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 50 },
}, output: [{ text: "private message" }] };
describe("persistent chatbot token usage", () => {
  it("records token metadata and deduplicates by response ID without storing conversation content", async () => {
    await recordAssistantTokenUsage("demo.myshopify.com", "fallback", response);
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { providerResponseId: "resp_1" }, update: {}, create: {
        shopId: "demo.myshopify.com", source: "chatbot", providerResponseId: "resp_1", model: "chat-model", outcome: "completed",
        inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 50,
      },
    });
    expect(JSON.stringify(mocks.upsert.mock.calls)).not.toContain("private message");
  });
  it("records incomplete responses and derives a missing total", async () => {
    await recordAssistantTokenUsage("demo", "fallback", { status: "incomplete", usage: { input_tokens: 8, output_tokens: 2 } });
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ model: "fallback", outcome: "incomplete", totalTokens: 10, cachedInputTokens: 0 }) });
  });
  it.each([undefined, {}, { input_tokens: -1, output_tokens: 2 }, { input_tokens: "10", output_tokens: 2 }])("does not invent counts for missing or invalid usage", async usage => {
    await recordAssistantTokenUsage("demo", "model", { usage });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("does not break replies or expose database errors when persistence fails", async () => {
    mocks.upsert.mockRejectedValue(new Error("private connection details"));
    await expect(recordAssistantTokenUsage("demo", "model", response)).resolves.toBeUndefined();
    expect(mocks.log).toHaveBeenCalledWith("token_usage_save_failure", { shop: "demo", model: "model" });
  });
});
