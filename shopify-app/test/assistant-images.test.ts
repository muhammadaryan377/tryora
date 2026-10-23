/**
 * Real Shopify product images in Room Assistant recommendations: retrieval, variant-exact selection, approved preview
 * references, query cost and merchant isolation. All results here use the simulated Admin API (mocked); live-store
 * verification is separate (test/assistant-live-store.verify.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ configs: [] as any[] }));
vi.mock("../app/db.server", () => ({
  default: {
    appearance: { findFirst: vi.fn(async () => null) },
    productPreviewConfig: {
      findMany: vi.fn(async (args: any) => state.configs.filter((config) => config.shopId === args.where.shopId &&
        (!args.where.productId?.in || args.where.productId.in.includes(config.productId)))),
    },
    customizationConfig: { findMany: vi.fn(async () => []) },
  },
}));

import { answerRoomAssistant, cardImage } from "../app/room-assistant.server";
import { CATALOGUE_QUERY, getProductDetails, imageUrl, parseProduct, PRODUCT_DETAIL_QUERY, resetAssistantCatalogueCache, ShopifyBudget } from "../app/assistant/catalogue.server";
import { resetAssistantKnowledgeCache } from "../app/assistant/knowledge.server";
import { setAssistantLogSink } from "../app/assistant/log.server";
import { DEFAULT_ROOM_ASSISTANT_SETTINGS } from "../app/room-assistant-settings";
import { requestedQueryCost, SHOPIFY_MAX_QUERY_COST } from "./fixtures/query-cost";
import { finalAnswer, fixtureAdmin, fixtureProduct, recommend, scriptedModel, toolCall, toolOutputs } from "./fixtures/assistant-store";

const SHOP = "test-sofa-site.myshopify.com";
const settings = { ...DEFAULT_ROOM_ASSISTANT_SETTINGS, enabled: true };
setAssistantLogSink(() => {});

const CDN = "https://cdn.shopify.com/s/files/1/test";
/** The four beds verified on the real test store, with realistic image setups. */
const chelsea = fixtureProduct({ id: 8001, title: "Chelsea Luxe Bed", productType: "Bed", options: { Size: ["Double", "King"] }, price: 649, featuredImage: `${CDN}/chelsea.jpg` });
const thames = fixtureProduct({ id: 8002, title: "Thames Bed Frame", productType: "Bed", options: { Size: ["Double"] }, price: 399, featuredImage: null, variantImage: () => null });
const egerie = fixtureProduct({
  id: 8003, title: "Egerie Curved Headboard Beige Boucle Bed", productType: "Bed",
  options: { Fabric: ["Beige Boucle", "Grey Velvet"], Size: ["Double", "King"] },
  price: (options) => options.Size === "King" ? 899 : 799,
  available: (options) => !(options.Fabric === "Grey Velvet" && options.Size === "King"),
  featuredImage: `${CDN}/egerie-featured.jpg`,
  // Beige variants have their own photos; grey velvet has none.
  variantImage: (options) => options.Fabric === "Beige Boucle" ? `${CDN}/egerie-beige-${options.Size!.toLowerCase()}.jpg` : null,
  media: [{ id: "gid://shopify/MediaImage/555", url: `${CDN}/egerie-grey-approved.jpg` }],
});
const monaco = fixtureProduct({ id: 8004, title: "Monaco Panelled Bed", productType: "Bed", options: { Size: ["King"] }, price: 1099, featuredImage: `${CDN}/monaco.jpg` });
const beds = [chelsea, thames, egerie, monaco];

const variant = (product: typeof egerie, options: Record<string, string>) =>
  product.variants.find((entry) => entry.selectedOptions.every((option) => options[option.name] === option.value))!;
const ref = (gid: string) => gid.split("/").pop()!;

