import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "./db.server";
import { defaultPlacement, resolveSwatches, type Placement, type ResolvedSwatch } from "./core/index";
import { photoColour } from "./photoColour.server";

export interface ShopProduct {
  id: string;
  title: string;
  productType: string;
  status: string;
  image?: string;
  options: { name: string; values: string[]; swatches: { value: string; colour: string | null; image: string | null; /** tiny PNG of this value's own variant photo */ photo: string | null }[] }[];
  media: { id: string; url: string; alt?: string }[];
}

export type Readiness = "off" | "ready" | "needs_attention";

export interface ProductRow extends ShopProduct {
  enabled: boolean;
  readiness: Readiness;
  readinessReason?: string;
  itemNoun: string;
  placement: Placement;
  setting: "indoor" | "outdoor" | "either";
  visualOptionName: string | null;
  referenceMediaId: string | null;
  swatchColours: Record<string, string>;
  /** Store-wide approval to fill missing swatches from variant photos and colour names. */
  swatchAutoFill: boolean;
  /** Swatch for each value of the chosen option, and where it comes from. Empty for single-style products. */
  resolvedSwatches: ResolvedSwatch[];
  /** Shown in the admin when some colours fall back to name labels. */
  swatchNote?: string;
}

const PRODUCT_FIELDS = `#graphql
  fragment TryoraProduct on Product {
    id
    title
    productType
    status
    featuredMedia { preview { image { url } } }
    options { name optionValues { name swatch { color image { image { url(transform: { maxWidth: 160, maxHeight: 160 }) } } } } }
    media(first: 20) { nodes { id alt ... on MediaImage { image { url } } } }
    tinyFeatured: featuredMedia { preview { image { url(transform: { maxWidth: 24, maxHeight: 24, crop: CENTER, preferredContentType: PNG }) } } }
    variants(first: 100) { nodes { selectedOptions { name value } image { url(transform: { maxWidth: 24, maxHeight: 24, crop: CENTER, preferredContentType: PNG }) } } }
  }`;

/** This value's own variant photo, if it has one that isn't simply the main product photo. */
function variantPhoto(p: any, optionName: string, value: string): string | null {
  const featured = p.tinyFeatured?.preview?.image?.url;
  const v = (p.variants?.nodes ?? []).find(
    (n: any) => n.image?.url && n.selectedOptions.some((s: any) => s.name === optionName && s.value === value),
  );
  const url: string | undefined = v?.image?.url;
  return url && url !== featured ? url : null;
}

function mapProduct(p: any): ShopProduct {
  return {
    id: p.id,
    title: p.title,
    productType: p.productType ?? "",
    status: p.status,
    image: p.featuredMedia?.preview?.image?.url,
    options: (p.options ?? [])
      .filter((o: any) => !(o.name === "Title" && o.optionValues?.length === 1 && o.optionValues[0].name === "Default Title"))
      .map((o: any) => ({
        name: o.name,
        values: (o.optionValues ?? []).map((v: any) => v.name),
        swatches: (o.optionValues ?? []).map((v: any) => ({
          value: v.name,
          colour: v.swatch?.color ?? null,
          image: v.swatch?.image?.image?.url ?? null,
          photo: variantPhoto(p, o.name, v.name),
        })),
      })),
    media: (p.media?.nodes ?? [])
      .filter((m: any) => m.image?.url)
      .map((m: any) => ({ id: m.id, url: m.image.url, alt: m.alt ?? undefined })),
  };
}

export async function listShopProducts(admin: AdminApiContext): Promise<ShopProduct[]> {
  const res = await admin.graphql(
    `#graphql
    ${PRODUCT_FIELDS}
    query TryoraProducts { products(first: 100, sortKey: TITLE) { nodes { ...TryoraProduct } } }`,
  );
  const json: any = await res.json();
  return (json.data?.products?.nodes ?? []).map(mapProduct);
}

export async function getShopProduct(admin: AdminApiContext, id: string): Promise<ShopProduct | null> {
  const res = await admin.graphql(
    `#graphql
    ${PRODUCT_FIELDS}
    query TryoraProduct($id: ID!) { product(id: $id) { ...TryoraProduct } }`,
    { variables: { id } },
  );
  const json: any = await res.json();
  return json.data?.product ? mapProduct(json.data.product) : null;
}

/** Default shopper-facing word from the Shopify product type, e.g. "Sofas" -> "sofa". */
export function defaultNoun(productType: string, title: string): string {
  const base = (productType || title.split(" ").slice(-1)[0] || "item").trim().toLowerCase();
  if (base.endsWith("ies")) return base.slice(0, -3) + "y"; // accessories -> accessory
  if (/(ch|sh|x)es$/.test(base)) return base.slice(0, -2); // benches -> bench
  return base.endsWith("s") && !base.endsWith("ss") ? base.slice(0, -1) : base;
}

type PhotoCache = Record<string, { url: string; colour: string | null }>;

