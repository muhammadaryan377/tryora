import OpenAI from "openai";
import type { ProductPreviewConfig, VisualChoice } from "@prisma/client";
import prisma from "./db.server";
import { TryoraError } from "./core/index";
import { nativeSelections, type NativeVariant } from "./core/customization";
import { eligibleVariants } from "./native-selection.server";
import { resolvePreviewProduct, type AdminGraphql } from "./preview-product.server";
import { boundedOpenAIFetch } from "./openai-image-provider.server";
import { normaliseImage } from "./preview-images.server";
import {
  roomAssistantSettings,
  roomAssistantVisible,
  type AssistantPageContext,
  type RoomAssistantSettings,
} from "./room-assistant-settings";

const MAX_HISTORY = 12;
const MAX_MESSAGE_LENGTH = 800;
const MAX_CATALOGUE_CANDIDATES = 600;
const MAX_TOOL_RESULTS = 24;
const ASSISTANT_TIMEOUT_MS = 45_000;

type ConfigWithChoices = ProductPreviewConfig & { choices: VisualChoice[] };

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantCandidate {
  id: string;
  productId: string;
  variantId: string;
  optionValue: string;
  title: string;
  handle: string;
  url: string;
  image: string | null;
  description: string;
  productType: string;
  price: string;
  currencyCode: string;
  options: Record<string, string>;
  previewAvailable: boolean;
}

export interface AssistantRecommendation extends AssistantCandidate {
  reason: string;
}

export interface AssistantReply {
  message: string;
  room: { colours: string[]; style: string; lighting: string; notes: string } | null;
  recommendations: AssistantRecommendation[];
  model: string;
}

interface CatalogueProduct {
  id: string;
  title: string;
  handle: string;
  description: string;
  productType: string;
  onlineStoreUrl?: string | null;
  featuredMedia?: { preview?: { image?: { url?: string } } } | null;
  options: { name: string; optionValues: { name: string; swatch?: { color?: string | null; image?: { image?: { url?: string } } } | null }[] }[];
  variants: {
    nodes: (NativeVariant & {
      price: string;
      media?: { nodes?: { preview?: { image?: { url: string } } }[] };
    })[];
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  };
}

