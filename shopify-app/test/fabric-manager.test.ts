import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerFixture, productId, shopId } from "./fixtures/provider-mapping";
const state = vi.hoisted(() => ({ rows: [] as any[], config: null as any, admin: null as any, writes: [] as any[], authenticate: vi.fn() }));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: state.authenticate } }));
vi.mock("../app/db.server", () => {
  const db = { shop: { upsert: vi.fn(async (args: any) => { state.writes.push({ shop: args }); return {}; }) },
    productPreviewConfig: { findUnique: vi.fn(async () => state.config), update: vi.fn(() => { throw new Error("Product ON/OFF must not change"); }) },
    customizationConfig: {
      findMany: vi.fn(async (args: any) => state.rows.filter((r) => r.shopId === args.where.shopId && args.where.productId.in.includes(r.productId))),
      findUnique: vi.fn(async (args: any) => state.rows.find((r) => r.shopId === args.where.shopId_productId.shopId && r.productId === args.where.shopId_productId.productId) ?? null),
      create: vi.fn(async ({ data }: any) => { if (state.rows.some((r) => r.shopId === data.shopId && r.productId === data.productId)) throw new Error("duplicate"); state.rows.push(data); state.writes.push(data); return data; }),
      updateMany: vi.fn(async ({ where, data }: any) => { const r = state.rows.find((r) => r.shopId === where.shopId && r.productId === where.productId && r.revision === where.revision); if (!r) return { count: 0 }; Object.assign(r, data); state.writes.push(data); return { count: 1 }; }),
    } };
  return { default: { ...db, $transaction: async (fn: any) => { const original = structuredClone(state.rows), writes = state.writes.length; try { return await fn(db); } catch (e) { state.rows = original; state.writes.length = writes; throw e; } } } };
});
import prisma from "../app/db.server";
import { emptyFabricDraft, parseFabricDraft, parseFabricDocument } from "../app/customization/fabric-manager";
import { compileFabricDocument, draftFromMapping, saveFabricConfiguration } from "../app/customization/fabric-manager.server";
import { cleanFabricImage, fabricForm, uploadFabricMedia } from "../app/customization/fabric-media.server";
import { parseManualMapping } from "../app/customization/option-model";
import { nativeSelections } from "../app/core/customization";
import { manualStorefrontData } from "../app/customization/validation.server";
import { resolveConfiguredPreview } from "../app/customization/registry.server";
import { action, loader } from "../app/routes/app.fabrics";
import { loadProviderSetting } from "../app/customization/provider-config.server";
const snapshot = () => { const f = providerFixture(); return { ...f, product: { id: productId }, draft: draftFromMapping(f.mapping, shopId, productId) }; };
const request = (fields: Record<string, string>, product = productId) => new Request(`https://tryora.example/app/fabrics?product=${encodeURIComponent(product)}`, { method: "POST", body: new URLSearchParams({ intent: "save", revision: "", mode: "manual", draft: JSON.stringify(emptyFabricDraft()), ...fields }) });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED", "true");
  state.rows = []; state.writes = []; state.config = { ...providerFixture().context.config, autoConfigured: false, enabled: false };
  const base = providerFixture().context.admin;
  state.admin = { graphql: async (q: string, v: any) => q.includes("TryoraFabricProducts") ? Response.json({ data: { products: { nodes: [{ id: productId, title: "Synthetic bed" }], pageInfo: { hasNextPage: false, endCursor: null } } } }) : base.graphql(q, v) };
  state.authenticate.mockResolvedValue({ admin: state.admin, session: { shop: shopId } });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("fabric and colour data boundary", () => {
  it("imports existing exact native-linked mappings without parsing composite values", () => {
    const f = snapshot(), compiled = compileFabricDocument(f.draft, shopId, productId, f);
    expect(compiled.document.draft.bindings.map((b) => b.nativeOptions)).toEqual(f.mapping.entries.map((e) => e.nativeOptions));
    expect(parseManualMapping(compiled.document, shopId, productId).entries.map((e) => e.variantId)).toEqual(f.mapping.entries.map((e) => e.variantId));
    expect(f.draft.roles).toEqual(f.mapping.roles);
  });
  it("does not choose one sample silently when a legacy appearance has conflicting samples", () => {
    const f = snapshot(); f.mapping.entries[2]!.swatchMediaId = "gid://shopify/MediaImage/201";
    expect(() => draftFromMapping(f.mapping, shopId, productId)).toThrow(/samples conflict/);
  });
  it("supports a custom Ascot name and separate same-name colours under different fabrics without a fake swatch", () => {
    const f = snapshot();
    f.draft.fabrics.push({ id: "boucle", name: "Teddy Boucle", description: "Merchant description", enabled: true, textureMediaId: null,
      colours: [{ id: "boucle-cream", name: "Cream", enabled: true, swatchMediaId: null, hex: null }, { id: "ascot", name: "Ascot", enabled: true, swatchMediaId: null, hex: null }] });
    const saved = compileFabricDocument(f.draft, shopId, productId, f);
    expect(saved.document.draft.fabrics[1]!.colours[1]).toMatchObject({ name: "Ascot", hex: null, swatchMediaId: null });
    expect(saved.document.published!.entries).toHaveLength(4); // no synthetic variants for the new colours
  });
  it.each(["duplicate-fabric", "duplicate-colour", "duplicate-variant", "wrong-hex", "image-url", "foreign-colour"])("rejects %s", (kind) => {
    const { draft } = snapshot();
    if (kind === "duplicate-fabric") draft.fabrics.push({ ...draft.fabrics[0]!, id: "duplicate", name: "VELVET" });
    if (kind === "duplicate-colour") draft.fabrics[0]!.colours.push({ ...draft.fabrics[0]!.colours[0]!, id: "duplicate" });
    if (kind === "duplicate-variant") draft.bindings.push({ ...draft.bindings[0]!, id: "duplicate" });
    if (kind === "wrong-hex") draft.fabrics[0]!.colours[0]!.hex = "Ascot";
    if (kind === "image-url") draft.fabrics[0]!.textureMediaId = "https://evil.test/image.jpg";
    if (kind === "foreign-colour") draft.bindings[0]!.colourId = "foreign";
    expect(() => parseFabricDraft(draft)).toThrow();
  });
  it("persists external values as unready data without approving them or creating native variants", () => {
    const f = snapshot(), binding = f.draft.bindings[0]!;
    binding.variantId = null; binding.nativeOptions = {}; binding.externalValues = { "External colour": "Ascot" };
    const result = compileFabricDocument(f.draft, shopId, productId, f);
    expect(result.document.draft.bindings[0]!.externalValues).toEqual({ "External colour": "Ascot" });
    expect(result.document.published!.entries.some((e) => e.id === binding.id)).toBe(false);
    expect(result.diagnostics[binding.id]).toContain("authenticated native-linked variant");
  });
  it.each(["missing-reference", "unreviewed", "disabled-colour", "disabled-fabric"])("blocks %s while retaining an editable draft", (kind) => {
    const f = snapshot(), binding = f.draft.bindings[0]!;
    if (kind === "missing-reference") binding.referenceMediaIds = [];
    if (kind === "unreviewed") binding.reviewed = false;
    if (kind === "disabled-colour") f.draft.fabrics[0]!.colours.find((c) => c.id === binding.colourId)!.enabled = false;
    if (kind === "disabled-fabric") f.draft.fabrics[0]!.enabled = false;
    const result = compileFabricDocument(f.draft, shopId, productId, f);
    expect(result.document.published?.entries.some((e) => e.id === binding.id) ?? false).toBe(false);
    expect(result.document.draft.bindings).toHaveLength(4);
  });
  it.each(["stale-variant", "missing-media", "sample-as-reference", "conflicting-composite"])("rejects %s instead of silently repairing or dropping it", (kind) => {
    const f = snapshot();
    if (kind === "stale-variant") f.variants[0]!.selectedOptions[0]!.value = "Changed";
    if (kind === "missing-media") f.media.splice(0, 1);
    if (kind === "sample-as-reference") f.draft.bindings[1]!.referenceMediaIds = ["gid://shopify/MediaImage/201"];
    if (kind === "conflicting-composite") f.draft.bindings[3]!.colourId = f.draft.bindings[0]!.colourId;
    expect(() => compileFabricDocument(f.draft, shopId, productId, f)).toThrow();
  });
  it("enforces shop/product ownership on the document envelope as well as published mappings", () => {
    const f = snapshot(), { document } = compileFabricDocument(f.draft, shopId, productId, f);
    expect(() => parseFabricDocument(document, "other.myshopify.com", productId)).toThrow();
    expect(() => parseManualMapping(document, shopId, "gid://shopify/Product/2")).toThrow();
    document.published!.shopId = "other.myshopify.com";
    expect(() => parseManualMapping(document, shopId, productId)).toThrow();
  });
  it("rejects foreign/stale reference media even on an unreviewed external-only draft", () => {
    const f = snapshot();
    f.draft.bindings[0] = { ...f.draft.bindings[0]!, variantId: null, nativeOptions: {}, reviewed: false, externalValues: { Colour: "Ascot" }, referenceMediaIds: ["gid://shopify/MediaImage/999999"] };
    expect(() => compileFabricDocument(f.draft, shopId, productId, f)).toThrow(/another product/);
  });
  it("rejects a published appearance that conflicts with its manager draft", () => {
    const f = snapshot(), { document } = compileFabricDocument(f.draft, shopId, productId, f);
    document.draft.fabrics[0]!.colours[0]!.name = "Different appearance";
    expect(() => parseManualMapping(document, shopId, productId)).toThrow(/conflicts/);
  });
  it("reads numbered native Fabric/Colour options and only real Shopify swatches", () => {
    const opts = [{ name: "2. Choose Your Fabric", optionValues: [{ name: "Velvet" }] },
      { name: "3. Choose Your Colour", optionValues: [{ name: "Ascot", swatch: { color: "#123456", image: { image: { url: "https://cdn.shopify.com/real.jpg" } } } }, { name: "Cream" }] }];
    const variants = ["Ascot", "Cream"].map((value, i) => ({ id: String(i), availableForSale: i === 0, selectedOptions: [{ name: opts[0]!.name, value: "Velvet" }, { name: opts[1]!.name, value }, { name: "Size", value: "King" }] }));
    const model = nativeSelections(opts, opts[1]!.name, variants);
    expect(model.selections[0]).toMatchObject({ group: "Velvet", label: "Ascot", colour: "#123456", image: "https://cdn.shopify.com/real.jpg" });
    expect(model.selections[1]).toMatchObject({ label: "Cream", colour: null, image: null });
  });
});

