import { afterEach, describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import sharp from "sharp";
import { OpenAIImageProvider, boundedOpenAIFetch } from "../app/openai-image-provider.server";
import { createImageProvider } from "../app/image-provider.server";
import { buildFurnitureReplacementPrompt } from "../app/furniture-prompt.server";
import type { GenerateRequest } from "../app/core/provider";

const image = (background: string) => sharp({ create: { width: 500, height: 400, channels: 3, background } }).jpeg().toBuffer();
async function setup(reply?: unknown, status = 200) {
  const room = await image("blue"), product = await image("red");
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(reply ?? { data: [{ b64_json: room.toString("base64") }] }, { status, headers: { "x-request-id": "req-test" } }));
  const client = new OpenAI({ apiKey: "test-only", fetch: fetcher, maxRetries: 0 });
  const req: GenerateRequest = { roomImage: room, productReferences: [product], productDescription: "British oak bed", itemNoun: "bed", optionValue: "Oak", placement: "replace" };
  return { provider: new OpenAIImageProvider(client), fetcher, req, room, product };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("OpenAI Images Edit adapter (no real API calls)", () => {
  it("sends the room first and exact product second through the official SDK", async () => {
    const { provider, fetcher, req, room, product } = await setup();
    const result = await provider.generate(req);
    expect(result).toMatchObject({ mimeType: "image/jpeg", providerRequestId: "req-test", model: "gpt-image-2" });
    expect((await sharp(result.image).metadata()).width).toBe(500);
    const [url, init] = fetcher.mock.calls.find(call => String(call[0]).includes("/images/edits"))! as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.openai.com/v1/images/edits");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("n")).toBe("1");
    expect(form.get("output_format")).toBe("jpeg");
    const files = form.getAll("image[]") as File[];
    expect(files.map(f => f.name)).toEqual(["room.jpg", "selected-product.jpg"]);
    // Input normalization is deterministic and strips metadata before transmission.
    const { normaliseImage } = await import("../app/preview-images.server");
    expect(Buffer.from(await files[0]!.arrayBuffer())).toEqual(Buffer.from(await normaliseImage(room)));
    expect(Buffer.from(await files[1]!.arrayBuffer())).toEqual(Buffer.from(await normaliseImage(product)));
    expect(provider.capabilities().zeroRetentionConfirmed).toBe(false);
  });
  it.each([{}, { data: [] }, { data: [{ url: "https://evil.test" }] }, { data: [{ b64_json: "bad!" }] }, { data: [{ b64_json: "YQ==" }] }, { data: [{ b64_json: "YQ==" }, { b64_json: "YQ==" }] }])("rejects invalid or missing output %j", async reply => {
    const { provider, req } = await setup(reply);
    await expect(provider.generate(req)).rejects.toHaveProperty("code");
  });
  it.each([401, 429, 500])("sanitizes API errors and does not retry HTTP %i", async status => {
    const { provider, req, fetcher } = await setup({ error: { message: "secret customer photo and API key" } }, status);
    await expect(provider.generate(req)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: "PROVIDER_UNAVAILABLE" });
    expect(fetcher.mock.calls.filter(call => String(call[0]).includes("/images/edits"))).toHaveLength(1);
  });
  it("rejects malformed input and unsupported requests before calling OpenAI", async () => {
    const { provider, req, fetcher } = await setup();
    for (const invalid of [{ ...req, roomImage: new Uint8Array([1]) }, { ...req, productReferences: [] }, { ...req, placement: "place" as const }]) {
      await expect(provider.generate(invalid)).rejects.toHaveProperty("code");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("honours caller cancellation even if the transport hangs", async () => {
    const { req } = await setup();
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const provider = new OpenAIImageProvider(new OpenAI({ apiKey: "test", fetch: fetcher }));
    const controller = new AbortController();
    const work = provider.generate(req, controller.signal);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    controller.abort();
    await expect(work).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
  });
  it("enforces its own timeout even without caller cancellation", async () => {
    const { req } = await setup();
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const provider = new OpenAIImageProvider(new OpenAI({ apiKey: "test", fetch: fetcher }));
    const work = provider.generate(req);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    deadline.abort();
    await expect(work).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
  });
  it("bounds chunked SDK response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(12 * 1024 * 1024 + 1)); c.close(); } }))));
    const res = await boundedOpenAIFetch("https://api.openai.com/v1/images/edits");
    await expect(res.text()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
  it("keeps mock default and requires explicit configuration", () => {
    expect(createImageProvider({}).capabilities().name).toBe("mock");
    expect(() => createImageProvider({ IMAGE_PROVIDER: "typo" })).toThrow("IMAGE_PROVIDER");
    expect(() => createImageProvider({ IMAGE_PROVIDER: "openai" })).toThrow("OPENAI_API_KEY");
    expect(() => createImageProvider({ IMAGE_PROVIDER: "openai", OPENAI_API_KEY: "test" })).toThrow("PRIVACY");
    expect(createImageProvider({ IMAGE_PROVIDER: "openai", OPENAI_API_KEY: "test", OPENAI_IMAGE_PRIVACY_ACKNOWLEDGED: "true" }).capabilities()).toMatchObject({ name: "openai", zeroRetentionConfirmed: false });
  });
  it("contains room preservation and product isolation instructions", async () => {
    const { req } = await setup();
    const prompt = buildFurnitureReplacementPrompt(req);
    for (const rule of ["IMAGE 1", "IMAGE 2", "camera angle", "headboard", "curtains", "Do not redesign", "do not introduce clutter", "British home", "Do not copy"]) expect(prompt).toContain(rule);
  });
});


