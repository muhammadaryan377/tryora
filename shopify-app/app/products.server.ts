import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "./db.server";
import { defaultPlacement, resolveSwatches, type Placement, type ResolvedSwatch } from "./core/index";

export interface ShopProduct {
  id: string;
  title: string;
  productType: string;
  status: string;
  image?: string;
  options: { name: string; values: string[]; swatches: { value: string; colour: string | null; image: string | null }[] }[];
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
  swatchGuessApproved: boolean;
  /** Swatch for each value of the chosen option, and where it comes from. */
  resolvedSwatches: ResolvedSwatch[];
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
  }`;

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

export function swatchesFor(p: ShopProduct, optionName: string | null, colours: Record<string, string>, guess: boolean) {
  const option = optionName ? p.options.find((o) => o.name === optionName) : undefined;
  if (!option) return [];
  return resolveSwatches(
    option.swatches.map((s) => ({ value: s.value, shopifyColour: s.colour, shopifyImage: s.image })),
    colours,
    guess,
  );
}

function readinessOf(
  enabled: boolean,
  referenceMediaId: string | null,
  p: ShopProduct,
  swatches: ResolvedSwatch[] = [],
): { readiness: Readiness; reason?: string } {
  if (!enabled) return { readiness: "off" };
  if (!p.media.length) return { readiness: "needs_attention", reason: "This product has no photos" };
  if (!referenceMediaId) return { readiness: "needs_attention", reason: "Choose a reference photo" };
  if (!p.media.some((m) => m.id === referenceMediaId)) return { readiness: "needs_attention", reason: "Reference photo was removed" };
  // Owner rule: every colour needs a swatch – from Shopify, set in Tryora, or guessed from its name with approval.
  const missing = swatches.filter((s) => s.source === "missing").length;
  if (missing) return { readiness: "needs_attention", reason: `${missing} colour${missing === 1 ? " needs a" : "s need"} a swatch colour` };
  return { readiness: "ready" };
}

export async function productRows(shopId: string, products: ShopProduct[]): Promise<ProductRow[]> {
  const configs = await prisma.productPreviewConfig.findMany({ where: { shopId } });
  const byId = new Map(configs.map((c) => [c.productId, c]));
  return products.map((p) => {
    const c = byId.get(p.id);
    const enabled = c?.enabled ?? false;
    const referenceMediaId = c?.referenceMediaId ?? null;
    const visualOptionName = c ? c.visualOptionName : (p.options.find((o) => /colou?r|fabric|finish/i.test(o.name))?.name ?? null);
    const swatchColours = (c?.swatchColours as Record<string, string>) ?? {};
    const swatchGuessApproved = c?.swatchGuessApproved ?? false;
    const resolvedSwatches = swatchesFor(p, visualOptionName, swatchColours, swatchGuessApproved);
    const r = readinessOf(enabled, referenceMediaId, p, resolvedSwatches);
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
      swatchGuessApproved,
      resolvedSwatches,
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
    swatchGuessApproved: boolean;
  },
) {
  const swatches = swatchesFor(product, input.visualOptionName, input.swatchColours, input.swatchGuessApproved);
  const r = readinessOf(input.enabled, input.referenceMediaId, product, swatches);
  const data = {
    enabled: input.enabled,
    itemNoun: input.itemNoun.trim() || defaultNoun(product.productType, product.title),
    placement: input.placement,
    setting: input.setting,
    visualOptionName: input.visualOptionName,
    visualOptionType: input.visualOptionName ? "colour" : null,
    referenceMediaId: input.referenceMediaId,
    swatchColours: input.swatchColours as object,
    swatchGuessApproved: input.swatchGuessApproved,
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
