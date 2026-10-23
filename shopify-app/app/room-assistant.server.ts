import OpenAI from "openai";
import type { ProductPreviewConfig, VisualChoice } from "@prisma/client";
import prisma from "./db.server";
import { TryoraError } from "./core/index";
import { matchesOptions, nativeSelections, type NativeVariant } from "./core/customization";
import type { AdminGraphql } from "./preview-product.server";
import { boundedOpenAIFetch } from "./openai-image-provider.server";
import { normaliseImage } from "./preview-images.server";
import { loadProviderSetting } from "./customization/provider-config.server";
import { providerAdapter, resolveConfiguredPreview } from "./customization/registry.server";
import {
  getCatalogue,
  getProductDetails,
  isRef,
  liveSearch,
  searchCatalogue,
  ShopifyBudget,
  variantsMatching,
  type CacheState,
  type CatalogueProduct,
  type CatalogueSnapshot,
  type CatalogueVariant,
  type ProductMatch,
  type ProductQuery,
} from "./assistant/catalogue.server";
import { loadStoreKnowledge, retrieveKnowledge } from "./assistant/knowledge.server";
import { errorShape, logAssistant } from "./assistant/log.server";
import {
  roomAssistantSettings,
  roomAssistantVisible,
  type AssistantPageContext,
  type RoomAssistantSettings,
} from "./room-assistant-settings";

const MAX_HISTORY = 12;
const MAX_MESSAGE_LENGTH = 800;
/** Tool rounds before the model must answer. One extra call may follow to force the final answer. */
export const MAX_TOOL_ROUNDS = 4;
const MAX_TOOL_CALLS = 8;
const MAX_SHOWN = 6;
const REQUEST_BUDGET_MS = 60_000;
const MODEL_CALL_TIMEOUT_MS = 30_000;
const CATALOGUE_WAIT_MS = 6_000;
const MAX_CONCURRENT_PER_SHOP = 8;
const MAX_MESSAGE_OUTPUT = 2_000;
const SINGLE = "__single__";

type ConfigWithChoices = ProductPreviewConfig & { choices: VisualChoice[] };

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
}

/** Broad, non-identifying observations of a shopper's room. The photo itself is never kept. */
export interface RoomObservations {
  colours: string[];
  style: string;
  lighting: string;
  notes: string;
  walls: string;
  floor: string;
  furniture: string[];
  layout: string;
  placement: string[];
}

/** Preferences the shopper has stated in this chat, kept in their browser session. */
export interface ShopperPreferences {
  budgetMin: number | null;
  budgetMax: number | null;
  colours: string[];
  materials: string[];
  sizes: string[];
  furniture: string[];
  roomDimensions: string;
}

export interface ShownRecommendation { productRef: string; variantRef: string | null }

export type PreviewStatus = "available" | "not_configured" | "unavailable" | "choose_options" | "product_page";

export interface AssistantRecommendation {
  id: string;
  productRef: string;
  variantRef: string | null;
  productId: string;
  variantId: string | null;
  title: string;
  url: string;
  image: string | null;
  price: string | null;
  maxPrice: string | null;
  currencyCode: string;
  options: Record<string, string>;
  /** Verified from fresh Shopify data in this request. */
  purchaseAvailable: boolean;
  /** True only after Tryora's strict preview validation passed for this exact variant. */
  previewAvailable: boolean;
  previewStatus: PreviewStatus;
  optionValue: string | null;
  reason: string;
}

export type AssistantStage =
  | "understanding"
  | "analysing_room"
  | "searching_products"
  | "checking_variants"
  | "reading_store_info"
  | "preparing_recommendations"
  | "checking_preview"
  | "writing";

export type AssistantEvent =
  | { type: "status"; stage: AssistantStage }
  | { type: "delta"; text: string }
  | { type: "reset_text" }
  | { type: "recommendations"; items: AssistantRecommendation[] }
  | { type: "visualise"; item: AssistantRecommendation }
  | { type: "room"; room: RoomObservations }
  | { type: "preferences"; preferences: ShopperPreferences }
  | { type: "final"; reply: AssistantReply };

export interface AssistantReply {
  message: string;
  room: RoomObservations | null;
  preferences: ShopperPreferences | null;
  recommendations: AssistantRecommendation[];
  visualise: AssistantRecommendation | null;
  model: string;
}

export function assistantProviderReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.OPENAI_API_KEY?.trim() && env.OPENAI_ASSISTANT_PRIVACY_ACKNOWLEDGED === "true";
}

/** "poll" works through any app proxy; "sse" is opt-in until a real store confirms unbuffered proxying. */
export function assistantTransport(env: NodeJS.ProcessEnv = process.env): "poll" | "sse" {
  return env.TRYORA_ASSISTANT_TRANSPORT === "sse" ? "sse" : "poll";
}

async function storeSettings(shopId: string) {
  const appearance = await prisma.appearance.findFirst({ where: { shopId, scope: "store", scopeId: null } });
  return roomAssistantSettings(appearance?.copy);
}

export async function assistantStorefrontConfig(shopId: string, page: AssistantPageContext) {
  const settings = await storeSettings(shopId);
  const visible = roomAssistantVisible(settings, page);
  return {
    enabled: visible && assistantProviderReady(),
    configured: settings.enabled,
    providerReady: assistantProviderReady(),
    greeting: settings.greeting,
    shop: shopId,
    defaultView: settings.defaultView,
    transport: assistantTransport(),
    launcher: {
      label: settings.launcherLabel,
      position: settings.launcherPosition,
      colour: settings.launcherColour,
    },
  };
}

// ---------- input normalisation (everything from the browser is untrusted) ----------

export function normaliseAssistantHistory(raw: unknown): AssistantMessage[] {
  if (!Array.isArray(raw)) throw new TryoraError("BAD_REQUEST");
  const messages = raw.slice(-MAX_HISTORY).map((entry) => {
    const role = (entry as AssistantMessage | null)?.role;
    const content = (entry as AssistantMessage | null)?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") throw new TryoraError("BAD_REQUEST");
    const clean = content.trim();
    // Assistant turns can be longer than shopper messages; both are bounded.
    if (!clean || clean.length > (role === "user" ? MAX_MESSAGE_LENGTH : MAX_MESSAGE_OUTPUT)) throw new TryoraError("BAD_REQUEST");
    return { role, content: clean };
  });
  if (!messages.length || messages.at(-1)?.role !== "user") throw new TryoraError("BAD_REQUEST");
  return messages;
}