describe("shared storefront and server preview authority", () => {
  it("projects real texture and separate samples, and displays unbound Ascot as unpreviewable", async () => {
    const f = snapshot(); f.draft.fabrics[0]!.textureMediaId = "gid://shopify/MediaImage/201";
    f.draft.fabrics[0]!.colours.push({ id: "ascot", name: "Ascot", enabled: true, hex: "#123456", swatchMediaId: null });
    const { document } = compileFabricDocument(f.draft, shopId, productId, f);
    const context = { ...f.context, setting: { ...f.context.setting, mapping: document } };
    const data = await manualStorefrontData(context);
    expect(data.fabricImages).toEqual({ Velvet: "https://cdn.shopify.com/201.jpg" });
    expect(data.swatches.find((s) => s.label === "Ascot")).toMatchObject({ colour: "#123456", available: false, variants: [] });
    const grey = document.published!.entries[1]!;
    const ready = await resolveConfiguredPreview(context, JSON.stringify([grey.fabric.id, grey.colour.id]), grey.variantId, "revision-1");
    expect(ready.urls).toEqual(["https://cdn.shopify.com/102.jpg"]);
    expect(ready.selectedOptions["1. Choose Your Size"]).toBe("King");
    await expect(resolveConfiguredPreview(context, JSON.stringify([grey.fabric.id, grey.colour.id]), grey.variantId, "old-revision")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(resolveConfiguredPreview({ ...context, sourceVariantId: f.variants[3]!.id }, JSON.stringify([grey.fabric.id, grey.colour.id]), grey.variantId, "revision-1")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    f.variants[1]!.availableForSale = false;
    // Fresh availability is checked in the adapter, not inferred from a location inventory field.
    context.admin = { graphql: async (q: string) => Response.json({ data: { product: q.includes("TryoraPreviewMedia") ? { id: productId, media: { nodes: f.media, pageInfo: { hasNextPage: false } } } : { id: productId, variants: { nodes: f.variants, pageInfo: { hasNextPage: false } } } } }) };
    await expect(resolveConfiguredPreview(context, JSON.stringify([grey.fabric.id, grey.colour.id]), grey.variantId, "revision-1")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("shows a sample-only draft without authorizing generation", async () => {
    const f = snapshot(); f.draft.bindings = [];
    const { document } = compileFabricDocument(f.draft, shopId, productId, f);
    const context = { ...f.context, setting: { ...f.context.setting, active: false, mapping: document } };
    const data = await manualStorefrontData(context);
    expect(data.swatches).toHaveLength(2);
    expect(data.swatches.every((s) => !s.available && !s.variants.length)).toBe(true);
    await expect(resolveConfiguredPreview(context, "anything", f.variants[0]!.id, "revision-1")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("authenticated two-mode admin", () => {
  it("loads product-owned evidence without changing merchant config or product data", async () => {
    const view = await loader({ request: new Request(`https://tryora.example/app/fabrics?product=${encodeURIComponent(productId)}`) } as any);
    expect(view.selected).toMatchObject({ title: "Synthetic bed", mode: "native", explicitlyOff: true });
    expect(state.writes).toEqual([]);
  });
  it("saves product-scoped Manual then Native mode while preserving explicit OFF and the manual draft", async () => {
    const f = snapshot();
    await saveFabricConfiguration(state.admin, shopId, productId, { mode: "manual", revision: "", draft: f.draft });
    expect(state.rows[0]).toMatchObject({ shopId, productId, providerId: "manual_mapping", active: true });
    const saved = structuredClone(state.rows[0].mapping), revision = state.rows[0].revision;
    f.draft.bindings[0]!.nativeOptions["Other bed choices"] = "stale local edit";
    await saveFabricConfiguration(state.admin, shopId, productId, { mode: "native", revision, draft: f.draft });
    expect(state.rows[0]).toMatchObject({ providerId: "shopify_native", active: true, mapping: saved });
    expect(state.config.enabled).toBe(false);
    expect(prisma.productPreviewConfig.update).not.toHaveBeenCalled();
    expect(state.writes.some((w) => w.shop?.update?.autoEnableProducts !== undefined)).toBe(false);
  });
  it("rejects stale revisions and unsupported modes without losing saved data", async () => {
    const f = snapshot(); await saveFabricConfiguration(state.admin, shopId, productId, { mode: "manual", revision: "", draft: f.draft });
    const saved = structuredClone(state.rows);
    await expect(saveFabricConfiguration(state.admin, shopId, productId, { mode: "manual", revision: "stale", draft: f.draft })).rejects.toThrow(/another session/);
    await expect(saveFabricConfiguration(state.admin, shopId, productId, { mode: "external-auto", revision: state.rows[0].revision, draft: f.draft })).rejects.toThrow(/Shopify Native/);
    expect(state.rows).toEqual(saved);
  });
  it("preserves legacy Cloudlift mappings on load and their adapter identity on an explicit manual save", async () => {
    const f = snapshot(); state.rows = [{ shopId, productId, providerId: "cloudlift", revision: "existing", active: true, mapping: f.mapping }];
    const before = structuredClone(state.rows);
    const view = await loader({ request: new Request(`https://tryora.example/app/fabrics?product=${encodeURIComponent(productId)}`) } as any);
    expect(view.selected).toMatchObject({ mode: "manual", providerId: "cloudlift" }); expect(state.rows).toEqual(before);
    await saveFabricConfiguration(state.admin, shopId, productId, { mode: "manual", revision: "existing", draft: f.draft });
    expect(state.rows[0].providerId).toBe("cloudlift");
  });
  it("does not overwrite a legacy profile that cannot be safely imported", async () => {
    const f = snapshot(); f.mapping.entries[2]!.swatchMediaId = "gid://shopify/MediaImage/201";
    state.rows = [{ shopId, productId, providerId: "manual_mapping", revision: "existing", active: true, mapping: f.mapping }];
    const original = structuredClone(state.rows);
    await expect(saveFabricConfiguration(state.admin, shopId, productId, { mode: "manual", revision: "existing", draft: emptyFabricDraft() })).rejects.toThrow(/cannot be imported safely/);
    expect(state.rows).toEqual(original);
  });
  it("does not read provider tables or write configuration when the rollout flag is OFF", async () => {
    vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED", "false");
    await loader({ request: new Request(`https://tryora.example/app/fabrics?product=${encodeURIComponent(productId)}`) } as any);
    expect(prisma.customizationConfig.findMany).not.toHaveBeenCalled();
    expect(await action({ request: request({ mode: "manual" }) } as any)).toHaveProperty("error");
    expect(state.writes).toEqual([]);
  });
  it("blocks unapproved installations before reading mappings, saving or uploading, regardless of submitted shop", async () => {
    vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_SHOPS", "approved.myshopify.com");
    const view = await loader({ request: new Request(`https://tryora.example/app/fabrics?product=${encodeURIComponent(productId)}`) } as any);
    expect(view.installationReady).toBe(false); expect(view.manualSetupReason).toContain("authorize this Shopify installation");
    expect(prisma.customizationConfig.findMany).not.toHaveBeenCalled();
    for (const intent of ["save", "upload"]) expect(await action({ request: request({ intent, shop: "approved.myshopify.com", mode: "manual" }) } as any)).toHaveProperty("error");
    await expect(saveFabricConfiguration(state.admin, shopId, productId, { mode: "manual", revision: "", draft: snapshot().draft })).rejects.toThrow(/authorization/);
    expect(prisma.customizationConfig.findUnique).not.toHaveBeenCalled(); expect(state.writes).toEqual([]);
  });
  it("reports malformed operator policy without exposing its contents or reading provider data", async () => {
    vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_SHOPS", "secret-approved.myshopify.com,*");
    const view = await loader({ request: new Request(`https://tryora.example/app/fabrics?product=${encodeURIComponent(productId)}`) } as any);
    expect(view.installationReady).toBe(false); expect(view.manualSetupReason).toContain("allowlist is invalid");
    expect(JSON.stringify(view)).not.toContain("secret-approved.myshopify.com");
    expect(prisma.customizationConfig.findMany).not.toHaveBeenCalled();
  });
  it("applies scoped grants to runtime provider reads as well as admin writes", async () => {
    state.rows = [{ shopId, productId, providerId: "manual_mapping", revision: "r", active: true, mapping: {} }];
    vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_SHOPS", "another.myshopify.com");
    expect((await loadProviderSetting(shopId, productId)).providerId).toBe("shopify_native");
    expect(prisma.customizationConfig.findMany).not.toHaveBeenCalled();
    vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_SHOPS", shopId);
    expect((await loadProviderSetting(shopId, productId)).providerId).toBe("manual_mapping");
    expect(prisma.customizationConfig.findMany).toHaveBeenCalledOnce();
  });
  it("persists reviewed fabrics/colours/exact references for an approved installation without enabling previews", async () => {
    vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_SHOPS", shopId);
    const { draft } = snapshot();
    const response = await action({ request: request({ mode: "manual", draft: JSON.stringify(draft) }) } as any);
    expect(response).toBeInstanceOf(Response);
    const view = await loader({ request: new Request(`https://tryora.example/app/fabrics?product=${encodeURIComponent(productId)}`) } as any);
    expect(view.installationReady).toBe(true); expect(view.selected?.explicitlyOff).toBe(true);
    expect(view.selected?.draft).toEqual(draft); expect(state.rows[0].mapping.published.entries).toHaveLength(4);
    expect(state.config.enabled).toBe(false);
  });
  it("requires authentication and authenticated product ownership", async () => {
    state.authenticate.mockRejectedValue(new Response("Unauthorized", { status: 401 }));
    await expect(action({ request: request({}) } as any)).rejects.toMatchObject({ status: 401 });
    state.authenticate.mockResolvedValue({ admin: state.admin, session: { shop: shopId } });
    expect(await action({ request: request({}, "gid://shopify/Product/999") } as any)).toHaveProperty("error");
    expect(state.writes).toEqual([]);
  });
  it("blocks native-mode image uploads before any Shopify mutation", async () => {
    state.rows = [{ shopId, productId, providerId: "shopify_native", revision: "r", active: true, mapping: null }];
    const result = await action({ request: request({ intent: "upload", revision: "r" }) } as any);
    expect(result).toHaveProperty("error"); expect(state.writes).toEqual([]);
  });
});

describe("actual merchant image uploads", () => {
  it("validates small real sample images, strips metadata and rejects fake/animated/oversized images", async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ddd" } }).png().toBuffer();
    expect((await sharp(await cleanFabricImage(new Blob([png]))).metadata()).format).toBe("jpeg");
    await expect(cleanFabricImage(new Blob(["not an image"], { type: "image/jpeg" }))).rejects.toThrow(/validated/);
    await expect(cleanFabricImage(new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]))).rejects.toThrow(/8 MB/);
  });
  it("uses Shopify-issued staged uploads and attaches media only to the authenticated product", async () => {
    const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ddd" } }).png().toBuffer();
    let alt = "";
    const admin = { graphql: vi.fn(async (query: string, init: any) => {
      if (query.includes("TryoraStageFabricImage")) return Response.json({ data: { stagedUploadsCreate: { userErrors: [], stagedTargets: [{ url: "https://shopify-staged-uploads.storage.googleapis.com/", resourceUrl: "https://shopify-staged-uploads.storage.googleapis.com/tmp/image.jpg", parameters: [{ name: "key", value: "issued-by-shopify" }] }] } } });
      if (query.includes("TryoraAttachFabricImage")) { expect(init.variables.product).toEqual({ id: productId }); alt = init.variables.media[0].alt; return Response.json({ data: { productUpdate: { product: { id: productId }, userErrors: [] } } }); }
      return Response.json({ data: { product: { id: productId, media: { nodes: [{ id: "gid://shopify/MediaImage/999", alt, image: { url: "https://cdn.shopify.com/upload.jpg" } }] } } } });
    }) };
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response("", { status: 201 })); vi.stubGlobal("fetch", fetcher);
    expect(await uploadFabricMedia(admin, productId, new Blob([image]))).toEqual({ pending: false, media: { id: "gid://shopify/MediaImage/999", url: "https://cdn.shopify.com/upload.jpg" } });
    expect(fetcher.mock.calls[0]![0]).toBe("https://shopify-staged-uploads.storage.googleapis.com/");
    expect(state.writes).toEqual([]); // an upload alone never approves a reference or creates a mapping
  });
  it("bounds streamed form bodies before parsing multipart data", async () => {
    const r = new Request("https://tryora.example", { method: "POST", body: new URLSearchParams({ draft: "x".repeat(200) }) });
    await expect(fabricForm(r, 64)).rejects.toMatchObject({ status: 413 });
  });
});
