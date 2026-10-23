/**
 * A simulated Shopify Admin GraphQL endpoint for Room Assistant tests: realistic furniture catalogues, cursor
 * pagination, product search, variant paging, shop policies, optional latency and per-query call counts.
 */

export interface FixtureVariant {
  id: string;
  title: string;
  availableForSale: boolean;
  price: string;
  compareAtPrice: string | null;
  image: { url: string } | null;
  selectedOptions: { name: string; value: string }[];
}

export interface FixtureProduct {
  id: string;
  title: string;
  handle: string;
  productType: string;
  vendor: string;
  tags: string[];
  onlineStoreUrl: string | null;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  description: string;
  category: { fullName: string } | null;
  featuredMedia: { preview: { image: { url: string } } } | null;
  options: { name: string; optionValues: { name: string }[] }[];
  collections: { nodes: { title: string; handle: string }[] };
  metafields: Record<string, string>;
  variants: FixtureVariant[];
}

let nextId = 1000;

export function fixtureProduct(input: {
  title: string;
  productType: string;
  options: Record<string, string[]>;
  price?: number | ((options: Record<string, string>) => number);
  available?: (options: Record<string, string>) => boolean;
  tags?: string[];
  collections?: string[];
  description?: string;
  metafields?: Record<string, string>;
  published?: boolean;
  status?: FixtureProduct["status"];
  id?: number;
  category?: string;
}): FixtureProduct {
  const id = input.id ?? nextId++;
  const handle = input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + `-${id}`;
  const names = Object.keys(input.options);
  const combos: Record<string, string>[] = names.reduce<Record<string, string>[]>(
    (all, name) => all.flatMap((combo) => input.options[name]!.map((value) => ({ ...combo, [name]: value }))),
    [{}],
  );
  const variants = combos.map((options, index) => {
    const price = typeof input.price === "function" ? input.price(options) : input.price ?? 499;
    return {
      id: `gid://shopify/ProductVariant/${id}${String(index).padStart(3, "0")}`,
      title: Object.values(options).join(" / "),
      availableForSale: input.available ? input.available(options) : true,
      price: price.toFixed(2),
      compareAtPrice: null,
      image: { url: `https://cdn.shopify.com/${handle}-${index}.jpg` },
      selectedOptions: names.map((name) => ({ name, value: options[name]! })),
    };
  });
  return {
    id: `gid://shopify/Product/${id}`,
    title: input.title,
    handle,
    productType: input.productType,
    vendor: "Demo Furniture",
    tags: input.tags ?? [],
    onlineStoreUrl: input.published === false ? null : `https://demo.example/products/${handle}`,
    status: input.status ?? "ACTIVE",
    description: input.description ?? `${input.title}. A ${input.productType.toLowerCase()} for modern homes.`,
    category: { fullName: input.category ?? `Home & Garden > Furniture > ${input.productType}` },
    featuredMedia: { preview: { image: { url: `https://cdn.shopify.com/${handle}.jpg` } } },
    options: names.map((name) => ({ name, optionValues: input.options[name]!.map((value) => ({ name: value })) })),
    collections: { nodes: (input.collections ?? [input.productType + "s"]).map((title) => ({ title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-") })) },
    metafields: input.metafields ?? {},
    variants,
  };
}

const KINDS: [title: string, type: string, sizes: string[]][] = [
  ["Bed", "Bed", ["Single", "Double", "King", "Super King"]],
  ["Sofa", "Sofa", ["2 Seater", "3 Seater"]],
  ["Armchair", "Armchair", ["Standard"]],
  ["Wardrobe", "Wardrobe", ["2 Door", "3 Door"]],
  ["Coffee Table", "Table", ["Standard"]],
  ["Rug", "Rug", ["120x170cm", "160x230cm"]],
];
const COLOURS = ["Grey", "Cream", "Navy", "Sage Green", "Charcoal", "Oatmeal", "Blush Pink", "Black"];
const MATERIALS = ["Plush Velvet", "Boucle", "Linen", "Faux Leather", "Oak"];
const NAMES = ["Aria", "Oslo", "Milan", "Hampton", "Luna", "Aspen", "Nova", "Ember", "Willow", "Harper", "Kensington", "Belmont"];

/** A deterministic catalogue of `count` furniture products with 3 colours × N sizes each. */
export function furnitureCatalogue(count: number): FixtureProduct[] {
  return Array.from({ length: count }, (_, i) => {
    const [kind, type, sizes] = KINDS[i % KINDS.length]!;
    const material = MATERIALS[i % MATERIALS.length]!;
    const colours = [COLOURS[i % COLOURS.length]!, COLOURS[(i + 3) % COLOURS.length]!, COLOURS[(i + 5) % COLOURS.length]!];
    const base = 150 + (i * 37) % 900;
    return fixtureProduct({
      id: 50_000 + i,
      title: `${NAMES[i % NAMES.length]} ${material} ${kind} ${i}`,
      productType: type,
      options: { Colour: colours, Size: sizes },
      price: (options) => base + sizes.indexOf(options.Size!) * 100,
      available: (options) => (i + colours.indexOf(options.Colour!)) % 4 !== 0,
      tags: [material.toLowerCase(), kind.toLowerCase()],
    });
  });
}

function productNode(product: FixtureProduct, variants: FixtureVariant[], hasNextPage: boolean, endCursor: string | null) {
  const prices = product.variants.map((variant) => Number(variant.price));
  const { metafields, variants: _all, ...rest } = product;
  const aliases = Object.fromEntries(["dimensions", "width", "depth", "height", "material", "materials", "fabric", "care", "assembly", "warranty"]
    .map((alias) => [alias, metafields[alias] ? { value: metafields[alias] } : null]));
  return {
    ...rest,
    ...aliases,
    priceRangeV2: {
      minVariantPrice: { amount: String(Math.min(...prices)), currencyCode: "GBP" },
      maxVariantPrice: { amount: String(Math.max(...prices)), currencyCode: "GBP" },
    },
    variantsCount: { count: product.variants.length },
    variants: { nodes: variants, pageInfo: { hasNextPage, endCursor } },
  };
}

export interface FixtureShop {
  name?: string;
  contactEmail?: string;
  policies?: { type: string; title: string; url: string; body: string }[];
  pages?: { title: string; handle: string; body: string; isPublished: boolean }[] | "denied";
}

/** Shopify-like search: any OR'd word appearing in title, type, tags or option values. */
function shopifySearch(products: FixtureProduct[], query: string, relevance: boolean) {
  const words = query.replace(/^status:active( AND )?/, "").replace(/[()]/g, " ").split(/\s+OR\s+|\s+/).map((word) => word.trim().toLowerCase()).filter(Boolean);
  if (!words.length) return products;
  const scored = products.map((product) => {
    const text = [product.title, product.productType, ...product.tags, ...product.options.flatMap((option) => option.optionValues.map((value) => value.name))].join(" ").toLowerCase();
    return { product, hits: words.filter((word) => text.includes(word)).length };
  }).filter((entry) => entry.hits > 0);
  if (relevance) scored.sort((a, b) => b.hits - a.hits);
  return scored.map((entry) => entry.product);
}

export function fixtureAdmin(products: FixtureProduct[], shop: FixtureShop = {}, options: { latencyMs?: number; throttleFirst?: boolean; fail?: (query: string) => boolean } = {}) {
  const calls: Record<string, number> = {};
  let throttled = !options.throttleFirst;
  const graphql = async (query: string, init?: { variables?: Record<string, unknown> }) => {
    const name = query.match(/query (\w+)/)?.[1] ?? "unknown";
    calls[name] = (calls[name] ?? 0) + 1;
    if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
    if (options.fail?.(name)) return Response.json({ errors: [{ message: "Internal error" }] }, { status: 500 });
    if (!throttled) {
      throttled = true;
      return Response.json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] });
    }
    const vars = init?.variables ?? {};
    const visible = products.filter((product) => product.status === "ACTIVE");
    if (name === "TryoraAssistantCatalogue") {
      const pool = shopifySearch(visible, String(vars.query ?? "status:active"), vars.sortKey === "RELEVANCE");
      const start = vars.after ? Number(vars.after) : 0;
      const page = pool.slice(start, start + 20);
      const next = start + 20 < pool.length ? String(start + 20) : null;
      return Response.json({ data: { products: {
        nodes: page.map((product) => productNode(product, product.variants.slice(0, 20), product.variants.length > 20, null)),
        pageInfo: { hasNextPage: !!next, endCursor: next },
      } } });
    }
    if (name === "TryoraAssistantProductDetail") {
      const product = products.find((entry) => entry.id === vars.id);
      if (!product) return Response.json({ data: { product: null } });
      const start = vars.after ? Number(vars.after) : 0;
      const next = start + 100 < product.variants.length ? String(start + 100) : null;
      return Response.json({ data: { product: productNode(product, product.variants.slice(start, start + 100), !!next, next) } });
    }
    if (name === "TryoraAssistantStoreInfo") {
      return Response.json({ data: { shop: {
        name: shop.name ?? "Demo Furniture", contactEmail: shop.contactEmail ?? "hello@demo.example",
        primaryDomain: { url: "https://demo.example" }, shopPolicies: shop.policies ?? [],
      } } });
    }
    if (name === "TryoraAssistantPages") {
      if (!shop.pages || shop.pages === "denied") return Response.json({ errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }] });
      return Response.json({ data: { pages: { nodes: shop.pages } } });
    }
    if (name === "TryoraPreviewProduct") {
      const product = products.find((entry) => entry.id === vars.id);
      if (!product) return Response.json({ data: { product: null } });
      return Response.json({ data: { product: {
        id: product.id, title: product.title, description: product.description, productType: product.productType,
        options: product.options.map((option, index) => ({ id: `option-${index}`, name: option.name, optionValues: option.optionValues.map((value, i) => ({ id: `value-${index}-${i}`, name: value.name })) })),
        variants: { nodes: product.variants.map((variant) => ({ id: variant.id, availableForSale: variant.availableForSale, image: variant.image, selectedOptions: variant.selectedOptions })), pageInfo: { hasNextPage: false, endCursor: null } },
      } } });
    }
    throw new Error(`Unexpected query: ${name}`);
  };
  return { graphql, calls, totalCalls: () => Object.values(calls).reduce((sum, count) => sum + count, 0) };
}

/** A model stub that replays scripted Responses API outputs and records every request. */
export function scriptedModel(steps: (Record<string, unknown> | ((request: any) => Record<string, unknown>) | Error)[]) {
  const requests: any[] = [];
  const create = async (request: any) => {
    requests.push(JSON.parse(JSON.stringify(request)));
    const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(request) : step;
  };
  return { client: { responses: { create } } as any, requests };
}

export const toolCall = (name: string, args: Record<string, unknown>, id = `call-${name}`) => ({
  output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }],
});

export const finalAnswer = (message: string, recommendations: { productRef: string; variantRef: string | null; reason: string }[] = [], room: unknown = null) => ({
  output: [],
  output_text: JSON.stringify({ message, room, recommendations }),
  usage: { input_tokens: 1200, output_tokens: 150 },
});

export const ref = (gid: string) => gid.split("/").pop()!;

/** Parses the outputs the server returned to the model for one tool call name. */
export function toolOutputs(requests: any[], callId: string) {
  const last = requests.at(-1);
  return (last?.input ?? []).filter((item: any) => item.type === "function_call_output" && item.call_id === callId).map((item: any) => JSON.parse(item.output));
}