const plain = (value: unknown, max: number) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f<>{}`]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
  : "";
const plainList = (value: unknown, count: number, max: number) =>
  Array.isArray(value) ? value.map((entry) => plain(entry, max)).filter(Boolean).slice(0, count) : [];

/** Room notes previously returned by this assistant and kept in the shopper's browser. Treated as data only. */
export function normaliseRoomContext(raw: unknown): RoomObservations | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<Record<keyof RoomObservations, unknown>>;
  const room: RoomObservations = {
    colours: plainList(value.colours, 8, 40),
    style: plain(value.style, 80),
    lighting: plain(value.lighting, 80),
    notes: plain(value.notes, 240),
    walls: plain(value.walls, 80),
    floor: plain(value.floor, 80),
    furniture: plainList(value.furniture, 8, 60),
    layout: plain(value.layout, 160),
    placement: plainList(value.placement, 4, 80),
  };
  return Object.values(room).some((entry) => Array.isArray(entry) ? entry.length : entry) ? room : null;
}

const budget = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000_000 ? value : null;

export function normalisePreferences(raw: unknown): ShopperPreferences | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<Record<keyof ShopperPreferences, unknown>>;
  const preferences: ShopperPreferences = {
    budgetMin: budget(value.budgetMin),
    budgetMax: budget(value.budgetMax),
    colours: plainList(value.colours, 6, 40),
    materials: plainList(value.materials, 6, 40),
    sizes: plainList(value.sizes, 4, 40),
    furniture: plainList(value.furniture, 4, 40),
    roomDimensions: plain(value.roomDimensions, 120),
  };
  return Object.values(preferences).some((entry) => Array.isArray(entry) ? entry.length : entry !== null && entry !== "") ? preferences : null;
}

export function normaliseShownRecommendations(raw: unknown): ShownRecommendation[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_SHOWN).flatMap((entry) => {
    const productRef = (entry as ShownRecommendation | null)?.productRef;
    const variantRef = (entry as ShownRecommendation | null)?.variantRef;
    if (!isRef(productRef)) return [];
    return [{ productRef, variantRef: isRef(variantRef) ? variantRef : null }];
  });
}

// ---------- tools ----------

const nullableString = (description: string) => ({ type: ["string", "null"], description });
const stringList = (description: string, maxItems: number) => ({ type: "array", items: { type: "string" }, maxItems, description });

export const ASSISTANT_TOOLS = [
  {
    type: "function",
    name: "search_products",
    description: "Search every product this store publishes online, including products without AI room previews. Returns verified product summaries with productRef values. Use separate fields for colour, size, material and budget.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Furniture type and key words, e.g. 'upholstered bed' or 'compact sofa'." },
        colour: nullableString("Requested colour, or null."),
        size: nullableString("Requested size such as 'king' or '3 seater', or null."),
        material: nullableString("Requested fabric or material, or null."),
        style: nullableString("Requested style or room, or null."),
        minPrice: { type: ["number", "null"], description: "Minimum price in the store currency, or null." },
        maxPrice: { type: ["number", "null"], description: "Maximum price (budget) in the store currency, or null." },
        availableOnly: { type: "boolean", description: "True to exclude products known to be sold out." },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["query", "colour", "size", "material", "style", "minPrice", "maxPrice", "availableOnly", "limit"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "get_product_details",
    description: "Read fresh, exact details for up to three products: every variant with options, price and availability, plus materials and dimensions where the merchant provides them. Use before answering about a specific product, size or colour, or about an earlier recommendation.",
    parameters: {
      type: "object",
      properties: {
        productRefs: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
        colour: nullableString("Only list variants in this colour, or null."),
        size: nullableString("Only list variants in this size, or null."),
        material: nullableString("Only list variants in this material, or null."),
      },
      required: ["productRefs", "colour", "size", "material"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "search_store_info",
    description: "Retrieve the store's own published information relevant to a question: shipping and delivery, returns and refunds, privacy, terms, FAQ and About pages, warranty, contact details and merchant notes.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The shopper's store question in a few words." } },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "list_collections",
    description: "List the store's product collections and categories with product counts.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "recommend_products",
    description: "Show up to three verified product cards to the shopper. Use productRef/variantRef values returned by search_products or get_product_details. The server re-checks price, stock and AI preview eligibility and tells you which cards were shown; then write your reply referring to them as option 1, 2, 3.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              productRef: { type: "string" },
              variantRef: { type: ["string", "null"], description: "Exact variant matching the request, or null to let the shopper choose options." },
              reason: { type: "string", description: "One sentence on why it suits the shopper or their room." },
            },
            required: ["productRef", "variantRef", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "request_visualisation",
    description: "When the shopper asks to see a specific product in their room, offer an AI room preview of one exact variant. The server verifies preview eligibility; the shopper confirms on the card before anything is generated. You never generate or describe images yourself.",
    parameters: {
      type: "object",
      properties: { productRef: { type: "string" }, variantRef: { type: "string" } },
      required: ["productRef", "variantRef"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "record_room_observations",
    description: "Only when a room photo is attached to this message: record broad, non-identifying observations so later questions can use them without the photo.",
    parameters: {
      type: "object",
      properties: {
        colours: stringList("Main visible colours.", 8),
        walls: { type: "string" },
        floor: { type: "string" },
        style: { type: "string" },
        lighting: { type: "string" },
        furniture: stringList("Existing furniture types.", 8),
        layout: { type: "string", description: "Broad layout, e.g. 'bed wall opposite window'." },
        placement: stringList("Plausible placement areas, without claiming exact fit.", 4),
        notes: { type: "string" },
      },
      required: ["colours", "walls", "floor", "style", "lighting", "furniture", "layout", "placement", "notes"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "update_shopper_context",
    description: "Remember preferences the shopper states in this chat (budget, colours, materials, sizes, furniture types, room dimensions) so follow-up questions can use them.",
    parameters: {
      type: "object",
      properties: {
        budgetMin: { type: ["number", "null"] },
        budgetMax: { type: ["number", "null"] },
        colours: stringList("Preferred colours.", 6),
        materials: stringList("Preferred materials or fabrics.", 6),
        sizes: stringList("Requested sizes.", 4),
        furniture: stringList("Furniture types wanted.", 4),
        roomDimensions: { type: "string", description: "Dimensions the shopper gave, verbatim, or empty." },
      },
      required: ["budgetMin", "budgetMax", "colours", "materials", "sizes", "furniture", "roomDimensions"],
      additionalProperties: false,
    },
    strict: true,
  },
] as const;

type ToolName = (typeof ASSISTANT_TOOLS)[number]["name"];
const TOOL_NAMES = new Set<string>(ASSISTANT_TOOLS.map((tool) => tool.name));

class ToolArgumentError extends Error {}

const argString = (value: unknown, max: number, field: string) => {
  if (typeof value !== "string" || value.length > max) throw new ToolArgumentError(field);
  return value.trim();
};
const argNullableString = (value: unknown, max: number, field: string) => value === null ? null : argString(value, max, field) || null;
const argPrice = (value: unknown, field: string) => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10_000_000) throw new ToolArgumentError(field);
  return value;
};

/** Validates model-supplied tool arguments against the allowlisted schemas. Throws on anything unexpected. */
export function parseToolArguments(name: string, raw: string): any {
  let args: any;
  try { args = JSON.parse(raw); } catch { throw new ToolArgumentError("json"); }
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new ToolArgumentError("object");
  switch (name as ToolName) {
    case "search_products":
      return {
        query: argString(args.query, 200, "query"),
        colour: argNullableString(args.colour, 60, "colour"),
        size: argNullableString(args.size, 60, "size"),
        material: argNullableString(args.material, 60, "material"),
        style: argNullableString(args.style, 60, "style"),
        minPrice: argPrice(args.minPrice, "minPrice"),
        maxPrice: argPrice(args.maxPrice, "maxPrice"),
        availableOnly: args.availableOnly === true,
        limit: Number.isInteger(args.limit) ? Math.min(10, Math.max(1, args.limit)) : 6,
      } satisfies ProductQuery;
    case "get_product_details": {
      if (!Array.isArray(args.productRefs) || !args.productRefs.length || args.productRefs.length > 3 || !args.productRefs.every(isRef)) {
        throw new ToolArgumentError("productRefs");
      }
      return {
        productRefs: args.productRefs as string[],
        colour: argNullableString(args.colour, 60, "colour"),
        size: argNullableString(args.size, 60, "size"),
        material: argNullableString(args.material, 60, "material"),
      };
    }
    case "search_store_info":
      return { query: argString(args.query, 200, "query") };
    case "list_collections":
      return {};
    case "recommend_products": {
      if (!Array.isArray(args.items) || !args.items.length || args.items.length > 3) throw new ToolArgumentError("items");
      return {
        items: args.items.map((item: any) => {
          if (!isRef(item?.productRef) || (item.variantRef !== null && !isRef(item.variantRef))) throw new ToolArgumentError("ref");
          return { productRef: item.productRef, variantRef: item.variantRef, reason: argString(item.reason ?? "", 400, "reason") };
        }),
      };
    }
    case "request_visualisation":
      if (!isRef(args.productRef) || !isRef(args.variantRef)) throw new ToolArgumentError("ref");
      return { productRef: args.productRef, variantRef: args.variantRef };
    case "record_room_observations": {
      const room = normaliseRoomContext(args);
      if (!room) throw new ToolArgumentError("room");
      return room;
    }
    case "update_shopper_context":
      return normalisePreferences(args) ?? {
        budgetMin: null, budgetMax: null, colours: [], materials: [], sizes: [], furniture: [], roomDimensions: "",
      };
    default:
      throw new ToolArgumentError("tool");
  }
}

// ---------- per-request state ----------

interface RequestContext {
  admin: AdminGraphql;
  shopId: string;
  settings: RoomAssistantSettings;
  snapshot: CatalogueSnapshot | null;
  cacheState: CacheState;
  budget: ShopifyBudget;
  previewProducts: Set<string>;
  currentProductId?: string;
  /** Product refs the model has seen from tools or verified chat context in this request. */
  allowed: Set<string>;
  /** Fresh product data read during this request. */
  fresh: Map<string, CatalogueProduct>;
  /** Prices the server has shown the model; anything else is removed from the final message. */
  prices: Set<string>;
  hasPhoto: boolean;
  emit: (event: AssistantEvent) => void;
  recommendations: AssistantRecommendation[];
  visualise: AssistantRecommendation | null;
  room: RoomObservations | null;
  preferences: ShopperPreferences | null;
}

const priceKey = (value: number | string) => Number(value).toFixed(2);

function notePrices(ctx: RequestContext, ...values: (number | string | null)[]) {
  for (const value of values) if (value !== null && Number.isFinite(Number(value))) ctx.prices.add(priceKey(value));
}

function priceText(product: CatalogueProduct) {
  return product.minPrice === product.maxPrice ? `${product.minPrice}` : `${product.minPrice}–${product.maxPrice}`;
}

const previewLabel = (ctx: RequestContext, product: CatalogueProduct) =>
  ctx.previewProducts.has(product.id) ? "configured (verified per variant on recommendation cards)" : "not offered";

function summary(match: ProductMatch, ctx: RequestContext) {
  const { product } = match;
  const known = product.variants.filter((variant) => variant.available).length;
  notePrices(ctx, product.minPrice, product.maxPrice, ...match.matchingVariants.slice(0, 5).map((variant) => variant.price));
  return {
    productRef: product.ref,
    title: product.title,
    type: product.productType || null,
    category: product.category,
    collections: product.collections.map((entry) => entry.title),
    price: priceText(product),
    currency: product.currencyCode,
    options: Object.fromEntries(product.options.map((option) => [option.name, option.values.slice(0, 25)])),
    attributes: product.attributes,
    availability: product.variantsComplete
      ? (known ? `${known} of ${product.variantCount} variants available to buy` : "sold out")
      : "partial variant sample; call get_product_details for exact availability",
    matchingVariants: match.matchingVariants.slice(0, 5).map((variant) => ({
      variantRef: variant.ref, options: variant.options, price: variant.price, available: variant.available,
    })),
    notFoundOnProduct: match.unmatched,
    aiRoomPreview: previewLabel(ctx, product),
    description: product.description.slice(0, 280),
  };
}

const STORE_UNAVAILABLE = {
  error: "store_data_temporarily_unavailable",
  instruction: "Tell the shopper the store's product information is temporarily unavailable and to try again shortly. Do not say the store has no matching products.",
};

async function runSearch(ctx: RequestContext, query: ProductQuery) {
  const pools: CatalogueSnapshot[] = [];
  if (ctx.snapshot) pools.push(ctx.snapshot);
  // Hybrid: when the cached index is cold or capped, Shopify's own search covers the rest of the catalogue.
  if (!ctx.snapshot?.complete) {
    try { pools.push(await liveSearch(ctx.admin, ctx.shopId, query, ctx.budget)); }
    catch (error) {
      // Without any catalogue data an empty result would be a false "no products" answer.
      if (!ctx.snapshot) return STORE_UNAVAILABLE;
    }
  }
  const byRef = new Map<string, ProductMatch>();
  for (const pool of pools) {
    for (const match of searchCatalogue(pool, query, ctx.currentProductId)) {
      if (!byRef.has(match.product.ref) || byRef.get(match.product.ref)!.score < match.score) byRef.set(match.product.ref, match);
    }
  }
  const matches = [...byRef.values()].sort((a, b) => b.score - a.score).slice(0, query.limit);
  matches.forEach((match) => ctx.allowed.add(match.product.ref));
  return {
    results: matches.map((match) => summary(match, ctx)),
    catalogue: {
      searchedAllPublishedProducts: !!ctx.snapshot?.complete,
      indexedProducts: ctx.snapshot?.products.length ?? 0,
    },
    note: matches.length ? undefined : "No published product matched. Say so plainly and offer a broader search.",
  };
}

function knownRef(ctx: RequestContext, ref: string) {
  // With a complete index every real published product is in it; otherwise Shopify validates the ref within this
  // merchant's own session, and parseProduct rejects drafts and products hidden from the Online Store.
  return ctx.allowed.has(ref) || ctx.fresh.has(ref) || !!ctx.snapshot?.byRef.has(ref) || !ctx.snapshot?.complete;
}

async function freshProducts(ctx: RequestContext, refs: string[], budget = ctx.budget) {
  const missing = [...new Set(refs.filter((ref) => !ctx.fresh.has(ref)))];
  if (missing.length) for (const [ref, product] of await getProductDetails(ctx.admin, missing, budget)) ctx.fresh.set(ref, product);
}

async function runDetails(ctx: RequestContext, args: { productRefs: string[]; colour: string | null; size: string | null; material: string | null }) {
  const refs = args.productRefs.filter((ref) => knownRef(ctx, ref));
  try { await freshProducts(ctx, refs); } catch { return STORE_UNAVAILABLE; }
  const products = refs.flatMap((ref) => {
    const product = ctx.fresh.get(ref);
    if (!product) return [];
    ctx.allowed.add(ref);
    const filter = { colour: args.colour, size: args.size, material: args.material, minPrice: null, maxPrice: null, availableOnly: false };
    const filtered = args.colour || args.size || args.material ? variantsMatching(product, filter) : product.variants;
    notePrices(ctx, ...filtered.slice(0, 60).flatMap((variant) => [variant.price, variant.compareAtPrice]));
    return [{
      productRef: product.ref,
      title: product.title,
      type: product.productType || null,
      category: product.category,
      collections: product.collections.map((entry) => entry.title),
      currency: product.currencyCode,
      attributes: product.attributes,
      options: Object.fromEntries(product.options.map((option) => [option.name, option.values])),
      description: product.description.slice(0, 700),
      variants: filtered.slice(0, 60).map((variant) => ({
        variantRef: variant.ref, options: variant.options, price: variant.price, compareAtPrice: variant.compareAtPrice, available: variant.available,
      })),
      variantsMatchingFilter: filtered.length,
      variantsTotal: product.variantCount,
      allVariantsLoaded: product.variantsComplete,
      aiRoomPreview: previewLabel(ctx, product),
    }];
  });
  return { products, notFound: args.productRefs.filter((ref) => !ctx.fresh.has(ref)) };
}

async function runStoreInfo(ctx: RequestContext, args: { query: string }) {
  let knowledge;
  try { knowledge = await loadStoreKnowledge(ctx.admin, ctx.shopId, ctx.settings.knowledge, ctx.budget); }
  catch { return { ...STORE_UNAVAILABLE, instruction: "Tell the shopper the store's information is temporarily unavailable and suggest trying again or contacting the store." }; }
  const sections = retrieveKnowledge(knowledge, args.query, 4);
  return {
    sections: sections.map((section) => ({ source: section.source, title: section.title, url: section.url, text: section.text })),
    note: "Answer only from these sections. If they do not cover the question, say the store has not published that information and suggest contacting the store.",
  };
}

function runCollections(ctx: RequestContext) {
  const counts = new Map<string, { title: string; handle: string; products: number }>();
  for (const product of ctx.snapshot?.products ?? []) {
    for (const collection of product.collections) {
      const entry = counts.get(collection.handle) ?? { ...collection, products: 0 };
      entry.products += 1;
      counts.set(collection.handle, entry);
    }
  }
  return {
    collections: [...counts.values()].sort((a, b) => b.products - a.products).slice(0, 60)
      .map((entry) => ({ ...entry, url: `/collections/${encodeURIComponent(entry.handle)}` })),
    complete: !!ctx.snapshot?.complete,
  };
}

const cardSummary = (item: AssistantRecommendation, index: number) => ({
  option: index + 1,
  productRef: item.productRef,
  variantRef: item.variantRef,
  title: item.title,
  options: item.options,
  price: item.maxPrice ? `${item.price}–${item.maxPrice}` : item.price,
  currency: item.currencyCode,
  availableToBuy: item.purchaseAvailable,
  aiRoomPreview: item.previewStatus,
});

async function runRecommend(ctx: RequestContext, args: { items: ModelRecommendation[] }) {
  const verified = await verifiedRecommendations(ctx, args.items);
  if (verified.length) {
    ctx.recommendations = verified;
    ctx.emit({ type: "recommendations", items: verified });
  }
  verified.forEach((item) => notePrices(ctx, item.price, item.maxPrice));
  return {
    shown: verified.map(cardSummary),
    dropped: args.items.length - verified.length,
    note: verified.length
      ? "These cards are now visible with verified price, stock and AI preview status. Refer to them as option 1, 2, 3; do not contradict them."
      : "None could be verified. Do not describe them as available; search again or explain.",
  };
}

async function runVisualise(ctx: RequestContext, args: { productRef: string; variantRef: string }) {
  const [item] = await verifiedRecommendations(ctx, [{ ...args, reason: "" }]);
  if (!item) return { offered: false, reason: "This exact product or variant could not be verified. Ask the shopper to choose from verified options." };
  if (!item.previewAvailable) {
    return {
      offered: false,
      reason: item.previewStatus === "product_page"
        ? "This product's options are configured on its product page; the shopper can preview it there."
        : item.purchaseAvailable ? "AI room preview is not available for this variant." : "This variant is currently sold out, so it cannot be previewed.",
      productUrl: item.url,
    };
  }
  ctx.visualise = item;
  ctx.emit({ type: "visualise", item });
  return {
    offered: true,
    needsPhoto: !ctx.hasPhoto,
    note: ctx.hasPhoto
      ? "A preview card is shown. The shopper confirms it to generate the image with their room photo. Tryora places the item automatically; do not promise exact positions."
      : "A preview card is shown. Ask the shopper to attach a room photo, then confirm the card.",
  };
}

async function executeTool(ctx: RequestContext, name: string, raw: string): Promise<unknown> {
  if (!TOOL_NAMES.has(name)) {
    logAssistant("tool_validation_failure", { shop: ctx.shopId, tool: "unknown", reason: "not_allowlisted" });
    return { error: "Unknown tool. Use only the provided tools." };
  }
  let args: any;
  try { args = parseToolArguments(name, raw); }
  catch (error) {
    logAssistant("tool_validation_failure", { shop: ctx.shopId, tool: name, reason: error instanceof ToolArgumentError ? error.message : "invalid" });
    return { error: "Invalid arguments. Check the tool schema and try again." };
  }
  switch (name as ToolName) {
    case "search_products": ctx.emit({ type: "status", stage: "searching_products" }); return runSearch(ctx, args);
    case "get_product_details": ctx.emit({ type: "status", stage: "checking_variants" }); return runDetails(ctx, args);
    case "search_store_info": ctx.emit({ type: "status", stage: "reading_store_info" }); return runStoreInfo(ctx, args);
    case "list_collections": return runCollections(ctx);
    case "recommend_products": ctx.emit({ type: "status", stage: "preparing_recommendations" }); return runRecommend(ctx, args);
    case "request_visualisation": ctx.emit({ type: "status", stage: "checking_preview" }); return runVisualise(ctx, args);
    case "record_room_observations":
      if (!ctx.hasPhoto) return { error: "No photo is attached to this message; use the room notes in the context instead." };
      ctx.room = args;
      ctx.emit({ type: "room", room: args });
      return { recorded: true };
    case "update_shopper_context":
      ctx.preferences = args;
      ctx.emit({ type: "preferences", preferences: args });
      return { recorded: true };
  }
}

// ---------- preview eligibility ----------

function nativeVariants(product: CatalogueProduct): NativeVariant[] {
  return product.variants.map((variant) => ({
    id: variant.id,
    availableForSale: variant.available,
    image: variant.image ? { url: variant.image } : null,
    selectedOptions: Object.entries(variant.options).map(([name, value]) => ({ name, value })),
  }));
}

/**
 * "Available for AI preview" means Tryora's existing strict validation passed for this exact variant, through the
 * same provider adapter chain that startPreview uses. Anything less is reported as not available.
 */
async function previewStatusFor(ctx: RequestContext, product: CatalogueProduct, variant: CatalogueVariant | null, config: ConfigWithChoices | undefined): Promise<{ status: PreviewStatus; optionValue: string | null }> {
  if (!config || config.shopId !== ctx.shopId || config.productId !== product.id) return { status: "not_configured", optionValue: null };
  if (!variant) return { status: "choose_options", optionValue: null };
  if (!variant.available) return { status: "unavailable", optionValue: null };
  try {
    const setting = await loadProviderSetting(ctx.shopId, product.id);
    const adapter = providerAdapter(setting.providerId);
    if (!adapter.capabilities.authorization || (setting.providerId !== "shopify_native" && !setting.active)) return { status: "unavailable", optionValue: null };
    // Cloudlift and manual mappings need the shopper's live product-page selection to verify image identity.
    if (setting.providerId !== "shopify_native") return { status: "product_page", optionValue: null };
    const variants = nativeVariants(product);
    const model = nativeSelections(product.options.map((option) => ({ name: option.name, optionValues: option.values.map((name) => ({ name })) })), config.visualOptionName, variants);
    if (model.issue || (config.autoConfigured && model.ambiguous)) return { status: "unavailable", optionValue: null };
    const native = variants.find((entry) => entry.id === variant.id)!;
    const selection = model.selections.find((entry) => matchesOptions(native, entry.options));
    if (model.selections.length && !selection) return { status: "unavailable", optionValue: null };
    const optionValue = selection?.value ?? SINGLE;
    await resolveConfiguredPreview({ admin: ctx.admin, config, setting }, optionValue, variant.id);
    return { status: "available", optionValue };
  } catch {
    // A stale or incomplete reference is reported as unavailable instead of being substituted.
    return { status: "unavailable", optionValue: null };
  }
}

// ---------- recommendations ----------

interface ModelRecommendation { productRef: string; variantRef: string | null; reason: string }

async function verifiedRecommendations(ctx: RequestContext, requested: ModelRecommendation[]): Promise<AssistantRecommendation[]> {
  const picks: ModelRecommendation[] = [];
  for (const entry of requested) {
    if (picks.length >= 3) break;
    if (!isRef(entry?.productRef) || !ctx.allowed.has(entry.productRef)) {
      logAssistant("recommendation_dropped", { shop: ctx.shopId, reason: "not_returned_by_tools" }, "info");
      continue;
    }
    const variantRef = isRef(entry.variantRef) ? entry.variantRef : null;
    if (picks.some((pick) => pick.productRef === entry.productRef && pick.variantRef === variantRef)) continue;
    picks.push({ productRef: entry.productRef, variantRef, reason: String(entry.reason ?? "") });
  }
  // Fresh price, stock and variant data before anything actionable is shown.
  try { await freshProducts(ctx, picks.map((pick) => pick.productRef), new ShopifyBudget(6)); }
  catch { /* Unverifiable recommendations are dropped below. */ }
  const ids = [...new Set(picks.map((pick) => ctx.fresh.get(pick.productRef)?.id).filter((id): id is string => !!id && ctx.previewProducts.has(id)))];
  const configs = ids.length ? await prisma.productPreviewConfig.findMany({
    where: { shopId: ctx.shopId, productId: { in: ids }, enabled: true, readiness: "ready" },
    include: { choices: true },
  }) as ConfigWithChoices[] : [];
  const configFor = (productId: string) => configs.find((config) => config.productId === productId && config.shopId === ctx.shopId);

  const verified = await Promise.all(picks.map(async (pick): Promise<AssistantRecommendation | null> => {
    const product = ctx.fresh.get(pick.productRef);
    if (!product) {
      logAssistant("recommendation_dropped", { shop: ctx.shopId, reason: "not_found_fresh" }, "info");
      return null;
    }
    const variant = pick.variantRef ? product.variants.find((entry) => entry.ref === pick.variantRef) ?? null : null;
    if (pick.variantRef && !variant) {
      // Never substitute another variant, fabric, colour or size.
      logAssistant("recommendation_dropped", { shop: ctx.shopId, reason: "variant_not_found" }, "info");
      return null;
    }
    const preview = await previewStatusFor(ctx, product, variant, configFor(product.id));
    return {
      id: `${product.ref}:${variant?.ref ?? ""}`,
      productRef: product.ref,
      variantRef: variant?.ref ?? null,
      productId: product.id,
      variantId: variant?.id ?? null,
      title: product.title,
      url: variant ? `${product.url}?variant=${encodeURIComponent(variant.ref)}` : product.url,
      image: variant?.image ?? product.image,
      price: variant ? variant.price : String(product.minPrice),
      maxPrice: variant || product.minPrice === product.maxPrice ? null : String(product.maxPrice),
      currencyCode: product.currencyCode,
      options: variant?.options ?? {},
      purchaseAvailable: variant ? variant.available : product.variants.some((entry) => entry.available),
      previewAvailable: preview.status === "available",
      previewStatus: preview.status,
      optionValue: preview.optionValue,
      reason: pick.reason.trim().slice(0, 300),
    };
  }));
  return verified.filter((entry): entry is AssistantRecommendation => !!entry);
}

/**
 * Streamed prose is a draft; this is the authoritative message. Any price the server never showed the model (and
 * the shopper never typed) is replaced, so a hallucinated price cannot survive into the final answer.
 */
export function sanitiseMessage(text: string, allowedPrices: Set<string>, shopperText: string) {
  const typed = new Set((shopperText.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((value) => priceKey(value.replace(/,/g, ""))));
  const money = /(?:[£$€]\s?|\b(?:GBP|USD|EUR|CAD|AUD)\s?)(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(?:GBP|USD|EUR|CAD|AUD)\b/gi;
  let removed = 0;
  const clean = text.replace(money, (match, before?: string, after?: string) => {
    const key = priceKey(String(before ?? after).replace(/,/g, ""));
    if (allowedPrices.has(key) || typed.has(key)) return match;
    removed += 1;
    return "the price shown on the product";
  });
  return { message: clean.trim().slice(0, MAX_MESSAGE_OUTPUT), removed };
}

// ---------- model ----------

let clientOverride: (() => OpenAI) | null = null;
/** Test and local-harness hook: supplies the model client used when a turn does not pass one. */
export function setAssistantClientForTests(factory: (() => OpenAI) | null) { clientOverride = factory; }

function openAIClient(env: NodeJS.ProcessEnv = process.env) {
  if (!assistantProviderReady(env)) throw new TryoraError("PROVIDER_UNAVAILABLE");
  return new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    maxRetries: 0,
    timeout: MODEL_CALL_TIMEOUT_MS,
    fetch: boundedOpenAIFetch,
    logLevel: "off",
  });
}

const INSTRUCTIONS = `You are the furniture shopping assistant for exactly one Shopify store. You can see only this store's data, through the tools.
Grounding:
- Use the tools before any factual claim about products, options, colours, sizes, materials, dimensions, prices, stock, AI room previews, delivery, returns, warranty, promotions or store policies. Never invent any of these.
- A product exists only if a tool returned it. Recommend only productRef/variantRef values a tool returned; never alter or guess a ref, and never swap one variant for a similar one.
- To show products, call recommend_products, then write your reply referring to the cards as option 1, 2, 3. The cards show verified price, stock and AI preview status, so do not restate stock or preview status in prose; mention a price only if a tool returned it.
- Set variantRef only when that exact variant matches the request; otherwise null, and say the shopper can choose options on the product page.
- "Available to buy" and "AI room preview" are different things. A product without AI preview is still sold by the store.
- If a tool says store data is temporarily unavailable, say so; never claim the store has no matching products in that case.
- Give delivery times, shipping costs, discounts, promotions or warranty terms only when search_store_info returns them. Otherwise say the store has not published it and suggest contacting the store.
- You cannot see orders or customer accounts. For order status, point the shopper to their order confirmation or the store's contact details.
Conversation:
- "The second one", "it" and similar refer to the numbered recommendations or the selected product in the conversation context. Use get_product_details to check another colour or size of it.
- When the shopper states a budget, colours, materials, sizes or room dimensions, call update_shopper_context, and apply saved preferences to later searches.
Room photos and visualisation:
- When a photo is attached, first call record_room_observations with broad visible colours, walls, floor, style, lighting, furniture, layout and plausible placement areas. Do not identify people or infer sensitive traits.
- Never claim an exact fit from a photo; ask for measurements when size matters.
- When the shopper wants to see a product in their room, call request_visualisation with the exact productRef and variantRef. The shopper confirms on the card; you never generate images. Tryora places the item automatically: do not promise exact positions, moving existing furniture or custom colours that are not real variants.
Style: concise, warm and practical, in plain text. Short paragraphs; "- " bullets are fine. At most about 120 words unless the shopper asks for detail.`;

function contextMessage(ctx: RequestContext, shown: ShownRecommendation[], room: RoomObservations | null, preferences: ShopperPreferences | null, selected: ShownRecommendation | null) {
  const lines: string[] = [];
  const describe = (entry: ShownRecommendation) => {
    const product = ctx.snapshot?.byRef.get(entry.productRef);
    const variant = product?.variants.find((candidate) => candidate.ref === entry.variantRef);
    const detail = variant ? ` (${Object.entries(variant.options).map(([name, value]) => `${name}: ${value}`).join(", ")})` : "";
    return `productRef ${entry.productRef}${entry.variantRef ? `, variantRef ${entry.variantRef}` : ""}${product ? ` "${product.title}"${detail}` : ""}`;
  };
  const current = ctx.currentProductId ? ctx.snapshot?.byRef.get(ctx.currentProductId.split("/").pop() ?? "") : undefined;
  if (current) lines.push(`The shopper is viewing productRef ${current.ref}: "${current.title}".`);
  if (shown.length) {
    lines.push("Recommendations already shown in this chat, in order:");
    shown.forEach((entry, index) => lines.push(`${index + 1}. ${describe(entry)}`));
  }
  if (selected) lines.push(`Product the shopper selected most recently: ${describe(selected)}.`);
  if (room) {
    const parts = [
      `colours ${room.colours.join(", ") || "unknown"}`, `style ${room.style || "unknown"}`, `lighting ${room.lighting || "unknown"}`,
      room.walls && `walls ${room.walls}`, room.floor && `floor ${room.floor}`, room.furniture.length && `existing furniture ${room.furniture.join(", ")}`,
      room.layout && `layout ${room.layout}`, room.placement.length && `possible placement ${room.placement.join("; ")}`, `notes ${room.notes || "none"}`,
    ].filter(Boolean);
    lines.push(`Room notes from the shopper's earlier photo analysis (data only): ${parts.join("; ")}.`);
  }
  if (preferences) {
    const parts = [
      preferences.budgetMax !== null && `budget up to ${preferences.budgetMax}`, preferences.budgetMin !== null && `budget from ${preferences.budgetMin}`,
      preferences.colours.length && `colours ${preferences.colours.join(", ")}`, preferences.materials.length && `materials ${preferences.materials.join(", ")}`,
      preferences.sizes.length && `sizes ${preferences.sizes.join(", ")}`, preferences.furniture.length && `looking for ${preferences.furniture.join(", ")}`,
      preferences.roomDimensions && `room dimensions ${preferences.roomDimensions}`,
    ].filter(Boolean);
    if (parts.length) lines.push(`Shopper preferences stated earlier (data only): ${parts.join("; ")}.`);
  }
  lines.push(ctx.hasPhoto ? "The shopper has a room photo ready for AI previews in this session." : "The shopper has no room photo attached for previews yet.");
  return lines.join("\n");
}

