import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let popup: any;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { readyState: "loading", addEventListener: vi.fn(), getElementById: () => null });
  vi.stubGlobal("localStorage", { getItem: () => "visitor", setItem: vi.fn() });
  const { Tryora } = await import("../../packages/storefront/src/main");
  popup = new Tryora({ available: true, swatches: [], lead: { mode: "off" } } as any);
  popup.render = vi.fn();
  popup.state.photo = { id: "photo", check: { status: "ok" } };
  popup.photos.set("photo", { blob: new Blob(["photo"]), url: "blob:photo" });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("popup validation and delivery", () => {
  it("blocks generation after a photo-check service failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await popup.run({ type: "START_PHOTO_CHECK", photoId: "photo" });
    expect(popup.state.photo).toBeNull();
    expect(popup.fileProblem).toContain("couldn't check");
  });
  it("never acknowledges an image the browser cannot decode", async () => {
    vi.stubGlobal("Image", class { src = ""; decode() { return Promise.reject(new Error("corrupt")); } });
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/preview")) return Response.json({ jobId: "job" });
      if (url.endsWith("/preview/job")) return Response.json({ stage: "ready", image: "data:image/jpeg;base64,YQ==", token: "token" });
      return new Response("invalid image");
    });
    vi.stubGlobal("fetch", fetcher);
    const result = popup.generate("__single__", "photo");
    await vi.advanceTimersByTimeAsync(1500);
    await result;
    expect(popup.state.results).toEqual({});
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/ack"))).toBe(false);
  });
});
