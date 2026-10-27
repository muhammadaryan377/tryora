/**
 * Fabric texture, colour sample and full furniture reference are separate image roles. These tests reproduce the
 * product-photo-as-swatch bug at the data level (projection, save, admin load, preview references), not through CSS.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerFixture, productId, shopId } from "./fixtures/provider-mapping";
const state = vi.hoisted(() => ({ rows: [] as any[], upserts: [] as any[], admin: null as any }));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: async () => ({ admin: state.admin, session: { shop: "synthetic.myshopify.com" } }) } }));
vi.mock("../app/db.server", () => ({ default: {
  productPreviewConfig: { findUnique: vi.fn(async () => null), upsert: vi.fn(async (args: any) => { state.upserts.push(args); return args.create; }) },
  shop: { findUnique: vi.fn(async () => ({ autoEnableProducts: true })) },
  customizationConfig: { findMany: vi.fn(async (args: any) => state.rows.filter((r) => r.shopId === args.where.shopId && args.where.productId.in.includes(r.productId))) },
} }));
import { manualStorefrontData } from "../app/customization/validation.server";
import { compileFabricDocument, draftFromMapping } from "../app/customization/fabric-manager.server";
import { resolveConfiguredPreview } from "../app/customization/registry.server";
import { resolvePreviewProduct } from "../app/preview-product.server";
import { ensureAutoProductConfig } from "../app/auto-products.server";
import { isSampleMedia, referenceChoices, sampleChoices, SAMPLE_ALT_PREFIX } from "../app/customization/media-roles";
import { loader } from "../app/routes/app.fabrics";

const gid = (n: number) => `gid://shopify/MediaImage/${n}`;
const photo = (n: number) => ({ id: gid(n), alt: "Aurora bed in a bedroom", image: { url: `https://cdn.shopify.com/furniture-${n}.jpg` } });
const sample = (n: number) => ({ id: gid(n), alt: `${SAMPLE_ALT_PREFIX}${n}`, image: { url: `https://cdn.shopify.com/sample-${n}.jpg` } });
/** Five full furniture photos (101-105) and, optionally, real uploaded samples. */
function product(extra: any[] = []) {
  const f = providerFixture();
  const media = [101, 102, 103, 104, 105].map(photo).concat(extra);
  const graphql = vi.fn(async (query: string, _init?: unknown) => Response.json({ data: { product: query.includes("TryoraPreviewMedia")
    ? { id: productId, media: { nodes: media, pageInfo: { hasNextPage: false } } }
    : { id: productId, title: "Aurora Bed", productType: "Bed", options: f.variants[0]!.selectedOptions.map((o) => ({ name: o.name, optionValues: [...new Set(f.variants.map((v) => v.selectedOptions.find((x) => x.name === o.name)!.value))].map((name) => ({ name })) })),
      variants: { nodes: f.variants, pageInfo: { hasNextPage: false } } } } }));
  return { f, media, admin: { graphql } };
}
const snapshotOf = (p: ReturnType<typeof product>) => ({ product: {}, variants: p.f.variants, media: p.media });
/** The manager draft for the fixture product with no samples bound yet. */
const bareDraft = () => { const d = draftFromMapping(providerFixture().mapping, shopId, productId); d.fabrics.forEach((f) => f.colours.forEach((c) => { c.swatchMediaId = null; })); return d; };
const legacyWithSwatch = (swatch: string) => { const f = providerFixture(); f.mapping.entries[0]!.swatchMediaId = swatch; return f.mapping; };

