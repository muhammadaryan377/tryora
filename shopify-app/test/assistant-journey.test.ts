/**
 * Customer-journey fixes: single-variant products, preview eligibility aligned with the product page, product
 * selection memory, option selection data and bounded conversation context. Simulated Admin API and model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ configs: [] as any[], autoConfigs: new Map<string, any>(), created: [] as any[], storefront: new Map<string, any>() }));
vi.mock("../app/db.server", () => ({
  default: {
    appearance: { findFirst: vi.fn(async () => null) },
    productPreviewConfig: {
      findMany: vi.fn(async (args: any) => [...state.configs, ...state.created].filter((config) => config.shopId === args.where.shopId &&
        (!args.where.productId?.in || args.where.productId.in.includes(config.productId)))),
    },
    customizationConfig: { findMany: vi.fn(async () => []) },
  },
}));
// The product page's auto-configuration and storefront model are exercised by their own suites; here they are
// observed to prove the assistant uses them, with the results the product page would get.
vi.mock("../app/auto-products.server", () => ({
  ensureAutoProductConfig: vi.fn(async (_admin: unknown, shopId: string, productId: string) => {
    // Like the real function: only now does the configuration exist in the database.
    const config = state.autoConfigs.get(productId);
    if (!config || config.shopId !== shopId) return null;
    if (!state.created.includes(config)) state.created.push(config);
    return config;
  }),
}));
vi.mock("../app/storefront.server", () => ({
  storefrontConfig: vi.fn(async (_admin: unknown, _shopId: string, productId: string) => state.storefront.get(productId) ?? { enabled: false }),
}));

import { answerRoomAssistant } from "../app/room-assistant.server";
import { ensureAutoProductConfig } from "../app/auto-products.server";
import { optionModel, productOptionsForAssistant } from "../app/assistant/options.server";
import { resetAssistantCatalogueCache } from "../app/assistant/catalogue.server";
import { resetAssistantKnowledgeCache } from "../app/assistant/knowledge.server";
import { setAssistantLogSink } from "../app/assistant/log.server";
import { DEFAULT_ROOM_ASSISTANT_SETTINGS } from "../app/room-assistant-settings";
import { finalAnswer, fixtureAdmin, fixtureProduct, recommend, scriptedModel, toolCall, toolOutputs } from "./fixtures/assistant-store";

const SHOP = "test-sofa-site.myshopify.com";
const settings = { ...DEFAULT_ROOM_ASSISTANT_SETTINGS, enabled: true };
setAssistantLogSink(() => {});

/** Shopify's shape for a product with no options: one "Title: Default Title" variant. */
const thames = fixtureProduct({ id: 8202, title: "Thames Bed Frame", productType: "Bed", options: { Title: ["Default Title"] }, price: 399 });
const egerie = fixtureProduct({
  id: 8203, title: "Egerie Curved Headboard Beige Boucle Bed", productType: "Bed",
  options: { Fabric: ["Boucle", "Velvet"], Colour: ["Beige", "Grey"], Size: ["Double", "King"] },
  price: (options) => options.Size === "King" ? 899 : 799,
  available: (options) => !(options.Fabric === "Velvet" && options.Colour === "Beige"),
});
const chelsea = fixtureProduct({ id: 8201, title: "Chelsea Luxe Bed", productType: "Bed", options: { Title: ["Default Title"] }, price: 649 });
const ref = (gid: string) => gid.split("/").pop()!;
const readyConfig = (productId: string, extra: Record<string, unknown> = {}) => ({
  id: `cfg-${productId}`, shopId: SHOP, productId, enabled: true, autoConfigured: true, visualOptionName: null, itemNoun: "bed",
  placement: "replace", setting: "indoor", frozenContext: {}, readiness: "ready", readinessReasons: [], referenceMediaId: null,
  referenceAngle: "front", choices: [], updatedAt: new Date(), ...extra,
});

const ask = (admin: ReturnType<typeof fixtureAdmin>, client: any, history: { role: "user" | "assistant"; content: string }[], extra: Record<string, unknown> = {}) =>
  answerRoomAssistant({ admin, shopId: SHOP, history, client, env: {} as any, settings, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  resetAssistantCatalogueCache();
  resetAssistantKnowledgeCache();
  state.configs = [];
  state.autoConfigs.clear();
  state.created = [];
  state.storefront.clear();
});