const ASSISTANT_PRODUCT_QUERY = `#graphql
  query TryoraAssistantProduct($id: ID!, $after: String) {
    shop { currencyCode }
    product(id: $id) {
      id title handle description productType onlineStoreUrl
      featuredMedia { preview { image { url(transform: { maxWidth: 800, maxHeight: 800 }) } } }
      options { name optionValues { name swatch { color image { image { url } } } } }
      variants(first: 250, after: $after) {
        nodes {
          id availableForSale price
          media(first: 1) { nodes { preview { image { url(transform: { maxWidth: 800, maxHeight: 800 }) } } } }
          selectedOptions { name value }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

const SHOP_POLICIES_QUERY = `#graphql
  query TryoraAssistantPolicies {
    shop { name shopPolicies { type title url body } }
  }`;

export function assistantProviderReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.OPENAI_API_KEY?.trim() && env.OPENAI_ASSISTANT_PRIVACY_ACKNOWLEDGED === "true";
}

export async function assistantStorefrontConfig(shopId: string, page: AssistantPageContext) {
  const appearance = await prisma.appearance.findFirst({ where: { shopId, scope: "store", scopeId: null } });
  const settings = roomAssistantSettings(appearance?.copy);
  const visible = roomAssistantVisible(settings, page);
  return {
    enabled: visible && assistantProviderReady(),
    configured: settings.enabled,
    providerReady: assistantProviderReady(),
    greeting: settings.greeting,
    launcher: {
      label: settings.launcherLabel,
      position: settings.launcherPosition,
      colour: settings.launcherColour,
    },
  };
}

export function normaliseAssistantHistory(raw: unknown): AssistantMessage[] {
  if (!Array.isArray(raw)) throw new TryoraError("BAD_REQUEST");
  const messages = raw.slice(-MAX_HISTORY).map((entry) => {
    const role = (entry as AssistantMessage | null)?.role;
    const content = (entry as AssistantMessage | null)?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") throw new TryoraError("BAD_REQUEST");
    const clean = content.trim();
    if (!clean || clean.length > MAX_MESSAGE_LENGTH) throw new TryoraError("BAD_REQUEST");
    return { role, content: clean };
  });
  if (!messages.length || messages.at(-1)?.role !== "user") throw new TryoraError("BAD_REQUEST");
  return messages;
}

function candidateId(productId: string, variantId: string, optionValue: string) {
  return Buffer.from(`${productId}\n${variantId}\n${optionValue}`).toString("base64url");
}

function optionRecord(variant: NativeVariant): Record<string, string> {
  return Object.fromEntries(variant.selectedOptions.map((option) => [option.name, option.value]));
}

function preliminaryReferenceAvailable(config: ConfigWithChoices, selectionValue: string | null, variant: NativeVariant) {
  if (variant.image?.url) return true;
  if (!selectionValue) return !!config.referenceMediaId;
  const choices = config.choices.filter((choice) => choice.optionValue === selectionValue ||
    choice.optionValue === optionRecord(variant)[config.visualOptionName ?? ""]);
  return choices.some((choice) => choice.available &&
    (!(choice.variantIds as string[]).length || (choice.variantIds as string[]).includes(variant.id)) &&
    (choice.approvedMediaIds as string[]).length > 0);
}

async function loadProduct(admin: AdminGraphql, id: string): Promise<{ product: CatalogueProduct; currencyCode: string } | null> {
  let product: CatalogueProduct | null = null;
  let currencyCode = "GBP";
  const variants: CatalogueProduct["variants"]["nodes"] = [];
  let after: string | null = null;
  do {
    const response = await admin.graphql(ASSISTANT_PRODUCT_QUERY, { variables: { id, after } });
    const json: any = await response.json();
    if (!response.ok || json.errors?.length || !json.data?.product) return null;
    product = json.data.product;
    currencyCode = json.data.shop?.currencyCode ?? currencyCode;
    variants.push(...(product!.variants.nodes ?? []).map((variant) => ({
      ...variant,
      image: variant.media?.nodes?.[0]?.preview?.image ?? variant.image,
    })));
    const page = product!.variants.pageInfo;
    if (page.hasNextPage && (!page.endCursor || page.endCursor === after)) throw new TryoraError("PROVIDER_UNAVAILABLE");
    after = page.hasNextPage ? page.endCursor ?? null : null;
  } while (after);
  product!.variants.nodes = variants;
  return { product: product!, currencyCode };
}

export async function loadAssistantCatalogue(admin: AdminGraphql, shopId: string): Promise<{
  candidates: AssistantCandidate[];
  configs: Map<string, ConfigWithChoices>;
}> {
  const rows = await prisma.productPreviewConfig.findMany({
    where: { shopId, enabled: true, readiness: "ready" },
    include: { choices: true },
    orderBy: { updatedAt: "desc" },
    take: 25,
  });
  const candidates: AssistantCandidate[] = [];
  const configs = new Map<string, ConfigWithChoices>();
  for (const config of rows) {
    if (candidates.length >= MAX_CATALOGUE_CANDIDATES) break;
    const loaded = await loadProduct(admin, config.productId);
    if (!loaded) continue;
    const { product, currencyCode } = loaded;
    configs.set(product.id, config);
    const model = nativeSelections(product.options, config.visualOptionName, product.variants.nodes);
    if (model.issue || (config.autoConfigured && model.ambiguous)) continue;
    const selections = model.selections.length ? model.selections : [null];
    for (const selection of selections) {
      const variants = eligibleVariants(config, product.variants.nodes, selection ?? undefined);
      for (const variant of variants) {
        if (candidates.length >= MAX_CATALOGUE_CANDIDATES) break;
        const optionValue = selection?.value ?? "__single__";
        const variantNumericId = variant.id.split("/").pop();
        const baseUrl = product.onlineStoreUrl || `/products/${encodeURIComponent(product.handle)}`;
        const url = variantNumericId ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}variant=${encodeURIComponent(variantNumericId)}` : baseUrl;
        candidates.push({
          id: candidateId(product.id, variant.id, optionValue),
          productId: product.id,
          variantId: variant.id,
          optionValue,
          title: product.title,
          handle: product.handle,
          url,
          image: variant.image?.url ?? product.featuredMedia?.preview?.image?.url ?? null,
          description: product.description.slice(0, 1200),
          productType: product.productType,
          price: product.variants.nodes.find((node) => node.id === variant.id)?.price ?? "0",
          currencyCode,
          options: optionRecord(variant),
          previewAvailable: preliminaryReferenceAvailable(config, selection?.value ?? null, variant),
        });
      }
    }
  }
  return { candidates, configs };
}

function searchable(candidate: AssistantCandidate) {
  return [candidate.title, candidate.productType, candidate.description, ...Object.values(candidate.options)]
    .join(" ").toLocaleLowerCase();
}

