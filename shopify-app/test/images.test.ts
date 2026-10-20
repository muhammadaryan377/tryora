import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { abortable, downloadReference, MAX_IMAGE_BYTES, normaliseImage } from "../app/preview-images.server";

afterEach(() => vi.unstubAllGlobals());
describe("transient images", () => {
  it("decodes and normalises image formats, dropping EXIF metadata", async () => {
    const input = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "red" } }).png().withMetadata().toBuffer();
    const out = await normaliseImage(input);
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: "jpeg", width: 1600, height: 800 });
    expect(meta.exif).toBeUndefined();
  });
  it("rejects empty, oversized, tiny, truncated and excessive-pixel images", async () => {
    const tiny = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } }).png().toBuffer();
    const huge = await sharp({ create: { width: 6000, height: 5000, channels: 3, background: "red" } }).png().toBuffer();
    for (const bytes of [new Uint8Array(), new Uint8Array(MAX_IMAGE_BYTES + 1), tiny, huge, tiny.slice(0, 20)]) {
      await expect(normaliseImage(bytes)).rejects.toMatchObject({ code: "BAD_PHOTO" });
    }
  });
  it("blocks non-Shopify hosts, redirects and streamed oversized references", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    for (const url of ["http://cdn.shopify.com/image", "https://localhost/image", "https://cdn.shopify.com.evil.test/image", "https://user@cdn.shopify.com/image"]) {
      await expect(downloadReference(url, new AbortController().signal)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    }
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_IMAGE_BYTES)); c.enqueue(new Uint8Array(1)); c.close(); } })));
    await expect(downloadReference("https://cdn.shopify.com/image", new AbortController().signal)).rejects.toMatchObject({ code: "BAD_PHOTO" });
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: "error" }));
  });
  it("settles promptly when cancellation is ignored by an upstream promise", async () => {
    const controller = new AbortController();
    const work = abortable(controller.signal, () => new Promise(() => {}));
    controller.abort();
    await expect(work).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
  });
});