describe("single-variant (Default Title) products", () => {
  it("never shows the artificial option to the model, and marks the product single-variant", async () => {
    const { client, requests } = scriptedModel([
      toolCall("search_products", { query: "bed", colour: null, size: null, material: null, style: null, minPrice: null, maxPrice: null, availableOnly: false, limit: 5 }),
      finalAnswer("Two beds."),
    ]);
    await ask(fixtureAdmin([thames, chelsea]), client, [{ role: "user", content: "beds?" }]);
    const [found] = toolOutputs(requests, "call-search_products");
    for (const result of found.results) {
      expect(result.options).toEqual({});
      expect(result.singleVariant).toBe(true);
      for (const variant of result.matchingVariants) expect(variant.options).toEqual({});
    }
    expect(JSON.stringify(requests)).not.toContain("Default Title");
  });

  it("resolves the only variant automatically and verifies preview eligibility on the server", async () => {
    state.configs = [readyConfig(thames.id)];
    const { client, requests } = scriptedModel([
      toolCall("search_products", { query: "thames", colour: null, size: null, material: null, style: null, minPrice: null, maxPrice: null, availableOnly: false, limit: 5 }),
      recommend([{ productRef: ref(thames.id), variantRef: null, reason: "Simple frame." }]),
      finalAnswer("Option 1."),
    ]);
    const [card] = (await ask(fixtureAdmin([thames]), client, [{ role: "user", content: "Thames?" }])).recommendations;
    expect(card).toMatchObject({
      variantRef: ref(thames.variants[0]!.id), variantId: thames.variants[0]!.id, options: {}, hasOptions: false, variantCount: 1,
      previewAvailable: true, previewStatus: "available", previewReason: null, optionValue: "__single__", price: "399.00",
    });
    expect(toolOutputs(requests, "call-recommend_products")[0].shown[0]).toMatchObject({ aiRoomPreview: "available", hasOptionsToChoose: false });
  });

  it("does not assume a single variant is previewable", async () => {
    const { client } = scriptedModel([
      toolCall("search_products", { query: "chelsea", colour: null, size: null, material: null, style: null, minPrice: null, maxPrice: null, availableOnly: false, limit: 5 }),
      recommend([{ productRef: ref(chelsea.id), variantRef: null, reason: "Luxe." }]),
      finalAnswer("Option 1."),
    ]);
    const [card] = (await ask(fixtureAdmin([chelsea]), client, [{ role: "user", content: "Chelsea?" }])).recommendations;
    expect(card).toMatchObject({ variantId: chelsea.variants[0]!.id, previewAvailable: false, previewStatus: "not_configured", previewReason: "AI room preview isn't offered for this product." });
  });
});

describe("preview eligibility matches the product page", () => {
  it("uses the product page's auto-configuration for recommended products", async () => {
    // No saved configuration yet; the merchant's auto-enable setting would configure it when its page is opened.
    state.autoConfigs.set(thames.id, readyConfig(thames.id));
    const { client } = scriptedModel([
      toolCall("search_products", { query: "thames", colour: null, size: null, material: null, style: null, minPrice: null, maxPrice: null, availableOnly: false, limit: 5 }),
      recommend([{ productRef: ref(thames.id), variantRef: null, reason: "Frame." }]),
      finalAnswer("Option 1."),
    ]);
    const [card] = (await ask(fixtureAdmin([thames]), client, [{ role: "user", content: "Thames?" }])).recommendations;
    expect(ensureAutoProductConfig).toHaveBeenCalledWith(expect.anything(), SHOP, thames.id);
    expect(card).toMatchObject({ previewAvailable: true, previewStatus: "available" });
  });

  it("marks ambiguous multi-variant products as not preview-ready without asking for options", async () => {
    state.configs = [readyConfig(egerie.id, { visualOptionName: "Colour" })];
    const { client } = scriptedModel([
      toolCall("search_products", { query: "egerie", colour: null, size: null, material: null, style: null, minPrice: null, maxPrice: null, availableOnly: false, limit: 5 }),
      recommend([{ productRef: ref(egerie.id), variantRef: null, reason: "Curved headboard." }]),
      finalAnswer("Option 1."),
    ]);
    const [card] = (await ask(fixtureAdmin([egerie]), client, [{ role: "user", content: "Egerie?" }])).recommendations;
    expect(card).toMatchObject({ variantRef: null, hasOptions: true, variantCount: 8, previewStatus: "choose_options", previewReason: "An exact approved product appearance could not be verified for room preview." });
  });
});

