/**
 * Merchant-scoped Shopify catalogue for the Room Assistant.
 *
 * - Every active product published to the Online Store is discoverable, whether or not Tryora previews are set up.
 * - A per-shop search index is cached briefly in memory and refreshed in the background. Cache entries are keyed
 *   and re-checked by shop, so one merchant's catalogue can never answer another merchant's shopper.
 * - The index holds a bounded variant sample per product. Anything actionable (price, stock, exact variant) is read
 *   fresh from Shopify with getProductDetails before it is shown to a shopper.
 */
import { TryoraError } from "../core/index";
import type { AdminGraphql } from "../preview-product.server";
import {
  buildIndex,
  CATEGORY_TERMS,
  containsMeaning,
  expandQuery,
  meaningTokens,
  normaliseText,
  sameMeaning,
  scoreIndex,
  tokens,
  type SearchIndex,
} from "./text";
import { errorShape, logAssistant } from "./log.server";

/**
 * Shopify rejects any query whose requested cost exceeds 1,000 (MAX_COST_EXCEEDED) before running it. The index page
 * is sized well below that: 15 products x (5-variant sample without images, 4 collections, 10 metafields...) ~ 590.
 * The previous page (20 products x 20 variants with images, requested cost 1,782) made every catalogue and
 * live-search request fail on real stores. test/assistant-catalogue.test.ts enforces the budget.
 */
export const CATALOGUE_PAGE_SIZE = 15;
export const MAX_INDEXED_PRODUCTS = 600;
const INDEX_VARIANTS = 5;
const DETAIL_VARIANT_PAGE = 100;
const MAX_DETAIL_VARIANTS = 500;
const FRESH_MS = 5 * 60_000;
const STALE_MS = 30 * 60_000;
const MAX_CACHED_SHOPS = 100;
const THROTTLE_RETRY_MS = 1_000;

/** Merchant-authored product attributes the assistant may quote. Only these exact metafields are read. */
export const ATTRIBUTE_METAFIELDS: [alias: string, namespace: string, key: string][] = [
  ["dimensions", "custom", "dimensions"],
  ["width", "custom", "width"],
  ["depth", "custom", "depth"],
  ["height", "custom", "height"],
  ["material", "custom", "material"],
  ["materials", "custom", "materials"],
  ["fabric", "custom", "fabric"],
  ["care", "custom", "care_instructions"],
  ["assembly", "custom", "assembly"],
  ["warranty", "custom", "warranty"],
];

const PRODUCT_FIELDS = `
  id title handle productType vendor tags onlineStoreUrl publishedAt status
  description(truncateAt: 1500)
  category { fullName }
  featuredMedia { preview { image { url(transform: { maxWidth: 800, maxHeight: 800 }) altText } } }
  priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
  variantsCount { count }
  options { name optionValues { name } }
  collections(first: 4) { nodes { title handle } }
  ${ATTRIBUTE_METAFIELDS.map(([alias, namespace, key]) => `${alias}: metafield(namespace: "${namespace}", key: "${key}") { value }`).join("\n  ")}`;

const VARIANT_FIELDS = `id title availableForSale price compareAtPrice image { url(transform: { maxWidth: 800, maxHeight: 800 }) altText } selectedOptions { name value }`;
/** The index samples variants without images; exact variants and images come from PRODUCT_DETAIL_QUERY. */
const INDEX_VARIANT_FIELDS = `id title availableForSale price compareAtPrice selectedOptions { name value }`;

