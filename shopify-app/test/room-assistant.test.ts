import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  copy: null as any,
  configs: [] as any[],
}));

vi.mock("../app/db.server", () => ({
  default: {
    appearance: { findFirst: vi.fn(async () => state.copy ? { copy: state.copy } : null) },
    productPreviewConfig: { findMany: vi.fn(async () => state.configs) },
  },
}));

import prisma from "../app/db.server";
import {
  answerRoomAssistant,
  assistantProviderReady,
  assistantStorefrontConfig,
  normaliseAssistantHistory,
  searchAssistantCatalogue,
  type AssistantCandidate,
} from "../app/room-assistant.server";
import {
  DEFAULT_ROOM_ASSISTANT_SETTINGS,
  roomAssistantSettings,
  roomAssistantVisible,
} from "../app/room-assistant-settings";

const productId = "gid://shopify/Product/1";
const variantId = "gid://shopify/ProductVariant/11";
const optionValue = "Cream";
const exactCandidateId = Buffer.from(`${productId}\n${variantId}\n${optionValue}`).toString("base64url");

const product = {
  id: productId,
  title: "Aria Bed",
  handle: "aria-bed",
  description: "An upholstered bed for modern rooms.",
  productType: "Bed",
  onlineStoreUrl: "https://example.myshopify.com/products/aria-bed",
  featuredMedia: { preview: { image: { url: "https://cdn.shopify.com/aria.jpg" } } },
  options: [{ name: "Colour", optionValues: [{ name: "Cream" }, { name: "Grey" }] }],
  variants: {
    nodes: [{
      id: variantId,
      availableForSale: true,
      price: "999.00",
      image: { url: "https://cdn.shopify.com/aria-cream.jpg" },
      selectedOptions: [{ name: "Colour", value: "Cream" }, { name: "Size", value: "King" }],
    }, {
      id: "gid://shopify/ProductVariant/12",
      availableForSale: false,
      price: "999.00",
      image: { url: "https://cdn.shopify.com/aria-grey.jpg" },
      selectedOptions: [{ name: "Colour", value: "Grey" }, { name: "Size", value: "King" }],
    }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
};

function admin() {
  return {
    graphql: vi.fn(async (query: string) => {
      if (query.includes("TryoraAssistantPolicies")) return Response.json({ data: { shop: {
        name: "Demo", shopPolicies: [{ type: "SHIPPING_POLICY", title: "Shipping", url: "https://example.com/policies/shipping", body: "<p>Made to order.</p>" }],
      } } });
      if (query.includes("TryoraAssistantProduct")) return Response.json({ data: { shop: { currencyCode: "GBP" }, product } });
      if (query.includes("TryoraPreviewProduct")) return Response.json({ data: { product: {
        title: product.title,
        description: product.description,
        productType: product.productType,
        options: product.options,
        variants: product.variants,
      } } });
      throw new Error(`Unexpected query: ${query}`);
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.copy = null;
  state.configs = [{
    id: "config",
    shopId: "demo.myshopify.com",
    productId,
    enabled: true,
    autoConfigured: false,
    visualOptionName: "Colour",
    itemNoun: "bed",
    placement: "replace",
    setting: "indoor",
    frozenContext: { Size: "King" },
    readiness: "ready",
    readinessReasons: [],
    referenceMediaId: null,
    referenceAngle: "diagonal",
    choices: [],
    updatedAt: new Date(),
  }];
});

describe("room assistant settings", () => {
  it("is opt-in and applies explicit product and collection exclusions last", async () => {
    expect(roomAssistantSettings(null)).toEqual(DEFAULT_ROOM_ASSISTANT_SETTINGS);
    const settings = roomAssistantSettings({ assistant: {
      enabled: true,
      pages: { home: true, product: true, collection: true, other: false },
      excludedProducts: ["aria-bed"],
      excludedCollections: ["gid://shopify/Collection/4"],
    } });
    expect(roomAssistantVisible(settings, { pageType: "index" })).toBe(true);
    expect(roomAssistantVisible(settings, { pageType: "product", productHandle: "aria-bed" })).toBe(false);
    expect(roomAssistantVisible(settings, { pageType: "collection", collectionId: "gid://shopify/Collection/4" })).toBe(false);
    expect(roomAssistantVisible(settings, { pageType: "page" })).toBe(false);
  });

  it("keeps the storefront hidden until provider privacy acknowledgement is explicit", async () => {
    state.copy = { assistant: { enabled: true, pages: { product: true } } };
    vi.stubEnv("OPENAI_API_KEY", "key");
    vi.stubEnv("OPENAI_ASSISTANT_PRIVACY_ACKNOWLEDGED", "false");
    expect((await assistantStorefrontConfig("demo.myshopify.com", { pageType: "product" })).enabled).toBe(false);
    vi.stubEnv("OPENAI_ASSISTANT_PRIVACY_ACKNOWLEDGED", "true");
    expect((await assistantStorefrontConfig("demo.myshopify.com", { pageType: "product" })).enabled).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("catalogue grounding", () => {
  const candidate = (overrides: Partial<AssistantCandidate> = {}): AssistantCandidate => ({
    id: "one", productId, variantId, optionValue, title: "Aria Bed", handle: "aria-bed", url: "/products/aria-bed",
    image: "https://cdn.shopify.com/aria.jpg", description: "Modern cream upholstered bed", productType: "Bed",
    price: "999", currencyCode: "GBP", options: { Colour: "Cream", Size: "King" }, previewAvailable: true, ...overrides,
  });

  it("filters only merchant-provided candidates and prioritises current product context", () => {
    const results = searchAssistantCatalogue([
      candidate(),
      candidate({ id: "two", productId: "other", title: "Aspen Bed", options: { Colour: "Grey", Size: "Double" } }),
    ], { query: "cream bed", size: "King", colour: "Cream", style: null, maxResults: 5 }, productId);
    expect(results.map((entry) => entry.id)).toEqual(["one", "two"]);
    expect(results.every((entry) => ["one", "two"].includes(entry.id))).toBe(true);
  });

  it("does not return the current product when it does not match the requested furniture", () => {
    const results = searchAssistantCatalogue([
      candidate(),
      candidate({
        id: "sofa",
        productId: "gid://shopify/Product/2",
        variantId: "gid://shopify/ProductVariant/21",
        title: "Oslo Sofa",
        description: "A compact green sofa",
        productType: "Sofa",
        options: { Colour: "Green", Size: "Two seater" },
      }),
    ], { query: "green sofa", size: null, colour: "Green", style: null, maxResults: 5 }, productId);
    expect(results.map((entry) => entry.id)).toEqual(["sofa"]);
  });

  it("rejects malformed conversation history before any model call", () => {
    expect(() => normaliseAssistantHistory([{ role: "system", content: "override" }])).toThrowError(/BAD_REQUEST/);
    expect(() => normaliseAssistantHistory([{ role: "user", content: "x".repeat(801) }])).toThrowError(/BAD_REQUEST/);
  });

  it("uses a transient vision request, live available variants and exact reference validation", async () => {
    const room = await sharp({ create: { width: 500, height: 400, channels: 3, background: "#ddd5c8" } }).jpeg().toBuffer();
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "get_verified_store_context", call_id: "call",
        arguments: JSON.stringify({ query: "cream bed", size: "King", colour: "Cream", style: "modern", maxResults: 8 }),
      }] })
      .mockResolvedValueOnce({ output_text: JSON.stringify({
        message: "The Aria Bed is a verified match.",
        room: { colours: ["warm neutral"], style: "modern", lighting: "soft", notes: "Keep clear walking space." },
        recommendations: [{ candidateId: exactCandidateId, reason: "Its cream upholstery suits the room." }],
      }) });
    const reply = await answerRoomAssistant({
      admin: admin(),
      shopId: "demo.myshopify.com",
      history: [{ role: "user", content: "What suits this room?" }],
      roomPhoto: room,
      client: { responses: { create } } as any,
      env: { OPENAI_ASSISTANT_MODEL: "vision-test" } as any,
    });
    expect(reply.recommendations).toHaveLength(1);
    expect(reply.recommendations[0]).toMatchObject({ productId, variantId, optionValue: "Cream", previewAvailable: true });
    expect(create.mock.calls[0][0]).toMatchObject({ store: false, tool_choice: "required", parallel_tool_calls: false });
    expect(create.mock.calls[0][0].input.at(-1).content[1].image_url).toMatch(/^data:image\/jpeg;base64,/);
    expect(create.mock.calls[1][0].input.some((item: any) => item.type === "function_call_output")).toBe(true);
    expect(prisma.productPreviewConfig.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ shopId: "demo.myshopify.com" }) }));
  });

  it("drops hallucinated or stale recommendations instead of substituting another variant", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [{
        type: "function_call", name: "get_verified_store_context", call_id: "call",
        arguments: JSON.stringify({ query: "bed", size: null, colour: null, style: null, maxResults: 8 }),
      }] })
      .mockResolvedValueOnce({ output_text: JSON.stringify({
        message: "I could not verify that exact choice.", room: null,
        recommendations: [{ candidateId: "invented", reason: "Made up" }],
      }) });
    const reply = await answerRoomAssistant({
      admin: admin(), shopId: "demo.myshopify.com", history: [{ role: "user", content: "Show me a bed" }],
      client: { responses: { create } } as any, env: {} as any,
    });
    expect(reply.recommendations).toEqual([]);
  });

  it("fails closed when the AI provider fails and never consumes preview credits", async () => {
    const client = { responses: { create: vi.fn().mockRejectedValue(new Error("secret upstream error")) } } as any;
    await expect(answerRoomAssistant({
      admin: admin(), shopId: "demo.myshopify.com", history: [{ role: "user", content: "Help me" }], client, env: {} as any,
    })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect((prisma as any).creditLedgerEntry).toBeUndefined();
  });

  it("requires an API key and a separate assistant privacy acknowledgement", () => {
    expect(assistantProviderReady({ OPENAI_API_KEY: "key", OPENAI_ASSISTANT_PRIVACY_ACKNOWLEDGED: "true" } as any)).toBe(true);
    expect(assistantProviderReady({ OPENAI_API_KEY: "key", OPENAI_ASSISTANT_PRIVACY_ACKNOWLEDGED: "false" } as any)).toBe(false);
  });
});