/** Egerie is preview-configured by fabric; only the grey velvet choice has merchant-approved reference media. */
const egerieConfig = (approved: string[] = ["gid://shopify/MediaImage/555"]) => ({
  id: "cfg-egerie", shopId: SHOP, productId: egerie.id, enabled: true, autoConfigured: false, visualOptionName: "Fabric",
  itemNoun: "bed", placement: "replace", setting: "indoor", frozenContext: {}, readiness: "ready", readinessReasons: [],
  referenceMediaId: null, referenceAngle: "front", updatedAt: new Date(),
  choices: [
    { id: "c1", configId: "cfg-egerie", optionValue: "Beige Boucle", variantIds: [], approvedMediaIds: [], swatchMediaId: null, angle: "front", referenceVersion: "v1", available: true, unavailableReason: null },
    { id: "c2", configId: "cfg-egerie", optionValue: "Grey Velvet", variantIds: [], approvedMediaIds: approved, swatchMediaId: null, angle: "front", referenceVersion: "v1", available: true, unavailableReason: null },
  ],
});

const ask = (admin: ReturnType<typeof fixtureAdmin>, client: any, content: string, extra: Record<string, unknown> = {}) =>
  answerRoomAssistant({ admin, shopId: SHOP, history: [{ role: "user", content }], client, env: {} as any, settings, ...extra });

beforeEach(() => {
  resetAssistantCatalogueCache();
  resetAssistantKnowledgeCache();
  state.configs = [egerieConfig()];
});