export function searchAssistantCatalogue(candidates: AssistantCandidate[], query: {
  query: string;
  size: string | null;
  colour: string | null;
  style: string | null;
  maxResults: number;
}, currentProductId?: string): AssistantCandidate[] {
  const terms = [query.query, query.size, query.colour, query.style]
    .filter((value): value is string => !!value?.trim())
    .flatMap((value) => value.toLocaleLowerCase().split(/\s+/).filter((term) => term.length > 1));
  return candidates
    .map((candidate) => {
      const termMatches = terms.reduce(
        (score, term) => score + (searchable(candidate).includes(term) ? 1 : 0),
        0,
      );
      return {
        candidate,
        termMatches,
        score: (candidate.productId === currentProductId ? 4 : 0) + termMatches,
      };
    })
    .filter(({ termMatches }) => !terms.length || termMatches > 0)
    .sort((a, b) => b.score - a.score || a.candidate.title.localeCompare(b.candidate.title))
    .slice(0, Math.min(MAX_TOOL_RESULTS, Math.max(1, query.maxResults || 12)))
    .map(({ candidate }) => candidate);
}

async function merchantPolicies(admin: AdminGraphql) {
  try {
    const response = await admin.graphql(SHOP_POLICIES_QUERY);
    const json: any = await response.json();
    if (!response.ok || json.errors?.length) return [];
    return (json.data?.shop?.shopPolicies ?? []).slice(0, 8).map((policy: any) => ({
      type: String(policy.type ?? ""),
      title: String(policy.title ?? ""),
      url: String(policy.url ?? ""),
      summary: String(policy.body ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 700),
    }));
  } catch {
    return [];
  }
}

function openAIClient(env: NodeJS.ProcessEnv = process.env) {
  if (!assistantProviderReady(env)) throw new TryoraError("PROVIDER_UNAVAILABLE");
  return new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    maxRetries: 0,
    timeout: ASSISTANT_TIMEOUT_MS,
    fetch: boundedOpenAIFetch,
    logLevel: "off",
  });
}

function toolCandidate(candidate: AssistantCandidate) {
  return {
    candidateId: candidate.id,
    productId: candidate.productId,
    variantId: candidate.variantId,
    title: candidate.title,
    description: candidate.description,
    price: candidate.price,
    currencyCode: candidate.currencyCode,
    options: candidate.options,
    imageAvailable: !!candidate.image,
    previewAvailable: candidate.previewAvailable,
    url: candidate.url,
  };
}

