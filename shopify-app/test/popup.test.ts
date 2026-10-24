import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerFixture } from "./fixtures/provider-mapping";
import { manualStorefrontData } from "../app/customization/validation.server";

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
  it("discards an in-flight result after the native product selection changes, without acknowledging it", async () => {
    let current = "1";
    popup.cfg.productVariants = [{ id: "1", image: null, options: { Size: "King" } }, { id: "2", image: null, options: { Size: "Double" } }];
    popup.cfg.singleVariants = popup.cfg.productVariants;
    popup.pageOptions = { Size: "King" };
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => ({ value: current }) });
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/preview")) return Response.json({ jobId: "old-job" });
      current = "2";
      return Response.json({ stage: "ready", image: "data:image/jpeg;base64,YQ==", token: "token" });
    });
    vi.stubGlobal("fetch", fetcher);
    const running = popup.generate("__single__", "photo");
    await vi.advanceTimersByTimeAsync(1500); await running;
    expect(popup.state.results).toEqual({});
    expect(popup.pageOptions).toEqual({ Size: "Double" });
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/ack"))).toBe(false);
  });

  it("registers one product-change listener per open popup and removes it on close", () => {
    const root = { className: "", dataset: {}, style: { setProperty: vi.fn() }, classList: { add: vi.fn() },
      addEventListener: vi.fn(), remove: vi.fn(), querySelector: () => null };
    const add = vi.fn(), remove = vi.fn();
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null, createElement: () => root,
      addEventListener: add, removeEventListener: remove, body: { appendChild: vi.fn() }, documentElement: { classList: { add: vi.fn(), remove: vi.fn() } } });
    popup.cfg.style = { template: "gallery", accent: null, useThemeFont: false };
    popup.open(); popup.open();
    expect(add).toHaveBeenCalledTimes(1);
    expect(popup.pageWatchTimer).toBeDefined();
    popup.close();
    expect(popup.pageWatchTimer).toBeUndefined();
    expect(remove).toHaveBeenCalledWith("change", popup.pageChangeHandler);
    popup.open(); popup.close();
    expect(add).toHaveBeenCalledTimes(2); expect(remove).toHaveBeenCalledTimes(2);
  });

  it("supports arrow-key radio navigation without selecting disabled options", () => {
    const buttons = [{ dataset: { value: "a" }, click: vi.fn() }, { dataset: { value: "b" }, click: vi.fn() }];
    const group = { querySelectorAll: vi.fn(() => buttons) };
    const target = { closest: (selector: string) => selector === "button" ? buttons[0] : group };
    popup.root = { querySelector: vi.fn(() => null) };
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    const preventDefault = vi.fn();
    popup.onKey({ key: "ArrowRight", target, preventDefault });
    expect(group.querySelectorAll).toHaveBeenCalledWith('button[role="radio"]:not(:disabled)');
    expect(buttons[1]!.click).toHaveBeenCalledOnce(); expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("posts scoped manual revision and original variant while retaining composite preservation groups", async () => {
    const synthetic = providerFixture(); const projection = await manualStorefrontData(synthetic.context);
    let current = "11";
    vi.stubGlobal("document", { readyState: "loading", getElementById: () => null, querySelector: () => ({ value: current }), addEventListener: vi.fn() });
    const { Tryora } = await import("../../packages/storefront/src/main");
    popup = new Tryora({ ...projection, product: "Synthetic bed", available: true, lead: { mode: "off" } } as any);
    popup.render = vi.fn();
    expect(popup.fabric).toBe("Velvet");
    expect(popup.selectedVariant('["velvet","grey"]').id).toBe("gid://shopify/ProductVariant/12");
    popup.photos.set("photo", { blob: new Blob(["photo"]), url: "blob:room" });
    const fetcher = vi.fn(async () => Response.json({ error: "BAD_REQUEST" }, { status: 400 }));
    vi.stubGlobal("fetch", fetcher);
    await popup.generate('["velvet","grey"]', "photo");
    const form = (fetcher.mock.calls[0] as any)[1].body;
    expect(form.get("sourceVariant")).toBe("gid://shopify/ProductVariant/11");
    expect(form.get("mappingRevision")).toBe("revision-1");
    expect(form.get("variant")).toBe("gid://shopify/ProductVariant/12");
  });
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


  it("explains unsupported configurations without selling or inventing colour choices", async () => {
    await setup("4");
    click("fabric", "Velvet");
    const html = popup.swatches();
    expect(html).toContain("preview not supported for selected options");
    expect(html).toContain('is-unavailable');
    expect(html).not.toContain('tryora__sold');
    expect(html).not.toContain('is-soldout');
    expect(html).toContain("selected size and configuration");
    expect(popup.state.selectedOption).toBeNull();
  });

  it("keeps fabric-only composite identities opaque and reports missing colour mapping", async () => {
    await setup();
    const composite = "Velvet: Cream | Headboard: Tall | Storage: None";
    popup.cfg.fabricOptionName = null;
    popup.cfg.selectorLabel = "Fabric";
    popup.cfg.selectionOptionNames = ["Fabric"];
    popup.pageOptions = { Size: "King", Fabric: "Velvet", "Other bed choices": composite };
    const original = { id: "1", image: null, options: { ...popup.pageOptions } };
    const target = { id: "2", image: null, options: { ...popup.pageOptions, Fabric: "Boucle", "Other bed choices": "Boucle: Cream | Headboard: Tall | Storage: None" } };
    popup.cfg.swatches = [
      { value: "Velvet", label: "Velvet", group: null, available: true, image: null, colour: null, variants: [original] },
      { value: "Boucle", label: "Boucle", group: null, available: true, image: null, colour: null, variants: [target] },
    ];
    expect(popup.selectedVariant("Velvet")).toEqual(original);
    expect(popup.selectedVariant("Boucle")).toBeNull();
    const html = popup.swatches();
    expect(html).toContain("tryora__sw--fabric");
    expect(html).toContain("Colour choices have not been mapped");
    expect(html).not.toContain('aria-label="Colour"');
    expect(html).not.toContain("<img");
    expect(popup.pageOptions["Other bed choices"]).toBe(composite);
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