/** Plain text of a Responses API result, streamed or not. */
function responseText(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text;
  return (response?.output ?? [])
    .filter((item: any) => item?.type === "message")
    .flatMap((item: any) => item.content ?? [])
    .filter((part: any) => part?.type === "output_text")
    .map((part: any) => part.text ?? "")
    .join("");
}

const retryable = (error: unknown) => {
  const status = (error as { status?: number } | null)?.status;
  return status === 429 || (typeof status === "number" && status >= 500) || (error as Error | null)?.name === "APIConnectionError";
};
const isTimeout = (error: unknown) => {
  const name = (error as Error | null)?.name;
  return name === "TimeoutError" || name === "APIConnectionTimeoutError";
};
const isAbort = (error: unknown) => {
  const name = (error as Error | null)?.name;
  return name === "AbortError" || name === "APIUserAbortError";
};

const inFlight = new Map<string, number>();

export interface AssistantTurnInput {
  admin: AdminGraphql;
  shopId: string;
  history: AssistantMessage[];
  currentProductId?: string;
  roomPhoto?: Uint8Array;
  /** The browser holds a room photo in memory for previews, even when it is not sent with this message. */
  hasPhoto?: boolean;
  room?: unknown;
  shown?: unknown;
  selected?: unknown;
  preferences?: unknown;
  settings?: RoomAssistantSettings;
  client?: OpenAI;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** Non-streaming entry point: returns the final reply. Kept for the JSON assistant/message endpoint. */
export async function answerRoomAssistant(input: AssistantTurnInput): Promise<AssistantReply> {
  let reply: AssistantReply | null = null;
  await runAssistantTurn(input, (event) => { if (event.type === "final") reply = event.reply; });
  return reply!;
}

/** Streams one assistant turn through `emit`, ending with a "final" event. Throws TryoraError on failure. */
export async function runAssistantTurn(input: AssistantTurnInput, emit: (event: AssistantEvent) => void): Promise<void> {
  const active = inFlight.get(input.shopId) ?? 0;
  if (active >= MAX_CONCURRENT_PER_SHOP) {
    logAssistant("rate_limited", { shop: input.shopId, reason: "concurrency" });
    throw new TryoraError("RATE_LIMITED");
  }
  inFlight.set(input.shopId, active + 1);
  try { await run(input, emit); }
  finally {
    const left = (inFlight.get(input.shopId) ?? 1) - 1;
    if (left > 0) inFlight.set(input.shopId, left);
    else inFlight.delete(input.shopId);
  }
}

async function run(input: AssistantTurnInput, emit: (event: AssistantEvent) => void): Promise<void> {
  const started = Date.now();
  const deadline = started + REQUEST_BUDGET_MS;
  const env = input.env ?? process.env;
  const client = input.client ?? clientOverride?.() ?? openAIClient(env);
  const model = env.OPENAI_ASSISTANT_MODEL?.trim() || "gpt-4.1-mini";
  const history = normaliseAssistantHistory(input.history);
  const room = normaliseRoomContext(input.room);
  const preferences = normalisePreferences(input.preferences);
  const shown = normaliseShownRecommendations(input.shown);
  const [selected = null] = normaliseShownRecommendations(input.selected ? [input.selected] : []);
  const currentProductId = typeof input.currentProductId === "string" && /^gid:\/\/shopify\/Product\/\d{1,20}$/.test(input.currentProductId)
    ? input.currentProductId : undefined;
  emit({ type: "status", stage: input.roomPhoto ? "analysing_room" : "understanding" });

  const [settings, catalogue, previewRows] = await Promise.all([
    input.settings ?? storeSettings(input.shopId),
    getCatalogue(input.admin, input.shopId, CATALOGUE_WAIT_MS),
    prisma.productPreviewConfig.findMany({
      where: { shopId: input.shopId, enabled: true, readiness: "ready" },
      select: { productId: true },
      take: 5000,
    }),
  ]);
  const ctx: RequestContext = {
    admin: input.admin,
    shopId: input.shopId,
    settings,
    snapshot: catalogue.snapshot,
    cacheState: catalogue.cache,
    budget: new ShopifyBudget(),
    previewProducts: new Set(previewRows.map((row: { productId: string }) => row.productId)),
    currentProductId,
    allowed: new Set([...shown.map((entry) => entry.productRef), ...(selected ? [selected.productRef] : [])]),
    fresh: new Map(),
    prices: new Set(),
    hasPhoto: !!input.roomPhoto || input.hasPhoto === true,
    emit,
    recommendations: [],
    visualise: null,
    room: null,
    preferences: null,
  };
  if (currentProductId) ctx.allowed.add(currentProductId.split("/").pop()!);

  const latest = history.at(-1)!;
  const content: any[] = [{ type: "input_text", text: latest.content }];
  if (input.roomPhoto) {
    const image = await normaliseImage(input.roomPhoto);
    content.push({ type: "input_image", image_url: `data:image/jpeg;base64,${Buffer.from(image).toString("base64")}`, detail: "high" });
  }
  const conversation: any[] = [
    ...history.slice(0, -1).map((message) => ({ role: message.role, content: message.content })),
    { role: "developer", content: contextMessage(ctx, shown, room, preferences, selected) },
    { role: "user", content },
  ];

  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let rounds = 0;
  let streamedText = false;
  /** One model call, streamed. Text deltas are forwarded as they arrive. */
  const call = async (body: Record<string, unknown>) => {
    for (let attempt = 0; ; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining < 2_000) {
        logAssistant("timeout", { shop: input.shopId, stage: "model", round: rounds });
        throw new TryoraError("PROVIDER_TIMEOUT");
      }
      const timeout = Math.min(MODEL_CALL_TIMEOUT_MS, remaining);
      const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
      let deltas = 0;
      try {
        const result: any = await client.responses.create({
          model,
          instructions: INSTRUCTIONS,
          tools: ASSISTANT_TOOLS,
          store: false,
          stream: true,
          max_output_tokens: 900,
          ...body,
        } as any, { signal, timeout, maxRetries: 0 });
        let response: any = result;
        if (result && typeof result[Symbol.asyncIterator] === "function") {
          response = null;
          for await (const event of result as AsyncIterable<any>) {
            if (event?.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta) {
              if (!streamedText) emit({ type: "status", stage: "writing" });
              streamedText = true;
              deltas += 1;
              emit({ type: "delta", text: event.delta });
            } else if (event?.type === "response.completed" || event?.type === "response.incomplete") {
              response = event.response;
            } else if (event?.type === "response.failed" || event?.type === "error") {
              throw Object.assign(new Error("stream_failed"), { status: event?.response?.error ? 500 : undefined });
            }
          }
          if (!response) throw Object.assign(new Error("stream_ended"), { name: "APIConnectionError" });
        } else {
          // Non-streaming result (test doubles): forward its text as a single delta.
          const text = responseText(result);
          if (text && !(result.output ?? []).some((item: any) => item?.type === "function_call")) {
            if (!streamedText) emit({ type: "status", stage: "writing" });
            streamedText = true;
            emit({ type: "delta", text });
          }
        }
        inputTokens += Number(response?.usage?.input_tokens ?? 0);
        outputTokens += Number(response?.usage?.output_tokens ?? 0);
        return response;
      } catch (error) {
        // The shopper stopped or replaced this turn; nothing to log or retry.
        if (input.signal?.aborted) throw new TryoraError("BAD_REQUEST", "cancelled");
        if (isTimeout(error) || isAbort(error)) {
          logAssistant("timeout", { shop: input.shopId, stage: "model", round: rounds, ...errorShape(error) });
          throw new TryoraError("PROVIDER_TIMEOUT");
        }
        logAssistant("openai_failure", { shop: input.shopId, round: rounds, ...errorShape(error) });
        // A retry after text has streamed would duplicate it, so only retry before any output.
        if (attempt === 0 && deltas === 0 && retryable(error) && deadline - Date.now() > 15_000) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        throw new TryoraError("PROVIDER_UNAVAILABLE");
      }
    }
  };

