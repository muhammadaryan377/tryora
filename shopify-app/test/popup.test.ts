import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let popup: any;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { readyState: "loading", addEventListener: vi.fn(), getElementById: () => null, querySelector: () => null });
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

describe("dependent fabric and colour popup", () => {
  const key = (fabric: string, colour: string) => JSON.stringify([fabric, colour]);
  const native = (id: string, Fabric: string, Colour: string, Size = "King", Headboard = "Tall", Storage = "Ottoman") =>
    ({ id, image: `https://cdn.shopify.com/${id}.jpg`, options: { Fabric, Colour, Size, Headboard, Storage } });
  const variants = [native("1", "Velvet", "Cream"), native("2", "Velvet", "Grey"), native("3", "Boucle", "Cream"),
    native("4", "Boucle", "Cream", "Double"), native("5", "Boucle", "Cream", "King", "Short")];
  async function setup(selectedId = "1") {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("document", { readyState: "loading", addEventListener: vi.fn(),
      getElementById: () => ({ dataset: { optionNames: JSON.stringify(["Size"]), variantOptions: JSON.stringify(["Double"]) } }),
      querySelector: () => ({ value: selectedId }) });
    const { Tryora } = await import("../../packages/storefront/src/main");
    const swatches = [["Velvet", "Cream"], ["Velvet", "Grey"], ["Boucle", "Cream"]].map(([fabric, colour]) => ({
      value: key(fabric!, colour!), label: colour, group: fabric, available: true, colour: null,
      image: colour === "Cream" ? "https://cdn.shopify.com/cream-swatch.jpg" : null,
      variants: variants.filter((v) => v.options.Fabric === fabric && v.options.Colour === colour),
    }));
    popup = new Tryora({ product: "Bed", available: true, swatches, optionName: "Colour", fabricOptionName: "Fabric",
      selectionOptionNames: ["Fabric", "Colour"], productVariants: variants, lead: { mode: "off" } } as any);
    popup.render = vi.fn();
  }
  function click(act: string, value: string) {
    popup.onClick({ target: { closest: () => ({ dataset: { act, value } }) } });
  }

  it("shows the selected fabric's real colour images and accessible text fallback", async () => {
    await setup("2");
    expect(popup.state.selectedOption).toBe(key("Velvet", "Grey"));
    const html = popup.swatches();
    expect(html).toContain('aria-label="Fabric"');
    expect(html).toContain('aria-label="Colour"');
    expect(html).toContain('src="https://cdn.shopify.com/cream-swatch.jpg"');
    expect(html).toContain('alt="Cream"');
    expect(html).toContain('aria-label="Velvet / Grey"');
    expect(html).toContain('is-text');
    expect(popup.visibleSwatches().map((s: any) => s.group)).toEqual(["Velvet", "Velvet"]);
  });

  it("resets colour on fabric change while preserving size, headboard and storage", async () => {
    await setup("2");
    click("fabric", "Boucle");
    expect(popup.state.selectedOption).toBe(key("Boucle", "Cream"));
    expect(popup.selectedVariant(popup.state.selectedOption).id).toBe("3");
    expect(popup.visibleSwatches()).toHaveLength(1);
    click("swatch", key("Velvet", "Grey"));
    expect(popup.state.selectedOption).toBe(key("Boucle", "Cream"));
  });

  it("never substitutes a different size when the selected fabric has no matching combination", async () => {
    await setup("4");
    click("fabric", "Velvet");
    expect(popup.state.selectedOption).toBeNull();
    expect(popup.selectedVariant(key("Velvet", "Cream"))).toBeNull();
    expect(popup.swatches()).toContain("No supported colours");
  });

  it("blocks unknown live variants rather than using stale Liquid defaults", async () => {
    await setup("unknown");
    expect(popup.state.selectedOption).toBeNull();
    expect(popup.selectedVariant(key("Velvet", "Cream"))).toBeNull();
  });

  it("locks fabric changes during generation and keeps results distinct across fabrics", async () => {
    await setup();
    const velvet = key("Velvet", "Cream"), boucle = key("Boucle", "Cream");
    popup.state.results = { [velvet]: { option: velvet, imageHandle: "blob:velvet" } };
    click("fabric", "Boucle");
    expect(popup.state.results[boucle]).toBeUndefined();
    expect(popup.swatches()).not.toContain("Viewed");
    popup.state.generation = { option: boucle, stage: "generating" };
    click("fabric", "Velvet");
    expect(popup.state.selectedOption).toBe(boucle);
    expect(popup.fabricPicker(true)).toContain("disabled");
  });

  it("posts the exact dependent selection and variant without changing the cart", async () => {
    await setup("4");
    popup.photos.set("photo", { blob: new Blob(["photo"]), url: "blob:room" });
    const fetcher = vi.fn(async () => Response.json({ error: "BAD_REQUEST" }, { status: 400 }));
    vi.stubGlobal("fetch", fetcher);
    await popup.generate(key("Boucle", "Cream"), "photo");
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0] as any;
    expect(url).toBe("/apps/tryora/preview");
    expect(request.body.get("variant")).toBe("4");
    expect(request.body.get("option")).toBe(key("Boucle", "Cream"));
    expect(popup.configurationNotice).toContain("product reference is no longer available");
    expect(popup.configurationNotice).toContain("No credit was used");
  });

  it("preserves native configuration on single-style products too", async () => {
    await setup("4");
    popup.cfg.singleVariants = variants;
    popup.cfg.swatches = [];
    popup.cfg.selectionOptionNames = [];
    expect(popup.selectedVariant("__single__").id).toBe("4");
  });
});