describe("conversation memory", () => {
  it("remembers the product the shopper likes and uses it for 'show it in my room'", async () => {
    state.configs = [readyConfig(thames.id)];
    const admin = fixtureAdmin([thames, chelsea]);
    const first = scriptedModel([toolCall("select_product", { productRef: ref(thames.id), variantRef: null }), finalAnswer("Good choice.")]);
    const liked = await ask(admin, first.client, [{ role: "user", content: "I like the second one" }], {
      shown: [{ productRef: ref(chelsea.id), variantRef: null }, { productRef: ref(thames.id), variantRef: null }],
    });
    expect(liked.selected).toMatchObject({ productRef: ref(thames.id), variantRef: ref(thames.variants[0]!.id) });
    expect(toolOutputs(first.requests, "call-select_product")[0]).toMatchObject({ selected: true, title: "Thames Bed Frame", aiRoomPreview: "available" });

    const second = scriptedModel([toolCall("request_visualisation", { productRef: ref(thames.id), variantRef: null }), finalAnswer("Confirm the card.")]);
    const offer = await ask(admin, second.client, [
      { role: "user", content: "I like the second one" }, { role: "assistant", content: "Good choice." }, { role: "user", content: "Show it in my room" },
    ], { selected: { productRef: liked.selected!.productRef, variantRef: liked.selected!.variantRef }, hasPhoto: true });
    expect(second.requests[0].input.find((item: any) => item.role === "developer").content).toContain(`selected most recently: productRef ${ref(thames.id)}`);
    expect(offer.visualise).toMatchObject({ productId: thames.id, previewAvailable: true, optionValue: "__single__" });
  });

  it("refuses a multi-option preview without requesting fabric or colour from the shopper", async () => {
    state.configs = [readyConfig(egerie.id, { visualOptionName: "Colour" })];
    const { client, requests } = scriptedModel([toolCall("request_visualisation", { productRef: ref(egerie.id), variantRef: null }), finalAnswer("Pick a fabric first.")]);
    const reply = await ask(fixtureAdmin([egerie]), client, [{ role: "user", content: "Show it in my room" }], { selected: { productRef: ref(egerie.id), variantRef: null } });
    expect(reply.visualise).toBeNull();
    expect(toolOutputs(requests, "call-request_visualisation")[0]).toMatchObject({ offered: false, reason: "An exact approved product appearance could not be verified for room preview." });
  });

  it("keeps shopper-stated room facts and earlier preferences in later turns", async () => {
    const admin = fixtureAdmin([thames]);
    const first = scriptedModel([
      toolCall("update_shopper_context", { budgetMin: null, budgetMax: null, colours: [], materials: [], sizes: [], furniture: [], roomDimensions: "", roomNotes: "grey walls, oak floor" }),
      finalAnswer("Noted."),
    ]);
    const noted = await ask(admin, first.client, [{ role: "user", content: "My room has grey walls and an oak floor" }]);
    expect(noted.preferences).toMatchObject({ roomNotes: "grey walls, oak floor" });
    const later = scriptedModel([finalAnswer("Something warm would suit grey walls.")]);
    await ask(admin, later.client, [{ role: "user", content: "Suggest something that matches" }], {
      preferences: noted.preferences, earlier: ["My room has grey walls and an oak floor", "I prefer boucle", "x".repeat(400)],
    });
    const developer = later.requests[0].input.find((item: any) => item.role === "developer").content;
    expect(developer).toContain("about their room: grey walls, oak floor");
    expect(developer).toContain('Earlier in this chat the shopper said (their words, not verified facts): "My room has grey walls and an oak floor"; "I prefer boucle"');
    expect(developer).not.toContain("x".repeat(161));
  });

  it("keeps long conversations bounded", async () => {
    const history = Array.from({ length: 80 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `${i % 2 ? "Answer" : "Question"} ${i} ${"words ".repeat(60)}` }));
    history.push({ role: "user", content: "And the second one?" });
    const { client, requests } = scriptedModel([finalAnswer("Sure.")]);
    await ask(fixtureAdmin([thames]), client, history, { earlier: Array.from({ length: 30 }, (_, i) => `old ${i} ${"y".repeat(300)}`) });
    const input = requests[0].input;
    expect(input.filter((item: any) => item.role === "user" || item.role === "assistant")).toHaveLength(12);
    expect(JSON.stringify(input).length).toBeLessThan(12_000);
  });
});

