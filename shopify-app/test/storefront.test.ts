import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { PreviewService, InMemoryStore } from "../app/core/index";

const fixture = vi.hoisted(() => ({ service: null as any, config: null as any, providerSettings: [] as any[], usages: [] as any[], events: new Map<string, unknown>(), leadUpdates: [] as any[] }));
// Exercise the real mock provider without the development UI's artificial delay.
// Timeout/abort behaviour is tested separately with an explicitly hung provider.
vi.mock("../app/image-provider.server", async () => {
  const { MockImageProvider } = await import("../app/core/provider");
  return { createImageProvider: () => new MockImageProvider(0) };
});
vi.mock("../app/db.server", () => ({ default: {
  productPreviewConfig: { findUnique: vi.fn(async () => fixture.config) },
  customizationConfig: { findMany: vi.fn(async () => fixture.providerSettings) },
  visualChoice: { findMany: vi.fn(async () => fixture.config.choices ?? []) },
  providerUsage: { create: vi.fn(async ({ data }) => { fixture.usages.push(data); return data; }) },
  event: { upsert: vi.fn(async ({ where, create }) => { fixture.events.set(where.id, create); }), create: vi.fn(async () => ({})) },
  shop: { findUnique: vi.fn(async () => ({ leadSettings: {}, storefrontEnabled: true })) },
  appearance: { findFirst: vi.fn(async () => null) },
  campaign: { findFirst: vi.fn(async () => null) },
  leadDelivery: { create: vi.fn(async () => ({ id: "lead" })), update: vi.fn(async ({ data }) => { fixture.leadUpdates.push(data); }) },
} }));
vi.mock("../app/tryora.server", () => ({ tryora: new Proxy({}, { get: (_, key) => fixture.service[key].bind(fixture.service) }) }));
import { acknowledge, captureLead, checkPhoto, cleanupStalePreviews, pollLocalPreview, provider, startPreview, storefrontConfig } from "../app/storefront.server";
import prisma from "../app/db.server";
import { providerFixture } from "./fixtures/provider-mapping";