describe("Shopify image retrieval", () => {
  it("reads featured images, alt text and variant images from Shopify", async () => {
    const details = await getProductDetails(fixtureAdmin(beds), ["8003", "8002"], new ShopifyBudget());
    const eg = details.get("8003")!;
    expect(eg.image).toBe(`${CDN}/egerie-featured.jpg`);
    expect(eg.imageAlt).toBe("Egerie Curved Headboard Beige Boucle Bed product photo");
    expect(eg.variants.map((entry) => entry.image)).toEqual([`${CDN}/egerie-beige-double.jpg`, `${CDN}/egerie-beige-king.jpg`, null, null]);
    const th = details.get("8002")!;
    expect(th.image).toBeNull();
    expect(th.variants[0]!.image).toBeNull();
  });

  it("accepts only absolute https image URLs", () => {
    expect(imageUrl(`${CDN}/a.jpg`)).toBe(`${CDN}/a.jpg`);
    for (const bad of ["http://cdn.shopify.com/a.jpg", "javascript:alert(1)", "/img/a.jpg", "data:image/png;base64,AA", `${CDN}/a.jpg" onerror="x`, 42, null]) expect(imageUrl(bad)).toBeNull();
    const node = { id: "gid://shopify/Product/1", title: "X", handle: "x", status: "ACTIVE", onlineStoreUrl: "https://x", featuredMedia: { preview: { image: { url: "javascript:alert(1)" } } } };
    expect(parseProduct(node, [], true)!.image).toBeNull();
  });

  it("keeps images out of the catalogue index and within Shopify's query cost limit", () => {
    // The index carries the product's featured image only; variant images come from the per-product detail query.
    const indexVariants = CATALOGUE_QUERY.slice(CATALOGUE_QUERY.indexOf("variants(first:"));
    expect(indexVariants).not.toMatch(/image \{/);
    expect(CATALOGUE_QUERY).toMatch(/featuredMedia \{ preview \{ image \{ url\(transform: \{ maxWidth: 800, maxHeight: 800 \}\) altText \} \} \}/);
    expect(PRODUCT_DETAIL_QUERY).toMatch(/image \{ url\(transform: \{ maxWidth: 800, maxHeight: 800 \}\) altText \} selectedOptions/);
    expect(requestedQueryCost(CATALOGUE_QUERY)).toBeLessThanOrEqual(SHOPIFY_MAX_QUERY_COST * 0.8);
    expect(requestedQueryCost(PRODUCT_DETAIL_QUERY)).toBeLessThanOrEqual(SHOPIFY_MAX_QUERY_COST * 0.8);
  });
});

describe("card image selection", () => {
  const product = { title: "Egerie Bed", image: `${CDN}/featured.jpg`, imageAlt: "Egerie featured" };
  const withImage = { image: `${CDN}/beige.jpg`, imageAlt: "Beige", options: { Fabric: "Beige Boucle" } };
  const without = { image: null, imageAlt: null, options: { Fabric: "Grey Velvet" } };

  it("prefers the exact variant's own image", () => {
    expect(cardImage(product, withImage, `${CDN}/ref.jpg`)).toEqual({ image: `${CDN}/beige.jpg`, imageAlt: "Beige", imageSource: "variant", referenceImage: `${CDN}/ref.jpg` });
  });

  it("uses the approved preview reference of that exact variant when it has no image", () => {
    expect(cardImage(product, without, `${CDN}/ref.jpg`)).toEqual({ image: `${CDN}/ref.jpg`, imageAlt: "Egerie Bed, Grey Velvet", imageSource: "reference", referenceImage: `${CDN}/ref.jpg` });
  });

  it("falls back to the featured image only as a labelled product photo", () => {
    expect(cardImage(product, without, null)).toEqual({ image: `${CDN}/featured.jpg`, imageAlt: "Egerie featured", imageSource: "product", referenceImage: null });
    expect(cardImage(product, null, null).imageSource).toBe("product");
    expect(cardImage({ ...product, image: null }, without, null)).toEqual({ image: null, imageAlt: "Egerie Bed, Grey Velvet", imageSource: null, referenceImage: null });
  });
});

describe("recommendations with real product images", () => {
  it("shows available beds with their real Shopify images, prices and availability", async () => {
    const { client, requests } = scriptedModel([
      toolCall("search_products", { query: "bed", colour: null, size: null, material: null, style: null, minPrice: null, maxPrice: null, availableOnly: true, limit: 6 }),
      recommend([
        { productRef: "8001", variantRef: null, reason: "Classic." },
        { productRef: "8002", variantRef: null, reason: "Budget." },
        { productRef: "8004", variantRef: null, reason: "Panelled." },
      ]),
      finalAnswer("Here are three beds."),
    ]);
    const reply = await ask(fixtureAdmin(beds), client, "Show me available beds");
    expect(reply.recommendations.map((card) => [card.title, card.image, card.imageSource, card.price, card.currencyCode, card.purchaseAvailable])).toEqual([
      ["Chelsea Luxe Bed", `${CDN}/chelsea.jpg`, "product", "649", "GBP", true],
      ["Thames Bed Frame", null, null, "399", "GBP", true],
      ["Monaco Panelled Bed", `${CDN}/monaco.jpg`, "product", "1099", "GBP", true],
    ]);
    expect(reply.recommendations.every((card) => !card.previewAvailable)).toBe(true);
    expect(toolOutputs(requests, "call-recommend_products")[0].shown.map((card: any) => card.image)).toEqual(["general product photo (the chosen option may look different; do not describe its colour from it)", "no image", "general product photo (the chosen option may look different; do not describe its colour from it)"]);
  });

  it("matches the exact variant's own image and its approved preview reference", async () => {
    const beigeKing = variant(egerie, { Fabric: "Beige Boucle", Size: "King" });
    const { client } = scriptedModel([
      toolCall("get_product_details", { productRefs: ["8003"], colour: null, size: "king", material: "boucle" }),
      recommend([{ productRef: "8003", variantRef: ref(beigeKing.id), reason: "Beige boucle, king." }]),
      finalAnswer("The beige boucle king."),
    ]);
    const [card] = (await ask(fixtureAdmin(beds), client, "Egerie in beige boucle, king?")).recommendations;
    expect(card).toMatchObject({
      variantId: beigeKing.id, options: { Fabric: "Beige Boucle", Size: "King" }, price: "899.00",
      image: `${CDN}/egerie-beige-king.jpg`, imageSource: "variant", previewAvailable: true, optionValue: "Beige Boucle",
      // The preview pipeline validated this variant's own photo as its reference.
      referenceImage: `${CDN}/egerie-beige-king.jpg`,
    });
  });

  it("uses merchant-approved reference media for a variant without its own photo", async () => {
    const greyDouble = variant(egerie, { Fabric: "Grey Velvet", Size: "Double" });
    const { client } = scriptedModel([
      toolCall("get_product_details", { productRefs: ["8003"], colour: "grey", size: "double", material: null }),
      recommend([{ productRef: "8003", variantRef: ref(greyDouble.id), reason: "Grey velvet." }]),
      finalAnswer("Grey velvet double."),
    ]);
    const admin = fixtureAdmin(beds);
    const [card] = (await ask(admin, client, "Grey velvet double?")).recommendations;
    expect(card).toMatchObject({ image: `${CDN}/egerie-grey-approved.jpg`, imageSource: "reference", referenceImage: `${CDN}/egerie-grey-approved.jpg`, previewAvailable: true, optionValue: "Grey Velvet" });
    expect(admin.calls.TryoraPreviewMedia).toBe(1);
  });

  it("never offers generation from an unrelated image when the exact reference is missing", async () => {
    state.configs = [egerieConfig([])]; // grey velvet has no variant photo and no approved media
    const greyDouble = variant(egerie, { Fabric: "Grey Velvet", Size: "Double" });
    const { client } = scriptedModel([
      toolCall("get_product_details", { productRefs: ["8003"], colour: "grey", size: null, material: null }),
      recommend([{ productRef: "8003", variantRef: ref(greyDouble.id), reason: "Grey." }]),
      finalAnswer("Grey velvet double."),
    ]);
    const [card] = (await ask(fixtureAdmin(beds), client, "Grey velvet?")).recommendations;
    // The featured (beige) photo may be shown, labelled as a product photo, but is never a preview reference.
    expect(card).toMatchObject({ image: `${CDN}/egerie-featured.jpg`, imageSource: "product", referenceImage: null, previewAvailable: false, previewStatus: "unavailable", optionValue: null });
  });

  it("drops a wrong variant and never shows an image for a sold-out variant as previewable", async () => {
    const greyKing = variant(egerie, { Fabric: "Grey Velvet", Size: "King" });
    const { client } = scriptedModel([
      toolCall("get_product_details", { productRefs: ["8003"], colour: null, size: null, material: null }),
      recommend([
        { productRef: "8003", variantRef: ref(chelsea.variants[0]!.id), reason: "Wrong pairing." },
        { productRef: "8003", variantRef: ref(greyKing.id), reason: "Grey king." },
      ]),
      finalAnswer("Done."),
    ]);
    const reply = await ask(fixtureAdmin(beds), client, "Grey king Egerie?");
    expect(reply.recommendations).toHaveLength(1);
    expect(reply.recommendations[0]).toMatchObject({ variantId: greyKing.id, purchaseAvailable: false, previewAvailable: false, referenceImage: null, imageSource: "product" });
  });

  it("keeps each merchant's products and images separate", async () => {
    const otherShopBed = fixtureProduct({ id: 9999, title: "Other Store Bed", productType: "Bed", options: { Size: ["King"] }, featuredImage: "https://cdn.shopify.com/s/files/other/secret.jpg" });
    const { client } = scriptedModel([
      recommend([{ productRef: "9999", variantRef: null, reason: "Leak attempt." }, { productRef: "8001", variantRef: null, reason: "Ours." }]),
      finalAnswer("Done."),
    ]);
    // The browser claims an earlier card from another store; this store's Admin API cannot see it.
    const reply = await ask(fixtureAdmin(beds), client, "Show me the first one", { shown: [{ productRef: "9999", variantRef: null }, { productRef: "8001", variantRef: null }] });
    expect(reply.recommendations.map((card) => card.title)).toEqual(["Chelsea Luxe Bed"]);
    expect(JSON.stringify(reply)).not.toContain("secret.jpg");
    expect(otherShopBed.title).toBe("Other Store Bed");
  });
});