describe("product options for the card selector", () => {
  it("builds fabric family, colour and size choices from real variants, and hides Default Title", () => {
    const model = optionModel({
      options: [{ name: "Fabric", values: ["Boucle", "Velvet"] }, { name: "Colour", values: ["Beige", "Grey"], swatches: { Grey: { colour: "#8a8a8a", image: null } } }, { name: "Size", values: ["Double", "King"] }],
      variants: egerie.variants.map((variant) => ({ ...variant, ref: ref(variant.id), options: Object.fromEntries(variant.selectedOptions.map((option) => [option.name, option.value])), available: variant.availableForSale, compareAtPrice: null, image: null, imageAlt: null, title: "" })) as any,
    });
    expect(model.attributes.map((attribute) => [attribute.name, attribute.kind, attribute.values.map((value) => value.value)])).toEqual([
      ["Fabric", "fabric", ["Boucle", "Velvet"]], ["Colour", "colour", ["Beige", "Grey"]], ["Size", "size", ["Double", "King"]],
    ]);
    expect(model.attributes[1]!.values[1]).toEqual({ value: "Grey", colour: "#8a8a8a", image: null });
    expect(optionModel({ options: [{ name: "Title", values: ["Default Title"] }], variants: [{ options: { Title: "Default Title" } } as any] }).attributes).toEqual([]);
  });

  it("splits composite option values for display while keeping exact variant identity", () => {
    const values = [
      "Plush Velvet: Cream | Headboard: 50 inches | Storage: No Storage",
      "Plush Velvet: Grey | Headboard: 50 inches | Storage: Ottoman",
      "Boucle: Cream | Headboard: 54 inches | Storage: No Storage",
    ];
    const variants = values.map((value, index) => ({ id: `gid://shopify/ProductVariant/${index}`, ref: String(index), options: { Configuration: value, Size: "King" } }));
    const model = optionModel({ options: [{ name: "Configuration", values }, { name: "Size", values: ["King"] }], variants: variants as any });
    expect(model.attributes.map((attribute) => [attribute.name, attribute.kind, attribute.values.map((value) => value.value)])).toEqual([
      ["Fabric", "fabric", ["Plush Velvet", "Boucle"]], ["Colour", "colour", ["Cream", "Grey"]], ["Headboard", "headboard", ["50 inches", "54 inches"]], ["Storage", "storage", ["No Storage", "Ottoman"]],
    ]);
    expect(model.variants[1]!.values).toEqual({ Fabric: "Plush Velvet", Colour: "Grey", Headboard: "50 inches", Storage: "Ottoman", Size: "King" });
    // Values that do not share one exact shape are kept whole rather than guessed.
    const mixed = optionModel({ options: [{ name: "Configuration", values: ["Plush Velvet: Cream | Storage: None", "Custom order"] }], variants: [{ options: { Configuration: "Plush Velvet: Cream | Storage: None" } }, { options: { Configuration: "Custom order" } }] as any });
    expect(mixed.attributes).toEqual([{ name: "Configuration", kind: "other", values: [{ value: "Plush Velvet: Cream | Storage: None", colour: null, image: null }, { value: "Custom order", colour: null, image: null }] }]);
  });

  it("marks each variant previewable exactly as the product page's model does", async () => {
    const beigeBoucleKing = egerie.variants.find((variant) => variant.selectedOptions.map((option) => option.value).join("/") === "Boucle/Beige/King")!;
    state.storefront.set(egerie.id, {
      enabled: true, available: true, providerId: "shopify_native",
      lead: { mode: "required", timing: "before", showOptIn: true, optInWording: "Email me." },
      swatches: [{ value: "Beige", label: "Beige", group: null, colour: "#d8c6ae", image: null, available: true, variants: [{ id: beigeBoucleKing.id, image: null, options: {} }] }],
      singleVariants: [],
    });
    const options = await productOptionsForAssistant(fixtureAdmin([egerie]), SHOP, egerie.id);
    expect(options.preview).toEqual({ offered: true, reason: null });
    expect(options.variants.filter((variant) => variant.previewOption).map((variant) => variant.id)).toEqual([beigeBoucleKing.id]);
    expect(options.variants.find((variant) => variant.id === beigeBoucleKing.id)).toMatchObject({ previewOption: "Beige", price: "899.00", available: true });
    expect(options.attributes.find((attribute) => attribute.name === "Colour")!.values.find((value) => value.value === "Beige")).toMatchObject({ colour: "#d8c6ae" });
    expect(options.lead).toMatchObject({ mode: "required" });
  });

  it("never offers chat previews for Cloudlift or unconfigured products, and isolates merchants", async () => {
    state.storefront.set(egerie.id, { enabled: true, available: true, providerId: "cloudlift", lead: null, swatches: [], singleVariants: [] });
    const cloudlift = await productOptionsForAssistant(fixtureAdmin([egerie]), SHOP, egerie.id);
    expect(cloudlift.preview).toEqual({ offered: false, reason: "This configuration is not verified for an in-chat preview. Choose another verified appearance or product." });
    expect(cloudlift.variants.every((variant) => variant.previewOption === null)).toBe(true);
    const plain = await productOptionsForAssistant(fixtureAdmin([thames]), SHOP, thames.id);
    expect(plain).toMatchObject({ singleVariant: true, attributes: [], preview: { offered: false, reason: "AI room preview isn't offered for this product." } });
    // Another store's product is not visible through this store's Admin API.
    await expect(productOptionsForAssistant(fixtureAdmin([thames]), SHOP, egerie.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(productOptionsForAssistant(fixtureAdmin([thames]), SHOP, "../../admin")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