export const CATALOGUE_QUERY = `#graphql
  query TryoraAssistantCatalogue($after: String, $query: String, $sortKey: ProductSortKeys) {
    products(first: ${CATALOGUE_PAGE_SIZE}, after: $after, query: $query, sortKey: $sortKey) {
      nodes { ${PRODUCT_FIELDS}
        variants(first: ${INDEX_VARIANTS}) { nodes { ${INDEX_VARIANT_FIELDS} } pageInfo { hasNextPage } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

/** Authoritative count of active products matching a Shopify search query. */
export const PRODUCT_COUNT_QUERY = `#graphql
  query TryoraAssistantCount($query: String) {
    productsCount(query: $query, limit: null) { count precision }
  }`;

/** Detail reads also carry Shopify's own option swatches (colour or image) for the chat option selector. */
const DETAIL_PRODUCT_FIELDS = PRODUCT_FIELDS.replace(
  "options { name optionValues { name } }",
  "options { name optionValues { name swatch { color image { image { url(transform: { maxWidth: 96, maxHeight: 96 }) } } } } }",
);

export const PRODUCT_DETAIL_QUERY = `#graphql
  query TryoraAssistantProductDetail($id: ID!, $after: String) {
    product(id: $id) { ${DETAIL_PRODUCT_FIELDS}
      variants(first: ${DETAIL_VARIANT_PAGE}, after: $after) { nodes { ${VARIANT_FIELDS} } pageInfo { hasNextPage endCursor } }
    }
  }`;

export interface CatalogueVariant {
  id: string;
  ref: string;
  title: string;
  options: Record<string, string>;
  price: string;
  compareAtPrice: string | null;
  available: boolean;
  /** This exact variant's own Shopify image, when the merchant assigned one. Never a product-level fallback. */
  image: string | null;
  imageAlt: string | null;
}

export interface CatalogueProduct {
  id: string;
  ref: string;
  title: string;
  handle: string;
  url: string;
  productType: string;
  vendor: string;
  category: string | null;
  tags: string[];
  description: string;
  /** The product's featured media image (Shopify CDN). Represents the product, not any particular variant. */
  image: string | null;
  imageAlt: string | null;
  currencyCode: string;
  minPrice: number;
  maxPrice: number;
  options: { name: string; values: string[]; swatches?: Record<string, { colour: string | null; image: string | null }> }[];
  collections: { title: string; handle: string }[];
  attributes: Record<string, string>;
  variantCount: number;
  variants: CatalogueVariant[];
  /** False when only a sample of variants was loaded; read details before quoting a specific variant. */
  variantsComplete: boolean;
  /** Canonical furniture-kind tokens from title, type, category, tags and collections. */
  kinds: Set<string>;
  /** Whole-meaning tokens of title, tags and attributes: product-wide facts such as "velvet". */
  traitTokens: Set<string>;
  /** traitTokens plus the description, for soft constraint checks. */
  textTokens: Set<string>;
}

export interface CatalogueSnapshot {
  shopId: string;
  products: CatalogueProduct[];
  byRef: Map<string, CatalogueProduct>;
  index: SearchIndex<CatalogueProduct>;
  loadedAt: number;
  /** False when the store has more than MAX_INDEXED_PRODUCTS products or loading stopped early. */
  complete: boolean;
  shopifyCalls: number;
  durationMs: number;
}

/** Per-request ceiling on Shopify calls made on behalf of the model. */
export class ShopifyBudget {
  calls = 0;
  constructor(readonly max = 12) {}
  spend() {
    if (this.calls >= this.max) throw new TryoraError("PROVIDER_UNAVAILABLE", "Shopify budget exhausted");
    this.calls += 1;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shopify's machine-readable error code (MAX_COST_EXCEEDED, ACCESS_DENIED...), never the message text. */
export function shopifyErrorCode(json: any): string | undefined {
  const code = Array.isArray(json?.errors) ? json.errors.map((entry: any) => entry?.extensions?.code).find((value: unknown) => typeof value === "string") : undefined;
  return typeof code === "string" && /^[A-Z_]{2,40}$/.test(code) ? code : undefined;
}

export async function adminQuery(admin: AdminGraphql, query: string, variables: Record<string, unknown>, stage: string, budget?: ShopifyBudget): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    budget?.spend();
    let response: Response;
    let json: any;
    try {
      response = await admin.graphql(query, { variables });
      json = await response.json();
    } catch (error) {
      // The Shopify library throws GraphqlQueryError with the response body attached.
      const body = (error as any)?.body ?? (error as any)?.response?.body;
      logAssistant("shopify_failure", { stage, ...errorShape(error), code: shopifyErrorCode(body) ?? errorShape(error).code });
      throw new TryoraError("PROVIDER_UNAVAILABLE");
    }
    const throttled = Array.isArray(json?.errors) && json.errors.some((entry: any) => entry?.extensions?.code === "THROTTLED");
    if (throttled && attempt === 0) {
      await sleep(THROTTLE_RETRY_MS);
      continue;
    }
    if (!response.ok || json?.errors?.length || !json?.data) {
      logAssistant("shopify_failure", {
        stage,
        status: response.status,
        code: throttled ? "THROTTLED" : shopifyErrorCode(json) ?? "GRAPHQL_ERROR",
        reason: typeof json?.extensions?.cost?.requestedQueryCost === "number" ? `requested_cost_${json.extensions.cost.requestedQueryCost}` : undefined,
      });
      throw new TryoraError("PROVIDER_UNAVAILABLE");
    }
    return json.data;
  }
  throw new TryoraError("PROVIDER_UNAVAILABLE");
}

export const numericRef = (gid: string) => gid.split("/").pop() ?? "";
export const productGid = (ref: string) => `gid://shopify/Product/${ref}`;
export const isRef = (value: unknown): value is string => typeof value === "string" && /^\d{1,20}$/.test(value);