  const running: any[] = [...conversation];
  let final: any = null;
  for (; rounds < MAX_TOOL_ROUNDS; rounds += 1) {
    const response = await call({
      input: running,
      // The first round must consult the store, so even small talk cannot produce ungrounded product claims.
      tool_choice: rounds === 0 ? "required" : "auto",
      parallel_tool_calls: false,
    });
    const calls = (response.output ?? []).filter((item: any) => item?.type === "function_call");
    if (!calls.length) { final = response; break; }
    if (streamedText) { emit({ type: "reset_text" }); streamedText = false; }
    running.push(...(response.output ?? []));
    for (const item of calls) {
      toolCalls += 1;
      const output = toolCalls > MAX_TOOL_CALLS
        ? { error: "Tool budget reached. Answer with the information you have." }
        : await executeTool(ctx, String(item.name), String(item.arguments ?? "")).catch(() =>
          // Shopify failures are already logged; the model is told to answer with what it has.
          STORE_UNAVAILABLE);
      running.push({ type: "function_call_output", call_id: item.call_id, output: JSON.stringify(output) });
    }
  }
  if (!final) final = await call({ input: running, tool_choice: "none" });

  const raw = responseText(final).trim();
  if (!raw) {
    logAssistant("model_parse_failure", { shop: input.shopId, reason: "empty" });
    throw new TryoraError("PROVIDER_UNAVAILABLE");
  }
  const shopperText = history.filter((message) => message.role === "user").map((message) => message.content).join(" ");
  const { message, removed } = sanitiseMessage(raw, ctx.prices, shopperText);
  if (removed) logAssistant("model_parse_failure", { shop: input.shopId, reason: "unverified_price_removed", products: removed });
  const reply: AssistantReply = {
    message,
    room: ctx.room,
    preferences: ctx.preferences,
    recommendations: ctx.recommendations,
    visualise: ctx.visualise,
    model,
  };
  logAssistant("assistant_request", {
    shop: input.shopId,
    durationMs: Date.now() - started,
    rounds: rounds + 1,
    toolCalls,
    shopifyCalls: ctx.budget.calls,
    cache: ctx.cacheState,
    products: ctx.snapshot?.products.length ?? 0,
    complete: !!ctx.snapshot?.complete,
    inputTokens,
    outputTokens,
    recommendations: reply.recommendations.length,
    photo: !!input.roomPhoto,
    model,
  }, "info");
  emit({ type: "final", reply });
}

export async function requireAssistantEnabled(shopId: string): Promise<RoomAssistantSettings> {
  const settings = await storeSettings(shopId);
  if (!settings.enabled || !assistantProviderReady()) throw new TryoraError("PROVIDER_UNAVAILABLE");
  return settings;
}