/** Swatches for the chosen option. A product with one colour (or none) has no swatches: its own photos are used. */
export function swatchesFor(
  p: ShopProduct,
  optionName: string | null,
  colours: Record<string, string>,
  autoFill: boolean,
  cache: PhotoCache = {},
): ResolvedSwatch[] {
  const option = optionName ? p.options.find((o) => o.name === optionName) : undefined;
  if (!option || option.values.length <= 1) return [];
  const photoColours: Record<string, string> = {};
  for (const s of option.swatches) {
    const hit = cache[s.value];
    if (s.photo && hit?.url === s.photo && hit.colour) photoColours[s.value] = hit.colour;
  }
  return resolveSwatches(
    option.swatches.map((s) => ({ value: s.value, shopifyColour: s.colour, shopifyImage: s.image })),
    colours,
    { approved: autoFill, photoColours },
  );
}

/** Reads colours from variant photos that aren't cached yet (only when the merchant approved auto-fill). */
export async function refreshPhotoColours(p: ShopProduct, optionName: string | null, cache: PhotoCache): Promise<PhotoCache | null> {
  const option = optionName ? p.options.find((o) => o.name === optionName) : undefined;
  if (!option) return null;
  const todo = option.swatches.filter((s) => !s.colour && !s.image && s.photo && cache[s.value]?.url !== s.photo);
  if (!todo.length) return null;
  const next = { ...cache };
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(
      todo.slice(i, i + 6).map(async (s) => {
        next[s.value] = { url: s.photo!, colour: await photoColour(s.photo!) };
      }),
    );
  }
  return next;
}

function swatchNoteFor(swatches: ResolvedSwatch[]): string | undefined {
  const missing = swatches.filter((s) => s.source === "missing").length;
  return missing ? `${missing} colour${missing === 1 ? " shows" : "s show"} as a name – add swatches` : undefined;
}

function readinessOf(enabled: boolean, referenceMediaId: string | null, p: ShopProduct): { readiness: Readiness; reason?: string } {
  if (!enabled) return { readiness: "off" };
  if (!p.media.length) return { readiness: "needs_attention", reason: "This product has no photos" };
  if (!referenceMediaId) return { readiness: "needs_attention", reason: "Choose a reference photo" };
  if (!p.media.some((m) => m.id === referenceMediaId)) return { readiness: "needs_attention", reason: "Reference photo was removed" };
  // Missing swatches don't block going live (owner, 19 Oct): those colours show as name labels and the admin flags them.
  return { readiness: "ready" };
}

export async function productRows(shopId: string, products: ShopProduct[]): Promise<ProductRow[]> {
  const [configs, shop] = await Promise.all([
    prisma.productPreviewConfig.findMany({ where: { shopId } }),
    prisma.shop.findUnique({ where: { id: shopId } }),
  ]);
  const swatchAutoFill = shop?.swatchAutoFill ?? false;
  const byId = new Map(configs.map((c) => [c.productId, c]));
  return products.map((p) => {
    const c = byId.get(p.id);
    const enabled = c?.enabled ?? false;
    const referenceMediaId = c?.referenceMediaId ?? null;
    const visualOptionName = c ? c.visualOptionName : (p.options.find((o) => /colou?r|fabric|finish/i.test(o.name))?.name ?? null);
    const swatchColours = (c?.swatchColours as Record<string, string>) ?? {};
    const resolvedSwatches = swatchesFor(p, visualOptionName, swatchColours, swatchAutoFill, (c?.photoColours as PhotoCache) ?? {});
    const r = readinessOf(enabled, referenceMediaId, p);
    return {
      ...p,
      enabled,
      readiness: r.readiness,
      readinessReason: r.reason,
      itemNoun: c?.itemNoun ?? defaultNoun(p.productType, p.title),
      placement: (c?.placement as Placement) ?? defaultPlacement(p.productType || p.title),
      setting: (c?.setting as ProductRow["setting"]) ?? "indoor",
      visualOptionName,
      referenceMediaId: referenceMediaId ?? p.media[0]?.id ?? null,
      swatchColours,
      swatchAutoFill,
      resolvedSwatches,
      swatchNote: enabled ? swatchNoteFor(resolvedSwatches) : undefined,
    };
  });
}

export async function saveProductConfig(
  shopId: string,
  product: ShopProduct,
  input: {
    enabled: boolean;
    itemNoun: string;
    placement: Placement;
    setting: "indoor" | "outdoor" | "either";
    visualOptionName: string | null;
    referenceMediaId: string | null;
    swatchColours: Record<string, string>;
  },
) {
  const r = readinessOf(input.enabled, input.referenceMediaId, product);
  const data = {
    enabled: input.enabled,
    itemNoun: input.itemNoun.trim() || defaultNoun(product.productType, product.title),
    placement: input.placement,
    setting: input.setting,
    visualOptionName: input.visualOptionName,
    visualOptionType: input.visualOptionName ? "colour" : null,
    referenceMediaId: input.referenceMediaId,
    swatchColours: input.swatchColours as object,
    readiness: r.readiness === "off" ? "needs_attention" : r.readiness,
    readinessReasons: r.reason ? [r.reason] : [],
    frozenContext: {},
  };
  await prisma.shop.upsert({ where: { id: shopId }, create: { id: shopId }, update: {} });
  await prisma.productPreviewConfig.upsert({
    where: { shopId_productId: { shopId, productId: product.id } },
    create: { shopId, productId: product.id, ...data },
    update: data,
  });
}