function attributeValue(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let value: unknown = raw;
  try { value = JSON.parse(raw); } catch { /* plain text metafield */ }
  const render = (entry: unknown): string => {
    if (entry && typeof entry === "object" && "value" in entry) {
      const measured = entry as { value: unknown; unit?: unknown };
      return `${measured.value}${measured.unit ? ` ${String(measured.unit).toLowerCase()}` : ""}`;
    }
    return typeof entry === "object" ? "" : String(entry);
  };
  const text = Array.isArray(value) ? value.map(render).filter(Boolean).join(", ") : render(value);
  const clean = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 300) : null;
}

/** Shopify's placeholder option for products without real choices ("Title: Default Title"). */
export const isDefaultTitleOption = (option: { name: string; values: string[] }) =>
  option.values.length === 1 && option.values[0] === "Default Title";

/** Real, shopper-meaningful options only; never the artificial "Default Title". */
export const realOptions = <T extends { name: string; values: string[] }>(options: T[]) => options.filter((option) => !isDefaultTitleOption(option));

/** A variant's options without the placeholder "Title: Default Title". */
export const realVariantOptions = (options: Record<string, string>) =>
  Object.fromEntries(Object.entries(options).filter(([name, value]) => !(name === "Title" && value === "Default Title")));

/** Shopify handles are lowercase letters, digits, hyphens (and occasionally underscores or unicode letters). */
const validHandle = (value: unknown): value is string => typeof value === "string" && /^[\p{L}\p{N}_-]{1,255}$/u.test(value);