beforeEach(() => { state.rows = []; state.upserts = []; vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED", "true"); });

describe("Visully sample marker migration", () => {
  it("recognises old Tryora samples and newly uploaded Visully samples without reclassifying product photos", () => {
    expect(SAMPLE_ALT_PREFIX).toBe("Visully fabric sample ");
    expect(isSampleMedia({ alt: "Tryora fabric sample 123" })).toBe(true);
    expect(isSampleMedia({ alt: "Visully fabric sample 456" })).toBe(true);
    expect(isSampleMedia({ alt: "Product bed in beige bedroom" })).toBe(false);
  });
});

describe("product photos never become fabric or colour swatches", () => {
  it("offers no sample at all when the product has five furniture photos and no uploaded samples", () => {
    const { media } = product();
    expect(sampleChoices(media)).toEqual([]);
    expect(referenceChoices(media, new Set()).map((m) => m.id)).toEqual([101, 102, 103, 104, 105].map(gid));
  });

  it("shows a labelled placeholder, not the furniture photo, when a legacy mapping bound a product photo as a sample", async () => {
    const p = product();
    const data = await manualStorefrontData({ admin: p.admin as any, config: { ...p.f.context.config, choices: [] } as any,
      setting: { ...p.f.context.setting, mapping: legacyWithSwatch(gid(105)) } });
    expect(data.swatches.map((s) => s.image)).toEqual(data.swatches.map(() => null));
    expect(JSON.stringify(data)).not.toContain("furniture-105.jpg");
  });

  it("shows only real uploaded textures and samples in a saved manager configuration, each with its own identity", async () => {
    const p = product([sample(301), sample(302), sample(303)]);
    const draft = bareDraft();
    draft.fabrics[0]!.textureMediaId = gid(301);
    draft.fabrics[0]!.colours.find((c) => c.name === "Cream")!.swatchMediaId = gid(302);
    // Same colour name under another fabric keeps its own sample.
    draft.fabrics.push({ id: "boucle", name: "Boucle", description: "", enabled: true, textureMediaId: null, colours: [{ id: "boucle-cream", name: "Cream", enabled: true, swatchMediaId: gid(303), hex: null }] });
    const { document } = compileFabricDocument(draft, shopId, productId, snapshotOf(p) as any);
    const data = await manualStorefrontData({ admin: p.admin as any, config: { ...p.f.context.config, choices: [] } as any, setting: { ...p.f.context.setting, mapping: document } });
    expect(data.fabricImages).toEqual({ Velvet: "https://cdn.shopify.com/sample-301.jpg" });
    const cream = (group: string) => data.swatches.find((s) => s.group === group && s.label === "Cream")!.image;
    expect(cream("Velvet")).toBe("https://cdn.shopify.com/sample-302.jpg");
    expect(cream("Boucle")).toBe("https://cdn.shopify.com/sample-303.jpg");
    // A missing Boucle texture stays a labelled placeholder rather than borrowing any image.
    expect(data.fabricImages.Boucle).toBeUndefined();
    expect(data.swatches.find((s) => s.label === "Grey")!.image).toBeNull();
  });

  it("refuses to save a product photo as a fabric texture or colour sample", () => {
    const p = product();
    const draft = bareDraft();
    draft.fabrics[0]!.textureMediaId = gid(105);
    expect(() => compileFabricDocument(draft, shopId, productId, snapshotOf(p) as any)).toThrow(/product photo, not a fabric or colour sample/);
  });

  it("refuses an uploaded sample as the full furniture reference", () => {
    const p = product([sample(301)]);
    const draft = bareDraft();
    draft.bindings[0]!.referenceMediaIds = [gid(301)];
    expect(() => compileFabricDocument(draft, shopId, productId, snapshotOf(p) as any)).toThrow(/sample cannot be a full furniture reference/);
  });

  it("loads a legacy product-photo sample as missing, and says which colour needs a real sample", async () => {
    const p = product();
    state.admin = { graphql: async (query: string, init: any) => query.includes("TryoraFabricProducts")
      ? Response.json({ data: { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }) : p.admin.graphql(query, init) };
    vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_SHOPS", shopId);
    state.rows = [{ shopId, productId, providerId: "manual_mapping", revision: "r1", active: true, mapping: legacyWithSwatch(gid(105)) }];
    const data: any = await loader({ request: new Request(`https://tryora.example/app/fabrics?product=${encodeURIComponent(productId)}`) } as any);
    const colours = data.selected.draft.fabrics.flatMap((f: any) => f.colours);
    expect(colours.every((c: any) => c.swatchMediaId === null)).toBe(true);
    expect(data.selected.sampleNotice).toContain("Velvet / Cream");
    expect(data.selected.warning).toBe("");
  });
});

describe("samples never become AI furniture references", () => {
  it("rejects a reviewed legacy mapping whose reference is an uploaded sample", async () => {
    const p = product([sample(301)]);
    const f = providerFixture(); f.mapping.entries[0]!.referenceMediaIds = [gid(301)]; delete f.mapping.entries[0]!.swatchMediaId;
    await expect(resolveConfiguredPreview({ admin: p.admin as any, config: { ...p.f.context.config, choices: [] } as any, sourceVariantId: f.mapping.entries[0]!.variantId,
      setting: { ...p.f.context.setting, mapping: f.mapping } }, "cream", f.mapping.entries[0]!.variantId, "revision-1")).rejects.toMatchObject({ issue: "missing_reference" });
  });

  it("does not generate from a sample approved as a native product reference", async () => {
    const media = [sample(301)];
    const admin = { graphql: async (query: string) => Response.json({ data: { product: query.includes("TryoraPreviewMedia")
      ? { media: { nodes: media, pageInfo: { hasNextPage: false } } }
      : { id: productId, title: "Chair", productType: "Chair", description: "", options: [{ name: "Title", optionValues: [{ name: "Default Title" }] }],
        variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", availableForSale: true, image: null, selectedOptions: [{ name: "Title", value: "Default Title" }] }], pageInfo: { hasNextPage: false } } } } }) };
    const config: any = { shopId, productId, enabled: true, readiness: "ready", visualOptionName: null, frozenContext: {}, choices: [], referenceMediaId: gid(301) };
    await expect(resolvePreviewProduct(admin, config, "__single__")).rejects.toMatchObject({ issue: "missing_reference" });
  });

  it("never picks an uploaded sample as an automatic product reference", async () => {
    const admin = { graphql: async () => Response.json({ data: { product: { id: productId, title: "Aurora Bed", productType: "Bed", status: "ACTIVE", options: [],
      media: { nodes: [sample(301), photo(101)] } } } }) };
    await ensureAutoProductConfig(admin as any, shopId, productId);
    expect(state.upserts[0].create.referenceMediaId).toBe(gid(101));
  });
});
