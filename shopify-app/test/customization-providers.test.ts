import { afterEach, describe, expect, it, vi } from "vitest";
import { providerFixture, shopId, productId } from "./fixtures/provider-mapping";
import { parseManualMapping, validateNativeBindings, PRESERVATION_OPTION } from "../app/customization/option-model";
import { providerAdapter, resolveConfiguredPreview } from "../app/customization/registry.server";
import { effectiveSetting, loadProviderSetting, providerSummary } from "../app/customization/provider-config.server";
import { manualStorefrontData } from "../app/customization/validation.server";
import { nativeSnapshot, nativeOptionCatalog } from "../app/customization/reference-resolver.server";

afterEach(() => vi.unstubAllEnvs());
const grey = JSON.stringify(["velvet", "grey"]);
describe("strict manual/composite mapping boundary", () => {
  it("retains complete native strings without parsing numbered or composite labels", () => {
    const { mapping } = providerFixture();
    expect(parseManualMapping(mapping, shopId, productId)).toEqual(mapping);
    expect(parseManualMapping(mapping, shopId, productId)).not.toBe(mapping);
  });
  it.each([
    ["wrong tenant", (m: any) => { m.shopId = "other.myshopify.com"; }],
    ["wrong product", (m: any) => { m.productId = "gid://shopify/Product/999"; }],
    ["unreviewed", (m: any) => { m.reviewed = false; }],
    ["unknown provider", (m: any) => { m.providerId = "cloudlift"; }],
    ["duplicate entry", (m: any) => { m.entries.push(structuredClone(m.entries[0])); }],
    ["duplicate variant", (m: any) => { m.entries[1].variantId = m.entries[0].variantId; }],
    ["duplicate tuple", (m: any) => { m.entries[1].nativeOptions = m.entries[0].nativeOptions; }],
    ["no reference", (m: any) => { m.entries[0].referenceMediaIds = []; }],
    ["swatch as reference", (m: any) => { m.entries[0].referenceMediaIds = [m.entries[0].swatchMediaId]; }],
    ["URL as reference", (m: any) => { m.entries[0].referenceMediaIds = ["http://127.0.0.1/private"]; }],
    ["missing preservation dimension", (m: any) => { delete m.entries[0].preserved.storage; }],
    ["missing native role", (m: any) => { delete m.entries[0].nativeOptions["1. Choose Your Size"]; }],
    ["conflicting fabric", (m: any) => { m.entries[0].fabric.label = "Boucle"; }],
    ["conflicting stable colour", (m: any) => { m.entries[1].colour.label = "Invented"; }],
    ["conflicting composite meaning", (m: any) => { m.entries[3].colour = { id: "cream", label: "Cream" }; }],
    ["unknown executable field", (m: any) => { m.parser = "eval()"; }],
    ["reserved option", (m: any) => { m.entries[0].nativeOptions[PRESERVATION_OPTION] = "spoofed"; }],
  ])("rejects %s", (_, mutate) => {
    const { mapping } = providerFixture(); mutate(mapping);
    expect(() => parseManualMapping(mapping, shopId, productId)).toThrow();
  });
  it("rejects malformed/oversized input", () => {
    for (const value of [null, [], {}, "bad"]) expect(() => parseManualMapping(value, shopId, productId)).toThrow();
    const { mapping } = providerFixture(); mapping.entries[0]!.nativeOptions["Other bed choices"] = "x".repeat(2049);
    expect(() => parseManualMapping(mapping, shopId, productId)).toThrow();
  });
  it("checks exact live tuples and product-owned Shopify media, independent of inventory counts", () => {
    const { mapping, variants, media } = providerFixture();
    expect(validateNativeBindings(mapping, variants, media)).toEqual([]);
    variants[0]!.selectedOptions[0]!.value = "Changed size";
    expect(validateNativeBindings(mapping, variants, media).join()).toContain("stale");
    media[0]!.image.url = "https://cdn.shopify.com.evil.test/101.jpg";
    expect(validateNativeBindings(mapping, variants, media).join()).toContain("unsafe");
  });
});