/** Only absolute https image URLs from Shopify are passed on to shoppers. */
export function imageUrl(value: unknown): string | null {
  return typeof value === "string" && /^https:\/\/[^\s"'<>]+$/i.test(value) ? value : null;
}
const altText = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null;

function parseVariant(node: any): CatalogueVariant | null {
  if (typeof node?.id !== "string") return null;
  return {
    id: node.id,
    ref: numericRef(node.id),
    title: String(node.title ?? ""),
    options: Object.fromEntries((node.selectedOptions ?? []).map((option: any) => [String(option.name), String(option.value)])),
    price: String(node.price ?? "0"),
    compareAtPrice: node.compareAtPrice ? String(node.compareAtPrice) : null,
    available: node.availableForSale === true,
    image: imageUrl(node.image?.url),
    imageAlt: altText(node.image?.altText),
  };
}

/**
 * Whether a product is published to the Online Store.
 *
 * `onlineStoreUrl` alone is not reliable: Shopify returns null for every product on a password-protected store
 * (common for development stores) even when the product is published. `publishedAt` is the Online Store publication
 * time, so a past timestamp counts as published; a future one is a scheduled publication and does not.
 */
export function publishedToOnlineStore(node: { onlineStoreUrl?: unknown; publishedAt?: unknown }, now = Date.now()): boolean {
  if (typeof node.onlineStoreUrl === "string" && node.onlineStoreUrl) return true;
  if (typeof node.publishedAt !== "string") return false;
  const published = Date.parse(node.publishedAt);
  return Number.isFinite(published) && published <= now;
}

/**
 * Parses an Admin product node. Returns null for drafts, archived products and products not published to the Online
 * Store. Links are always built from the handle as a relative storefront path, never from onlineStoreUrl, so they work
 * on password-protected and custom-domain stores alike.
 */
export function parseProduct(node: any, variantNodes: any[], variantsComplete: boolean): CatalogueProduct | null {
  if (typeof node?.id !== "string" || node.status !== "ACTIVE" || !publishedToOnlineStore(node) || !validHandle(node.handle)) return null;
  const variants = variantNodes.map(parseVariant).filter((variant): variant is CatalogueVariant => !!variant);
  const attributes: Record<string, string> = {};
  for (const [alias] of ATTRIBUTE_METAFIELDS) {
    const value = attributeValue(node[alias]?.value);
    if (value) attributes[alias] = value;
  }
  const collections = (node.collections?.nodes ?? []).map((entry: any) => ({ title: String(entry.title ?? ""), handle: String(entry.handle ?? "") }))
    .filter((entry: { title: string }) => entry.title);
  const tags = Array.isArray(node.tags) ? node.tags.map(String).slice(0, 30) : [];
  const category = node.category?.fullName ? String(node.category.fullName) : null;
  const productType = String(node.productType ?? "");
  const title = String(node.title ?? "");
  const variantCount = Number(node.variantsCount?.count ?? variants.length);
  return {
    id: node.id,
    ref: numericRef(node.id),
    title,
    handle: String(node.handle),
    url: `/products/${encodeURIComponent(String(node.handle))}`,
    productType,
    vendor: String(node.vendor ?? ""),
    category,
    tags,
    description: String(node.description ?? "").replace(/\s+/g, " ").trim(),
    image: imageUrl(node.featuredMedia?.preview?.image?.url),
    imageAlt: altText(node.featuredMedia?.preview?.image?.altText),
    currencyCode: String(node.priceRangeV2?.minVariantPrice?.currencyCode ?? "GBP"),
    minPrice: Number(node.priceRangeV2?.minVariantPrice?.amount ?? 0),
    maxPrice: Number(node.priceRangeV2?.maxVariantPrice?.amount ?? 0),
    options: (node.options ?? []).map((option: any) => {
      const values = (option.optionValues ?? []).map((value: any) => String(value.name));
      const swatches = Object.fromEntries((option.optionValues ?? [])
        .filter((value: any) => value?.swatch && (value.swatch.color || value.swatch.image?.image?.url))
        .map((value: any) => [String(value.name), {
          colour: typeof value.swatch.color === "string" && /^#[0-9a-f]{3,8}$/i.test(value.swatch.color) ? value.swatch.color : null,
          image: imageUrl(value.swatch.image?.image?.url),
        }]));
      return Object.keys(swatches).length ? { name: String(option.name), values, swatches } : { name: String(option.name), values };
    }),
    collections,
    attributes,
    variantCount,
    variants,
    variantsComplete: variantsComplete && variants.length >= variantCount,
    kinds: new Set(tokens([title, productType, category ?? "", ...tags, ...collections.map((entry: { title: string }) => entry.title)].join(" "))
      .filter((token) => CATEGORY_TERMS.has(token))),
    traitTokens: meaningTokens([title, ...tags, ...Object.values(attributes)].join(" ")),
    textTokens: meaningTokens([title, ...tags, ...Object.values(attributes), String(node.description ?? "")].join(" ")),
  };
}

function indexFields(product: CatalogueProduct) {
  return [
    { text: product.title, weight: 3 },
    { text: `${product.productType} ${product.category ?? ""}`, weight: 2.5 },
    { text: product.collections.map((entry) => entry.title).join(" "), weight: 2 },
    { text: product.options.flatMap((option) => option.values).join(" "), weight: 2 },
    { text: product.tags.join(" "), weight: 1.5 },
    { text: Object.values(product.attributes).join(" "), weight: 1.2 },
    { text: `${product.vendor} ${product.description}`, weight: 1 },
  ];
}

export function snapshotFrom(shopId: string, products: CatalogueProduct[], complete: boolean, shopifyCalls = 0, durationMs = 0, loadedAt = Date.now()): CatalogueSnapshot {
  return {
    shopId,
    products,
    byRef: new Map(products.map((product) => [product.ref, product])),
    index: buildIndex(products, indexFields),
    loadedAt,
    complete,
    shopifyCalls,
    durationMs,
  };
}

async function loadCatalogue(admin: AdminGraphql, shopId: string): Promise<CatalogueSnapshot> {
  const started = Date.now();
  const products: CatalogueProduct[] = [];
  let after: string | null = null;
  let calls = 0;
  let complete = true;
  for (;;) {
    let data: any;
    try {
      data = await adminQuery(admin, CATALOGUE_QUERY, { after, query: "status:active", sortKey: "ID" }, "catalogue_page");
      calls += 1;
    } catch (error) {
      // A partial index is still useful; live search covers the remainder for this request.
      if (!products.length) throw error;
      complete = false;
      break;
    }
    const page = data.products;
    for (const node of page?.nodes ?? []) {
      const product = parseProduct(node, node.variants?.nodes ?? [], node.variants?.pageInfo?.hasNextPage === false);
      if (product) products.push(product);
    }
    const next: string | null = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor ?? null : null;
    if (!next || next === after) break;
    if (products.length >= MAX_INDEXED_PRODUCTS) { complete = false; break; }
    after = next;
  }
  const durationMs = Date.now() - started;
  logAssistant("catalogue_loaded", { shop: shopId, products: products.length, complete, shopifyCalls: calls, durationMs }, "info");
  return snapshotFrom(shopId, products, complete, calls, durationMs);
}

interface CacheEntry {
  shopId: string;
  snapshot?: CatalogueSnapshot;
  loading?: Promise<CatalogueSnapshot>;
  generation: number;
}

const cache = new Map<string, CacheEntry>();
let now = () => Date.now();

/** Test hook: control time for TTL checks. */
export function setCatalogueClock(clock: () => number) { now = clock; }
export function resetAssistantCatalogueCache() { cache.clear(); now = () => Date.now(); }

/** Drops a shop's cached catalogue, e.g. after settings change or uninstall. In-flight loads are discarded. */
export function invalidateAssistantCatalogue(shopId: string) {
  const entry = cache.get(shopId);
  cache.delete(shopId);
  if (entry) entry.generation = -1;
}

function entryFor(shopId: string): CacheEntry {
  let entry = cache.get(shopId);
  if (!entry || entry.shopId !== shopId) {
    entry = { shopId, generation: 0 };
    cache.set(shopId, entry);
    while (cache.size > MAX_CACHED_SHOPS) cache.delete(cache.keys().next().value!);
  } else {
    // Refresh LRU order.
    cache.delete(shopId);
    cache.set(shopId, entry);
  }
  return entry;
}

function startLoad(admin: AdminGraphql, entry: CacheEntry): Promise<CatalogueSnapshot> {
  if (entry.loading) return entry.loading;
  const generation = ++entry.generation;
  const loading = loadCatalogue(admin, entry.shopId).then((snapshot) => {
    // An invalidated or superseded load must not repopulate the cache.
    if (entry.generation === generation && cache.get(entry.shopId) === entry && snapshot.shopId === entry.shopId) {
      entry.snapshot = { ...snapshot, loadedAt: now() };
    }
    return snapshot;
  }).finally(() => { if (entry.loading === loading) entry.loading = undefined; });
  entry.loading = loading;
  loading.catch(() => {});
  return loading;
}

export type CacheState = "hit" | "stale" | "miss" | "cold";

/**
 * Returns the shop's catalogue snapshot. A stale snapshot is served while it refreshes in the background. A cold
 * cache waits up to `waitMs`; if loading is still running, null is returned and callers fall back to live search.
 */
export async function getCatalogue(admin: AdminGraphql, shopId: string, waitMs: number): Promise<{ snapshot: CatalogueSnapshot | null; cache: CacheState }> {
  const entry = entryFor(shopId);
  const snapshot = entry.snapshot?.shopId === shopId ? entry.snapshot : undefined;
  const age = snapshot ? now() - snapshot.loadedAt : Infinity;
  if (snapshot && age < FRESH_MS) return { snapshot, cache: "hit" };
  if (snapshot && age < STALE_MS) {
    void startLoad(admin, entry);
    return { snapshot, cache: "stale" };
  }
  const loading = startLoad(admin, entry);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    loading.then((loaded) => loaded, () => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); }),
  ]);
  clearTimeout(timer);
  if (result && result.shopId === shopId) return { snapshot: result, cache: "miss" };
  return { snapshot: null, cache: "cold" };
}