const STORE_CONTEXT_TOOL = {
  type: "function",
  name: "get_verified_store_context",
  description: "Search the current merchant's verified Shopify catalogue and retrieve merchant-authored policy summaries. Call this before making any product, option, price, availability, preview, or policy claim.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Product or policy question in a few search terms." },
      size: { type: ["string", "null"], description: "Requested size, or null." },
      colour: { type: ["string", "null"], description: "Requested colour, or null." },
      style: { type: ["string", "null"], description: "Requested room or furniture style, or null." },
      maxResults: { type: "integer", minimum: 1, maximum: MAX_TOOL_RESULTS },
    },
    required: ["query", "size", "colour", "style", "maxResults"],
    additionalProperties: false,
  },
  strict: true,
} as const;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string" },
    room: {
      anyOf: [
        {
          type: "object",
          properties: {
            colours: { type: "array", items: { type: "string" }, maxItems: 8 },
            style: { type: "string" },
            lighting: { type: "string" },
            notes: { type: "string" },
          },
          required: ["colours", "style", "lighting", "notes"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
    recommendations: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: { candidateId: { type: "string" }, reason: { type: "string" } },
        required: ["candidateId", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["message", "room", "recommendations"],
  additionalProperties: false,
} as const;

function parseModelOutput(text: string) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.message !== "string" || !Array.isArray(parsed.recommendations)) throw new Error("invalid");
    return parsed as { message: string; room: AssistantReply["room"]; recommendations: { candidateId: string; reason: string }[] };
  } catch {
    throw new TryoraError("PROVIDER_UNAVAILABLE");
  }
}

export async function answerRoomAssistant(input: {
  admin: AdminGraphql;
  shopId: string;
  history: AssistantMessage[];
  currentProductId?: string;
  roomPhoto?: Uint8Array;
  client?: OpenAI;
  env?: NodeJS.ProcessEnv;
}): Promise<AssistantReply> {
  const env = input.env ?? process.env;
  const client = input.client ?? openAIClient(env);
  const model = env.OPENAI_ASSISTANT_MODEL?.trim() || "gpt-4.1-mini";
  const [{ candidates, configs }, policies] = await Promise.all([
    loadAssistantCatalogue(input.admin, input.shopId),
    merchantPolicies(input.admin),
  ]);
  const history = normaliseAssistantHistory(input.history);
  const latest = history.at(-1)!;
  const content: any[] = [{ type: "input_text", text: latest.content }];
  if (input.roomPhoto) {
    const image = await normaliseImage(input.roomPhoto);
    content.push({ type: "input_image", image_url: `data:image/jpeg;base64,${Buffer.from(image).toString("base64")}`, detail: "high" });
  }
  const conversation: any[] = [
    ...history.slice(0, -1).map((message) => ({ role: message.role, content: message.content })),
    { role: "user", content },
  ];
  const instructions = `You are Tryora's furniture room assistant for exactly one authenticated Shopify merchant.
Use the verified store-context tool before every factual answer. Never invent a product, option, colour, size, price, image, stock state, preview eligibility, or policy. A variant is available only when the tool returns it. Treat each candidateId as an exact Shopify product/variant/configuration. Never replace it with a similar candidate. Recommend at most three candidates, and only candidateIds returned by the tool. If exact dimensions are needed, ask the shopper for them. If no verified match exists, say so plainly. When a room photo is supplied, describe only broad visible colours, style and lighting; do not identify people or infer sensitive traits. Explain that opening a recommendation lets the shopper verify options on the product page before previewing. Keep the answer concise and useful.`;
  const signal = AbortSignal.timeout(ASSISTANT_TIMEOUT_MS);
  let first: any;
  try {
    first = await client.responses.create({
      model,
      instructions,
      input: conversation,
      tools: [STORE_CONTEXT_TOOL],
      tool_choice: "required",
      parallel_tool_calls: false,
      store: false,
      max_output_tokens: 700,
    } as any, { signal, timeout: ASSISTANT_TIMEOUT_MS, maxRetries: 0 });
  } catch {
    throw new TryoraError("PROVIDER_UNAVAILABLE");
  }
  const runningInput: any[] = [...conversation, ...first.output];
  const returned = new Map<string, AssistantCandidate>();
  for (const item of first.output ?? []) {
    if (item.type !== "function_call" || item.name !== STORE_CONTEXT_TOOL.name) continue;
    let args: { query: string; size: string | null; colour: string | null; style: string | null; maxResults: number };
    try { args = JSON.parse(item.arguments); }
    catch { throw new TryoraError("PROVIDER_UNAVAILABLE"); }
    const matches = searchAssistantCatalogue(candidates, args, input.currentProductId);
    matches.forEach((candidate) => returned.set(candidate.id, candidate));
    runningInput.push({
      type: "function_call_output",
      call_id: item.call_id,
      output: JSON.stringify({ products: matches.map(toolCandidate), policies }),
    });
  }
  if (!returned.size && !(first.output ?? []).some((item: any) => item.type === "function_call")) {
    throw new TryoraError("PROVIDER_UNAVAILABLE");
  }
  let final: any;
  try {
    final = await client.responses.create({
      model,
      instructions,
      input: runningInput,
      tools: [STORE_CONTEXT_TOOL],
      tool_choice: "none",
      store: false,
      max_output_tokens: 900,
      text: { format: { type: "json_schema", name: "tryora_room_assistant", strict: true, schema: RESPONSE_SCHEMA } },
    } as any, { signal, timeout: ASSISTANT_TIMEOUT_MS, maxRetries: 0 });
  } catch {
    throw new TryoraError("PROVIDER_UNAVAILABLE");
  }
  const parsed = parseModelOutput(final.output_text ?? "");
  const recommendations: AssistantRecommendation[] = [];
  for (const recommendation of parsed.recommendations.slice(0, 3)) {
    const candidate = returned.get(recommendation.candidateId);
    const config = candidate && configs.get(candidate.productId);
    if (!candidate || !config || !candidate.previewAvailable || recommendations.some((entry) => entry.id === candidate.id)) continue;
    try {
      await resolvePreviewProduct(input.admin, config, candidate.optionValue, candidate.variantId);
      recommendations.push({ ...candidate, reason: String(recommendation.reason ?? "").trim().slice(0, 300) });
    } catch {
      // A stale or incomplete reference is excluded instead of being substituted.
    }
  }
  return {
    message: parsed.message.trim().slice(0, 1600),
    room: parsed.room,
    recommendations,
    model,
  };
}

export async function requireAssistantEnabled(shopId: string): Promise<RoomAssistantSettings> {
  const appearance = await prisma.appearance.findFirst({ where: { shopId, scope: "store", scopeId: null } });
  const settings = roomAssistantSettings(appearance?.copy);
  if (!settings.enabled || !assistantProviderReady()) throw new TryoraError("PROVIDER_UNAVAILABLE");
  return settings;
}