const shopId = "test.myshopify.com";
const productId = "gid://shopify/Product/1";
let photo: Uint8Array;
let admin: { graphql: ReturnType<typeof vi.fn<(q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>>> };
let sequence = 0;
const start = (over: Record<string, unknown> = {}) => startPreview({ admin, shopId, productId, room: photo, optionValue: "Blue", visitorId: "visitor", idempotencyKey: `key-${++sequence}`, leadStepDone: true, ...over });

async function finished(jobId: string) {
  let result: any;
  await vi.waitFor(async () => {
    result = await pollLocalPreview(shopId, jobId);
    expect(["ready", "failed"]).toContain(result.stage);
  }, { timeout: 3000, interval: 10 });
  return result;
}

beforeEach(async () => {
  vi.useFakeTimers();
  fixture.service = new PreviewService(new InMemoryStore());
  await fixture.service.grantTrial(shopId);
  fixture.providerSettings = [];
  fixture.usages = []; fixture.events.clear(); fixture.leadUpdates = [];
  fixture.config = { shopId, productId, enabled: true, readiness: "ready", choices: [], referenceMediaId: "gid://shopify/MediaImage/1", referenceAngle: "diagonal", placement: "replace", setting: "outdoor", itemNoun: "chair", visualOptionName: "Colour", frozenContext: {} };
  photo = await sharp({ create: { width: 500, height: 400, channels: 3, background: "blue" } }).jpeg().toBuffer();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from(photo))));
  admin = { graphql: vi.fn(async (q: string) => {
    if (q.includes("TryoraPreviewMedia")) return Response.json({ data: { product: { media: { nodes: [{ id: fixture.config.referenceMediaId, image: { url: "https://cdn.shopify.com/product.jpg" } }], pageInfo: { hasNextPage: false } } } } });
    return Response.json({ data: { product: {
      title: "Garden chair", productType: "chair", description: "A blue chair",
      options: [{ name: "Colour", optionValues: [{ name: "Blue" }, { name: "Red" }] }],
      variants: { nodes: [{ id: "variant", availableForSale: true, selectedOptions: [{ name: "Colour", value: "Blue" }], image: { url: "https://cdn.shopify.com/blue.jpg" } }], pageInfo: { hasNextPage: false, endCursor: null } },
    } } });
  }) };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await vi.advanceTimersByTimeAsync(11 * 60_000);
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe("preview lifecycle", () => {
  it.each(["ready", "missing", "lookup-failed", "download-failed", "colour-failed", "invalid-image"])("uses available samples and falls back to names for unavailable samples (%s)", async (mode) => {
    vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED", "true");
    const synthetic = providerFixture();
    const swatchId = "gid://shopify/MediaImage/901", textureId = "gid://shopify/MediaImage/902";
    fixture.config.visualOptionName = "2. Choose Your Fabric";
    fixture.config.referenceMediaId = "gid://shopify/MediaImage/101";
    fixture.providerSettings = [{ shopId, productId, providerId: "manual_mapping", active: true, revision: "samples-1", mapping: {
      kind: "fabric_colour_manager", schemaVersion: 1, shopId, productId, published: null,
      draft: { roles: {}, bindings: [], fabrics: [{ id: "plush", name: "Plush", description: "", enabled: true, textureMediaId: textureId,
        colours: [{ id: "cream", name: "Cream", enabled: true, hex: "#eeeeee", swatchMediaId: swatchId }] }] },
    } }];
    admin.graphql.mockImplementation(async (query, opts) => {
      if (!query.includes("TryoraSavedFabricSamples")) return synthetic.graphql(query);
      expect(opts?.variables?.ids).toEqual([swatchId, textureId]);
      if (mode === "lookup-failed") throw new Error("Files unavailable");
      return Response.json({ data: { nodes: mode === "missing" ? [] : [swatchId, textureId].map((id, i) => ({
        id, alt: "Tryora fabric sample test", fileStatus: "READY", image: { url: `https://cdn.shopify.com/sample-${i}.png` },
      })) } });
    });
    const colourBytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ddcbaa" } }).png().toBuffer();
    const textureBytes = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#888888" } }).png().toBuffer();
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).includes("sample-") && mode === "download-failed") return new Response(null, { status: 404 });
      if (String(url).includes("sample-0") && mode === "colour-failed") return new Response(null, { status: 404 });
      if (String(url).includes("sample-") && mode === "invalid-image") return new Response("invalid image bytes");
      return new Response(Buffer.from(String(url).includes("sample-0") ? colourBytes : String(url).includes("sample-1") ? textureBytes : photo));
    });
    const generate = vi.spyOn(provider, "generate");
    const input = { optionValue: '["plush","cream"]', variantId: synthetic.variants[0]!.id, sourceVariantId: synthetic.variants[0]!.id, mappingRevision: "samples-1" };
    const { jobId } = await start(input);
    const result = await finished(jobId);
    expect(result.stage).toBe("ready");
    const request = generate.mock.calls[0]![0];
    expect(request.previewOnlyAppearance).toEqual({ fabric: "Plush", colour: "Cream", hex: "#eeeeee" });
    expect(request.productReferences).toHaveLength(1);
    if (mode === "ready") expect((await sharp(request.swatch).metadata()).width).toBe(64);
    else expect(request.swatch).toBeUndefined();
    if (mode === "ready" || mode === "colour-failed") expect((await sharp(request.fabricTexture).metadata()).width).toBe(80);
    else expect(request.fabricTexture).toBeUndefined();
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      "https://cdn.shopify.com/101.jpg", ...(mode === "missing" || mode === "lookup-failed" ? [] : ["https://cdn.shopify.com/sample-0.png", "https://cdn.shopify.com/sample-1.png"]),
    ]);
    expect((await fixture.service.balance(shopId)).consumed).toBe(0);
    await acknowledge(shopId, jobId, result.token);
    expect((await fixture.service.balance(shopId)).consumed).toBe(1);
  });
  it("bounds customization identities before native lookups or provider work", async () => {
    const analyse = vi.spyOn(provider, "analyseRoom");
    for (const over of [{ optionValue: "x".repeat(4097) }, { sourceVariantId: "x".repeat(129) }, { mappingRevision: "x".repeat(129) }]) {
      await expect(start(over)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(admin.graphql).not.toHaveBeenCalled(); expect(analyse).not.toHaveBeenCalled();
    expect((await fixture.service.balance(shopId)).availableTotal).toBe(10);
  });
  it("rejects an unverified provider or missing manual reference before provider calls and credit reservation", async () => {
    vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED", "true");
    const analyse = vi.spyOn(provider, "analyseRoom");
    fixture.providerSettings = [{ shopId, productId, providerId: "cloudlift", active: false, revision: "disabled", mapping: null }];
    await expect(start()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const synthetic = providerFixture(); synthetic.mapping.shopId = shopId;
    synthetic.mapping.entries[0]!.referenceMediaIds = ["gid://shopify/MediaImage/999"];
    fixture.providerSettings = [{ shopId, productId, providerId: "manual_mapping", active: true, revision: "revision-1", mapping: synthetic.mapping }];
    admin.graphql.mockImplementation(synthetic.graphql);
    await expect(start({ optionValue: '["velvet","grey"]', variantId: "gid://shopify/ProductVariant/12", sourceVariantId: "gid://shopify/ProductVariant/11", mappingRevision: "revision-1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(analyse).not.toHaveBeenCalled();
    expect(fixture.usages).toEqual([]);
    expect((await fixture.service.balance(shopId)).availableTotal).toBe(10);
  });

  it.each(["manual_mapping", "cloudlift"])("delivers a reviewed native-linked reference through %s with credit only on acknowledgement", async (providerId) => {
    vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED", "true");
    const synthetic = providerFixture(); synthetic.mapping.shopId = shopId;
    fixture.providerSettings = [{ shopId, productId, providerId, active: true, revision: "revision-1", mapping: synthetic.mapping }];
    fixture.config.visualOptionName = "2. Choose Your Fabric";
    admin.graphql.mockImplementation(synthetic.graphql);
    const generate = vi.spyOn(provider, "generate");
    const { jobId } = await start({ optionValue: '["velvet","grey"]', variantId: "gid://shopify/ProductVariant/12", sourceVariantId: "gid://shopify/ProductVariant/11", mappingRevision: "revision-1" });
    const ready = await finished(jobId);
    expect(ready.stage).toBe("ready");
    expect(generate.mock.calls[0]?.[0].optionValue).toBe("Velvet / Grey");
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(["https://cdn.shopify.com/102.jpg"]);
    expect((await fixture.service.balance(shopId)).consumed).toBe(0);
    await acknowledge(shopId, jobId, ready.token);
    expect((await fixture.service.balance(shopId)).consumed).toBe(1);
  });
  it("hides stale mappings and rejects generation before credit reservation or provider use", async () => {
    fixture.config.visualOptionName = "Old Colour";
    const analyse = vi.spyOn(provider, "analyseRoom");
    expect(await storefrontConfig(admin, shopId, productId)).toEqual({ enabled: false });
    await expect(start()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(analyse).not.toHaveBeenCalled();
    expect((await fixture.service.balance(shopId)).availableTotal).toBe(10);
  });

  it("blocks ambiguous automatic discovery without treating it as single-style", async () => {
    fixture.config.autoConfigured = true;
    fixture.config.visualOptionName = null;
    // Exercise the resolver independently of the auto-config API mock.
    const { resolvePreviewProduct } = await import("../app/preview-product.server");
    const graphql = vi.fn(async () => Response.json({ data: { product: {
      title: "Bed", options: ["Colour", "Color"].map((name) => ({ name, optionValues: [{ name: "Cream" }] })),
      variants: { nodes: [], pageInfo: { hasNextPage: false } },
    } } }));
    await expect(resolvePreviewProduct({ graphql }, fixture.config, "__single__", "variant")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await fixture.service.balance(shopId)).availableTotal).toBe(10);
  });
  it("loads exact product references and context, checks results, records costs and metadata", async () => {
    const analyse = vi.spyOn(provider, "analyseRoom").mockResolvedValue({ outcome: "accepted", confidence: 1, costMicros: 3 });
    const generate = vi.spyOn(provider, "generate").mockImplementation(async (req) => ({ image: req.roomImage, mimeType: "image/jpeg", costMicros: 7, providerRequestId: "req1", model: "test" }));
    const check = vi.spyOn(provider, "checkResult").mockResolvedValue({ outcome: "accepted", costMicros: 2 });
    const { jobId } = await start();
    expect((await finished(jobId)).stage).toBe("ready");
    expect(analyse).toHaveBeenCalledWith(expect.any(Uint8Array), "diagonal", { placement: "replace", setting: "outdoor", itemNoun: "chair" }, expect.any(AbortSignal));
    expect(generate.mock.calls[0]![0]).toMatchObject({ productDescription: expect.stringContaining("Garden chair"), optionValue: "Blue" });
    expect(generate.mock.calls[0]![0].productDescription).toContain("A blue chair");
    expect(generate.mock.calls[0]![0].productDescription).toContain('"name":"Colour","value":"Blue"');
    expect(generate.mock.calls[0]![0].productReferences).toHaveLength(1);
    expect(check).toHaveBeenCalledOnce();
    expect(await fixture.service.getJob(jobId)).toMatchObject({ providerRequestId: "req1", costMicros: 12 });
    expect(fixture.usages.map((x) => x.stage)).toEqual(["generation_photo_check", "generation", "result_check"]);
  });

  it("rejects malformed photos and mandatory photo-check failures before reserving", async () => {
    await expect(start({ room: new Uint8Array([1, 2, 3]) })).rejects.toMatchObject({ code: "BAD_PHOTO" });
    vi.spyOn(provider, "analyseRoom").mockResolvedValue({ outcome: "unsupported", confidence: 1, costMicros: 1 });
    await expect(start()).rejects.toMatchObject({ code: "BAD_PHOTO" });
    expect((await fixture.service.balance(shopId)).availableTotal).toBe(10);
  });

  it("passes only a validated selected Shopify variant into generation", async () => {
    await expect(start({ variantId: "invalid" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await fixture.service.balance(shopId)).availableTotal).toBe(10);
    const generate = vi.spyOn(provider, "generate");
    await finished((await start({ variantId: "variant" })).jobId);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("rejects unready products, unknown options and unavailable selections", async () => {
    fixture.config.readiness = "needs_attention";
    await expect(start()).rejects.toMatchObject({ code: "NOT_FOUND" });
    fixture.config.readiness = "ready";
    await expect(start({ optionValue: "Purple" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(start({ optionValue: "Red" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await fixture.service.balance(shopId)).availableTotal).toBe(10);
  });

  it("refuses providers without confirmed zero retention", async () => {
    vi.spyOn(provider, "capabilities").mockReturnValue({ name: "real", zeroRetentionConfirmed: false, supportsCancel: true, supportsMaskedEdit: false });
    await expect(start()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("expires abandoned ready results, releases credit and never serves expired tokens", async () => {
    const { jobId } = await start();
    const ready = await finished(jobId);
    expect((await fixture.service.balance(shopId)).availableTotal).toBe(9);
    await vi.advanceTimersByTimeAsync(ready.expiresAt - Date.now());
    expect(await pollLocalPreview(shopId, jobId)).toEqual({ stage: "expired" });
    expect((await fixture.service.balance(shopId)).availableTotal).toBe(10);
  });

  it("aborts hung providers and ignores late results", async () => {
    let resolve!: (r: any) => void;
    let signal: AbortSignal | undefined;
    vi.spyOn(provider, "generate").mockImplementation((_req, s) => { signal = s; return new Promise((r) => { resolve = r; }); });
    const { jobId } = await start();
    await vi.waitFor(() => expect(signal).toBeDefined());
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(signal!.aborted).toBe(true);
    expect((await fixture.service.balance(shopId)).availableTotal).toBe(10);
    resolve({ image: photo, mimeType: "image/jpeg", costMicros: 1, providerRequestId: "late", model: "late" });
    await Promise.resolve();
    expect(await pollLocalPreview(shopId, jobId)).toEqual({ stage: "expired" });
  });

  it("rejects unusable and semantically incorrect output without consuming credit", async () => {
    vi.spyOn(provider, "checkResult").mockResolvedValue({ outcome: "rejected", costMicros: 1 });
    const first = await start();
    expect(await finished(first.jobId)).toMatchObject({ stage: "failed", error: "RESULT_REJECTED" });
    expect((await fixture.service.balance(shopId)).availableTotal).toBe(10);
    vi.spyOn(provider, "generate").mockResolvedValue({ image: new Uint8Array([1]), mimeType: "image/jpeg", costMicros: 4, model: "bad", providerRequestId: "bad" });
    expect((await finished((await start()).jobId)).stage).toBe("failed");
    expect((await fixture.service.balance(shopId)).availableTotal).toBe(10);
  });

  it("records failed attempt costs without persisting raw exception text", async () => {
    vi.spyOn(provider, "generate").mockRejectedValue(Object.assign(new Error("private shopper data"), { costMicros: 5 }));
    expect((await finished((await start()).jobId)).stage).toBe("failed");
    expect(fixture.usages.at(-1)).toMatchObject({ stage: "generation", outcome: "failed", costMicros: 5 });
    expect(JSON.stringify(fixture.usages)).not.toContain("private shopper data");
  });

  it("makes credit settlement and delivery analytics idempotent across concurrent acknowledgements", async () => {
    const { jobId } = await start();
    const ready = await finished(jobId);
    await Promise.all([acknowledge(shopId, jobId, ready.token), acknowledge(shopId, jobId, ready.token)]);
    expect((await fixture.service.balance(shopId)).consumed).toBe(1);
    expect(fixture.events.size).toBe(1);
    expect(await pollLocalPreview(shopId, jobId)).toEqual({ stage: "expired" });
  });

  it("isolates shops and rejects bad delivery tokens", async () => {
    const { jobId } = await start();
    await finished(jobId);
    expect(await pollLocalPreview("other", jobId)).toEqual({ stage: "expired" });
    await expect(acknowledge("other", jobId, "token")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(acknowledge(shopId, jobId, "wrong")).rejects.toMatchObject({ code: "BAD_TOKEN" });
  });

  it("recovers reservations left by a restart through periodic stale cleanup", async () => {
    const { job } = await fixture.service.createPreview({ shopId, productId, visitorId: "v", optionValue: "Blue", idempotencyKey: "orphan", referenceVersion: "1", roomPhotoHash: "hash", leadStepDone: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await cleanupStalePreviews();
    expect((await fixture.service.getJob(job.id)).state).toBe("EXPIRED");
    expect((await fixture.service.balance(shopId)).availableTotal).toBe(10);
  });

  it("returns the same job on request retry", async () => {
    const one = await start({ idempotencyKey: "same" });
    const two = await start({ idempotencyKey: "same" });
    expect(two).toEqual(one);
    await finished(one.jobId);
    expect((await fixture.service.balance(shopId)).reserved).toBe(1);
  });

  it("does not deliver late output after a job was cancelled", async () => {
    let complete!: (r: any) => void;
    vi.spyOn(provider, "generate").mockImplementation(() => new Promise((r) => { complete = r; }));
    const { jobId } = await start();
    await vi.waitFor(() => expect(complete).toBeDefined());
    await fixture.service.transition(jobId, "CANCELLED");
    complete({ image: photo, mimeType: "image/jpeg", costMicros: 4, providerRequestId: "late", model: "test" });
    await vi.waitFor(async () => expect((await pollLocalPreview(shopId, jobId)).stage).toBe("expired"));
    expect((await fixture.service.balance(shopId)).consumed).toBe(0);
    expect((await fixture.service.balance(shopId)).availableTotal).toBe(10);
  });

  it("includes availability from later variant pages in storefront swatches", async () => {
    admin.graphql.mockImplementation(async (_q: string, opts: any) => {
      const more = !opts.variables.after;
      return Response.json({ data: { product: {
        title: "Chair", productType: "chair", options: [{ name: "Colour", optionValues: [{ name: "Blue" }, { name: "Red" }] }],
        variants: { nodes: [{ id: more ? "gid://shopify/ProductVariant/1" : "gid://shopify/ProductVariant/2", availableForSale: !more, image: { url: more ? "https://cdn.shopify.com/blue.jpg" : "https://cdn.shopify.com/red.jpg" }, selectedOptions: [{ name: "Colour", value: more ? "Blue" : "Red" }] }], pageInfo: { hasNextPage: more, endCursor: more ? "cursor" : null } },
      } } });
    });
    const config = await storefrontConfig(admin, shopId, productId);
    expect(config.enabled && config.swatches).toMatchObject([
      { value: "Blue", available: false, variants: [] },
      { value: "Red", available: true, variants: [{ id: "gid://shopify/ProductVariant/2", image: "https://cdn.shopify.com/red.jpg", options: { Colour: "Red" } }] },
    ]);
    expect(admin.graphql).toHaveBeenCalledTimes(2);
  });

  it("checks photo context and records analysis costs without a preview job", async () => {
    const spy = vi.spyOn(provider, "analyseRoom").mockResolvedValue({ outcome: "accepted", confidence: .5, detected: "wall", costMicros: 2 });
    expect(await checkPhoto(admin, photo, shopId, productId)).toEqual({ ok: true, detected: undefined });
    expect(spy).toHaveBeenCalledWith(expect.any(Uint8Array), "diagonal", expect.objectContaining({ setting: "outdoor" }), expect.any(AbortSignal));
    expect(fixture.usages[0]).toMatchObject({ stage: "photo_check", costMicros: 2 });
  });

  it("serves native dependent swatches and generates the approved exact fabric/colour variant", async () => {
    fixture.config.visualOptionName = "Fabric";
    const p = {
      title: "Bed", productType: "Bed", description: "Upholstered",
      options: [
        { name: "Fabric", optionValues: [{ name: "Plush Velvet" }, { name: "Teddy Boucle" }] },
        { name: "Colour", optionValues: [{ name: "Cream", swatch: { image: { image: { url: "https://cdn.shopify.com/cream-swatch.jpg" } } } }, { name: "Grey" }] },
        { name: "Size", optionValues: [{ name: "King" }] },
      ],
      variants: { nodes: [
        { id: "plush-cream", availableForSale: true, image: { url: "https://cdn.shopify.com/plush-cream-bed.jpg" }, selectedOptions: [{ name: "Fabric", value: "Plush Velvet" }, { name: "Colour", value: "Cream" }, { name: "Size", value: "King" }] },
        { id: "boucle-grey", availableForSale: true, image: { url: "https://cdn.shopify.com/boucle-grey-bed.jpg" }, selectedOptions: [{ name: "Fabric", value: "Teddy Boucle" }, { name: "Colour", value: "Grey" }, { name: "Size", value: "King" }] },
      ], pageInfo: { hasNextPage: false } },
    };
    admin.graphql.mockImplementation(async () => Response.json({ data: { product: p } }));
    const cfg = await storefrontConfig(admin, shopId, productId);
    expect(cfg.enabled && cfg).toMatchObject({ fabricOptionName: "Fabric", optionName: "Colour", selectionOptionNames: ["Fabric", "Colour"] });
    expect(cfg.enabled && cfg.swatches).toMatchObject([
      { value: '["Plush Velvet","Cream"]', label: "Cream", group: "Plush Velvet", image: "https://cdn.shopify.com/cream-swatch.jpg", available: true },
      { value: '["Teddy Boucle","Grey"]', label: "Grey", group: "Teddy Boucle", image: null, colour: null, available: true },
    ]);
    await expect(start({ optionValue: '["Teddy Boucle","Cream"]', variantId: "boucle-grey" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await fixture.service.balance(shopId)).availableTotal).toBe(10);
    const generate = vi.spyOn(provider, "generate");
    await finished((await start({ optionValue: '["Teddy Boucle","Grey"]', variantId: "boucle-grey" })).jobId);
    expect(generate.mock.calls[0]?.[0].optionValue).toBe("Teddy Boucle / Grey");
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(["https://cdn.shopify.com/boucle-grey-bed.jpg"]);
  });
});

describe("lead delivery", () => {
  const lead = { shopId, productId, email: "shopper@example.com", marketing: true, wording: "Offers" };
  it("records consent API user errors as delivery failures using safe error codes", async () => {
    admin.graphql.mockResolvedValueOnce(Response.json({ data: { customerSet: { customer: { id: "customer" }, userErrors: [] } } }))
      .mockResolvedValueOnce(Response.json({ data: { customerEmailMarketingConsentUpdate: { userErrors: [{ message: "shopper@example.com failed" }] } } }));
    expect(await captureLead(admin, lead)).toEqual({ ok: true });
    expect(fixture.leadUpdates.at(-1)).toMatchObject({ status: "failed", lastError: "CONSENT_SAVE_FAILED" });
    expect(JSON.stringify(fixture.leadUpdates)).not.toContain(lead.email);
  });
  it("keeps customer failures out of logs and preserves the shopper flow", async () => {
    admin.graphql.mockRejectedValueOnce(new Error(lead.email));
    expect(await captureLead(admin, lead)).toEqual({ ok: true });
    expect(fixture.leadUpdates.at(-1)).toMatchObject({ status: "failed", lastError: "CUSTOMER_SAVE_FAILED" });
  });
  it("accepts a successful customer save and consent update", async () => {
    admin.graphql.mockResolvedValueOnce(Response.json({ data: { customerSet: { customer: { id: "customer" }, userErrors: [] } } }))
      .mockResolvedValueOnce(Response.json({ data: { customerEmailMarketingConsentUpdate: { userErrors: [] } } }));
    await captureLead(admin, lead);
    expect(fixture.leadUpdates.at(-1)).toMatchObject({ status: "accepted", customerRef: "customer" });
    expect(prisma.leadDelivery.update).toHaveBeenCalled();
  });
});