/** Read-only view of a shop's cached index, for merchant diagnostics. */
export function catalogueCacheInfo(shopId: string) {
  const snapshot = cache.get(shopId)?.snapshot;
  return snapshot && snapshot.shopId === shopId
    ? { products: snapshot.products.length, complete: snapshot.complete, ageSeconds: Math.round((now() - snapshot.loadedAt) / 1000) }
    : null;
}

/** Starts loading a shop's catalogue without waiting, so the first shopper question is fast. */
export function warmAssistantCatalogue(admin: AdminGraphql, shopId: string) {
  const entry = entryFor(shopId);
  const snapshot = entry.snapshot;
  if (snapshot && now() - snapshot.loadedAt < FRESH_MS) return;
  void startLoad(admin, entry);
}

// ---------- search ----------

export interface ProductQuery {
  query: string;
  colour: string | null;
  size: string | null;
  material: string | null;
  style: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  availableOnly: boolean;
  limit: number;
}

export interface ProductMatch {
  product: CatalogueProduct;
  score: number;
  matchingVariants: CatalogueVariant[];
  /** Requested colour/size/material values not found on this product. */
  unmatched: string[];
}

function valueMatches(value: string, wanted: string) {
  return sameMeaning(value, wanted) || containsMeaning(value, wanted);
}