describe("provider registry and server authorization", () => {
  it("registers verified native/manual and fails closed for unavailable Cloudlift", async () => {
    expect(providerAdapter("shopify_native").capabilities.authorization).toBe(true);
    expect(providerAdapter("manual_mapping").capabilities.authorization).toBe(true);
    for (const id of ["cloudlift", "unsupported", "unknown"] ) {
      const { context, graphql } = providerFixture(); context.setting.providerId = id;
      if (id === "cloudlift") context.setting.active = false;
      expect((await providerAdapter(id).discover(context, { shopId, productId })).status).toBe("unsupported");
      await expect(resolveConfiguredPreview(context, grey, "gid://shopify/ProductVariant/12", "revision-1")).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect((await providerAdapter("shopify_native").validate(context, { scope: { shopId, productId }, revision: "revision-1",
        combinationId: "Velvet", nativeVariantId: "gid://shopify/ProductVariant/12", selectedOptions: {} })).status).toBe("rejected");
      expect(graphql).not.toHaveBeenCalled();
    }
  });
  it("retains verified native option/value IDs without inventing IDs for legacy payloads", () => {
    expect(nativeOptionCatalog({ options: [{ id: "gid://shopify/ProductOption/1", name: "Colour", optionValues: [{ id: "gid://shopify/ProductOptionValue/2", name: "Grey" }] }] }))
      .toEqual([{ id: "gid://shopify/ProductOption/1", name: "Colour", values: [{ id: "gid://shopify/ProductOptionValue/2", name: "Grey" }] }]);
    expect(nativeOptionCatalog({ options: [{ name: "Colour", optionValues: [{ name: "Grey" }] }] })).toEqual([]);
  });
  it("authorizes only a real available exact combination and full-product reference", async () => {
    const { context } = providerFixture();
    const result = await resolveConfiguredPreview(context, grey, "gid://shopify/ProductVariant/12", "revision-1");
    expect(result.urls).toEqual(["https://cdn.shopify.com/102.jpg"]);
    expect(result.selectedOptions["1. Choose Your Size"]).toBe("King");
    expect(result.description).toContain("Tall");
    expect(result.optionValue).toBe("Velvet / Grey");
  });
  it.each(["shopify_native", "manual_mapping", "cloudlift"])("round-trips discovered combination IDs through the %s adapter contract", async (id) => {
    const { context } = providerFixture(); context.setting.providerId = id;
    const adapter = providerAdapter(id);
    const result = await adapter.discover(context, { shopId, productId });
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    const combination = result.snapshot.combinations.find((c) => c.nativeVariantId === "gid://shopify/ProductVariant/12")!;
    const validated = await adapter.validate(context, { scope: { shopId, productId }, revision: "revision-1", combinationId: combination.id,
      nativeVariantId: combination.nativeVariantId, selectedOptions: combination.options });
    expect(validated.status).toBe("approved");
    const conflicting = await adapter.validate(context, { scope: { shopId, productId }, revision: "revision-1", combinationId: combination.id,
      nativeVariantId: combination.nativeVariantId, selectedOptions: { ...combination.options, "1. Choose Your Size": "Not selected" } });
    expect(conflicting.status).toBe("rejected");
    context.config.enabled = false;
    expect((await adapter.validate(context, { scope: { shopId, productId }, revision: "revision-1", combinationId: combination.id,
      nativeVariantId: combination.nativeVariantId, selectedOptions: combination.options })).status).toBe("rejected");
  });
  it.each(["revision", "size", "storage", "variant", "colour", "source", "inactive", "scope", "product-scope", "frozen", "merchant-off"])("blocks changed %s without substitution", async (reason) => {
    const { context } = providerFixture();
    let revision = "revision-1", id = "gid://shopify/ProductVariant/12", option = grey;
    if (reason === "revision") revision = "stale";
    if (reason === "size") id = "gid://shopify/ProductVariant/14";
    if (reason === "storage") id = "gid://shopify/ProductVariant/13";
    if (reason === "variant") id = "gid://shopify/ProductVariant/999";
    if (reason === "colour") option = JSON.stringify(["velvet", "invented"]);
    if (reason === "source") context.sourceVariantId = "unknown";
    if (reason === "inactive") context.setting.active = false;
    if (reason === "scope") context.setting.shopId = "other.myshopify.com";
    if (reason === "product-scope") context.setting.productId = "gid://shopify/Product/999";
    if (reason === "frozen") context.config.frozenContext = { "1. Choose Your Size": "Double" };
    if (reason === "merchant-off") context.config.choices = [{ optionValue: "Velvet", available: false }] as any;
    await expect(resolveConfiguredPreview(context, option, id, revision)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("Cloudlift refuses store defaults and stale or absent reviewed product mappings", async () => {
    const { context } = providerFixture();
    context.setting.providerId = "cloudlift";
    context.setting.productId = "__store__";
    await expect(resolveConfiguredPreview(context, grey, "gid://shopify/ProductVariant/12", "revision-1"))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    context.setting.productId = productId;
    context.setting.mapping = null;
    await expect(resolveConfiguredPreview(context, grey, "gid://shopify/ProductVariant/12", "revision-1"))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("uses availableForSale and refuses a missing reference after activation", async () => {
    const { context, variants, media } = providerFixture();
    variants[1]!.availableForSale = false;
    await expect(resolveConfiguredPreview(context, grey, "gid://shopify/ProductVariant/12", "revision-1")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    variants[1]!.availableForSale = true; media.splice(1, 1);
    await expect(resolveConfiguredPreview(context, grey, "gid://shopify/ProductVariant/12", "revision-1")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("projects reviewed swatches and preserves opaque configuration groups in the browser model", async () => {
    const { context } = providerFixture(); const data = await manualStorefrontData(context);
    expect(data.swatches[0]?.image).toBe("https://cdn.shopify.com/201.jpg");
    expect(data.swatches[1]?.image).toBeNull();
    expect(data.productVariants[0]?.options[PRESERVATION_OPTION]).toBe(data.productVariants[1]?.options[PRESERVATION_OPTION]);
    expect(data.productVariants[0]?.options[PRESERVATION_OPTION]).not.toBe(data.productVariants[2]?.options[PRESERVATION_OPTION]);
    expect(data.selectionOptionNames).not.toContain("1. Choose Your Size");
  });
  it("keeps defaults isolated and preserves explicit native overrides", async () => {
    const { context } = providerFixture();
    const rows = [{ ...context.setting, productId: "__store__", providerId: "cloudlift" }, context.setting];
    expect(effectiveSetting("another", productId, rows).providerId).toBe("shopify_native");
    expect(effectiveSetting(shopId, "other-product", rows).providerId).toBe("cloudlift");
    expect(effectiveSetting(shopId, productId, rows).providerId).toBe("manual_mapping");
    vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED", "false");
    expect((await loadProviderSetting(shopId, productId)).providerId).toBe("shopify_native");
    expect(providerSummary("cloudlift", false).status).toContain("Needs setup");
    expect(providerSummary("cloudlift", true).status).toContain("Native-linked mapping active");
  });
  it("rejects failed or stalled native pagination", async () => {
    const graphql = vi.fn(async () => Response.json({ data: { product: { id: productId, options: [],
      variants: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } }));
    await expect(nativeSnapshot({ graphql }, productId)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
  it("rejects malformed availability rather than treating a truthy string as stock", async () => {
    const graphql = vi.fn(async () => Response.json({ data: { product: { id: productId, options: [],
      variants: { nodes: [{ id: "gid://shopify/ProductVariant/11", availableForSale: "false", selectedOptions: [{ name: "Size", value: "King" }] }], pageInfo: { hasNextPage: false } } } } }));
    await expect(nativeSnapshot({ graphql }, productId)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
  it("bounds a provider lookup that never responds", async () => {
    vi.useFakeTimers();
    try {
      const waiting = nativeSnapshot({ graphql: () => new Promise<Response>(() => {}) }, productId);
      const assertion = expect(waiting).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      await vi.advanceTimersByTimeAsync(20_001);
      await assertion;
    } finally { vi.useRealTimers(); }
  });
});