/** Variants satisfying every requested option and price constraint. Unknown when the variant list is a sample. */
export function variantsMatching(product: CatalogueProduct, query: Pick<ProductQuery, "colour" | "size" | "material" | "minPrice" | "maxPrice" | "availableOnly">) {
  const wanted = [query.colour, query.size, query.material].filter((value): value is string => !!value?.trim());
  return product.variants.filter((variant) => {
    const values = Object.values(variant.options);
    const price = Number(variant.price);
    return wanted.every((value) => values.some((option) => valueMatches(option, value)) ||
        // A product-wide attribute (e.g. a velvet sofa without a fabric option) satisfies every variant.
        (!product.options.some((option) => option.values.some((entry) => valueMatches(entry, value))) &&
          containsMeaning(product.traitTokens, value))) &&
      (query.maxPrice === null || price <= query.maxPrice) &&
      (query.minPrice === null || price >= query.minPrice) &&
      (!query.availableOnly || variant.available);
  });
}

function productHas(product: CatalogueProduct, wanted: string) {
  return product.options.some((option) => option.values.some((value) => valueMatches(value, wanted))) ||
    containsMeaning(product.textTokens, wanted);
}

/**
 * Hybrid ranking over a shop's catalogue: synonym-normalised BM25 relevance, a required furniture kind when the
 * shopper names one, soft colour/size/material constraints and hard price and availability filters.
 */
export function searchCatalogue(snapshot: Pick<CatalogueSnapshot, "index">, query: ProductQuery, currentProductId?: string): ProductMatch[] {
  const text = [query.query, query.style, query.colour, query.material, query.size].filter(Boolean).join(" ");
  const terms = expandQuery(text);
  const kinds = terms.filter((term) => term.weight === 1 && CATEGORY_TERMS.has(term.term)).map((term) => term.term);
  const constraints = [query.colour, query.size, query.material].filter((value): value is string => !!value?.trim());
  const limit = Math.min(10, Math.max(1, Math.floor(query.limit || 6)));
  return scoreIndex(snapshot.index, terms)
    .filter(({ item, score }) => !terms.length || score > 0)
    .filter(({ item }) => !kinds.length || kinds.some((kind) => item.kinds.has(kind)))
    .filter(({ item }) => (query.maxPrice === null || item.minPrice <= query.maxPrice) && (query.minPrice === null || item.maxPrice >= query.minPrice))
    .map(({ item, score }) => {
      const matchingVariants = variantsMatching(item, query);
      const unmatched = constraints.filter((value) => !productHas(item, value));
      let adjusted = score * Math.pow(0.35, unmatched.length);
      if (item.id === currentProductId) adjusted += 0.5;
      if (matchingVariants.some((variant) => variant.available)) adjusted *= 1.15;
      return { product: item, score: adjusted, matchingVariants, unmatched };
    })
    // A sold-out product is only excluded when every variant is known to be unavailable.
    .filter((match) => !query.availableOnly || !match.product.variantsComplete || match.product.variants.some((variant) => variant.available))
    // A fully loaded product with no variant inside the price range cannot meet a budget.
    .filter((match) => (query.maxPrice === null && query.minPrice === null) || !match.product.variantsComplete ||
      variantsMatching(match.product, { ...query, colour: null, size: null, material: null }).length > 0)
    .sort((a, b) => b.score - a.score || a.product.title.localeCompare(b.product.title))
    .slice(0, limit);
}

/** Every indexed product matching the query's furniture kind, terms, colour and material (no limit). For counting. */
export function countCatalogue(snapshot: Pick<CatalogueSnapshot, "index">, query: Pick<ProductQuery, "query" | "colour" | "material">) {
  const terms = expandQuery([query.query, query.colour, query.material].filter(Boolean).join(" "));
  const kinds = terms.filter((term) => term.weight === 1 && CATEGORY_TERMS.has(term.term)).map((term) => term.term);
  const constraints = [query.colour, query.material].filter((value): value is string => !!value?.trim());
  return scoreIndex(snapshot.index, terms)
    .filter(({ score }) => !terms.length || score > 0)
    .filter(({ item }) => !kinds.length || kinds.some((kind) => item.kinds.has(kind)))
    .filter(({ item }) => constraints.every((value) => productHas(item, value)))
    .map(({ item }) => item);
}

const STOP_SEARCH = new Set(["the", "and", "for", "any", "you", "have", "with", "your", "how", "many", "what", "does", "store", "products", "product", "do", "sell", "items"]);

/** Shopify search words for a shopper query, including canonical synonyms ("couch" also searches "sofa"). */
export function shopifySearchWords(text: string) {
  return [...new Set([
    ...normaliseText(text).split(" "),
    ...expandQuery(text).filter((term) => term.weight === 1).map((term) => term.term),
  ])].filter((word) => SEARCH_WORD.test(word) && !/^\d+$/.test(word) && !STOP_SEARCH.has(word)).slice(0, 10);
}

const SEARCH_WORD = /^[a-z0-9]{2,30}$/;

/** Shopify-side search used when the cached index is cold or incomplete. */
export async function liveSearch(admin: AdminGraphql, shopId: string, query: ProductQuery, budget: ShopifyBudget): Promise<CatalogueSnapshot> {
  const words = shopifySearchWords([query.query, query.colour, query.material].filter(Boolean).join(" "));
  const search = words.length ? `status:active AND (${words.join(" OR ")})` : "status:active";
  const data = await adminQuery(admin, CATALOGUE_QUERY, { after: null, query: search, sortKey: "RELEVANCE" }, "live_search", budget);
  const products = (data.products?.nodes ?? [])
    .map((node: any) => parseProduct(node, node.variants?.nodes ?? [], node.variants?.pageInfo?.hasNextPage === false))
    .filter((product: CatalogueProduct | null): product is CatalogueProduct => !!product);
  return snapshotFrom(shopId, products, false, 1);
}

/** Fresh, complete product data (all variants up to a bound) for exact answers and recommendations. */
export async function getProductDetails(admin: AdminGraphql, refs: string[], budget: ShopifyBudget): Promise<Map<string, CatalogueProduct>> {
  const result = new Map<string, CatalogueProduct>();
  const unique = [...new Set(refs.filter(isRef))].slice(0, 3);
  await Promise.all(unique.map(async (ref) => {
    let node: any = null;
    const variants: any[] = [];
    let after: string | null = null;
    let complete = true;
    do {
      const data = await adminQuery(admin, PRODUCT_DETAIL_QUERY, { id: productGid(ref), after }, "product_detail", budget);
      if (!data.product) return;
      node = data.product;
      variants.push(...(node.variants?.nodes ?? []));
      const page = node.variants?.pageInfo;
      const next: string | null = page?.hasNextPage ? page.endCursor ?? null : null;
      if (next && (next === after || variants.length >= MAX_DETAIL_VARIANTS)) { complete = !next; break; }
      after = next;
    } while (after);
    const product = parseProduct(node, variants, complete);
    if (product && product.ref === ref) result.set(ref, product);
  }));
  return result;
}
