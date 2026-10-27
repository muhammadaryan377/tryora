/**
 * Transparent, server-side room-fit reranker over VERIFIED Shopify attributes.
 * A photo gives observations, not precise dimensions or permission to invent variants.
 * Scores are internal ranking hints, NEVER percentages or claims shown to shoppers.
 */
import type { CatalogueProduct } from "./catalogue.server";
import type { RoomObservations, ShopperPreferences } from "../room-assistant.server";

const GROUPS: Record<string, string[]> = {
  neutral: ["cream", "beige", "ivory", "off white", "white", "oat", "oatmeal", "sand", "stone", "taupe", "linen", "natural"],
  warm: ["warm", "oak", "walnut", "terracotta", "tan", "brown", "camel", "rust", "gold", "honey"],
  cool: ["grey", "gray", "silver", "slate", "charcoal", "blue"],
  earthy: ["sage", "olive", "moss", "green", "forest", "earthy"],
};
function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(word => word.length > 2));
}
function related(value: string, source: string): boolean {
  const left = tokens(value), right = tokens(source);
  for (const word of left) if (right.has(word)) return true;
  return Object.values(GROUPS).some(group => group.some(word => left.has(word)) && group.some(word => right.has(word)));
}
function verifiedText(product: CatalogueProduct) {
  return [product.title, product.productType, product.description.slice(0, 700),
    ...product.tags, ...Object.values(product.attributes), ...product.options.flatMap(opt => opt.values),
    ...product.collections.map(entry => entry.title)].join(" ").toLowerCase();
}
function productColour(item: { options?: Record<string, string> }, product: CatalogueProduct) {
  return [
    ...Object.entries(item.options ?? {}).filter(([name]) => /colou?r|fabric|material/i.test(name)).map(([,value]) => value),
    ...product.options.filter(opt => /colou?r|fabric|material/i.test(opt.name)).flatMap(opt => opt.values),
  ];
}

export function roomFitScore(
  product: CatalogueProduct,
  item: { options?: Record<string, string> },
  room: RoomObservations | null,
  preferences: ShopperPreferences | null,
): number {
  if (!room) return 0;
  const text = verifiedText(product);
  const colours = productColour(item, product);
  let score = 0;
  // Individual verified item option has more authority than a product-wide marketing tag.
  for (const preferred of preferences?.colours ?? []) {
    if (colours.some(value => related(preferred, value))) score += 7;
    else if (related(preferred, text)) score += 2;
  }
  for (const material of preferences?.materials ?? []) {
    if (colours.some(value => related(material, value))) score += 5;
    else if (related(material, text)) score += 2;
  }
  const palette = [...room.colours, room.walls, room.floor].filter(Boolean).slice(0, 7);
  for (const tone of palette) {
    // Related palettes are a soft design cue, not a verified exact-colour claim.
    if (colours.some(value => related(tone, value))) score += 2.5;
    else if (related(tone, text)) score += 0.8;
  }
  if (room.style && related(room.style, text)) score += 4;
  for (const feature of room.furniture.slice(0, 5)) {
    if (feature && related(feature, text)) score += 0.3;
  }
  return Math.round(score * 100) / 100;
}

/**
 * Stable sort: a candidate with no verifiable room similarity does not beat a
 * stronger one simply because its AI preview is enabled. Ties keep existing order.
 */
export function rankRoomRecommendations<T extends { productRef: string; options?: Record<string, string> }>(
  items: T[],
  getProduct: (ref: string) => CatalogueProduct | undefined,
  room: RoomObservations | null,
  preferences: ShopperPreferences | null,
): T[] {
  if (!room || items.length < 2) return items;
  return items.map((item, index) => ({
    item, index, score: (() => {
      const product = getProduct(item.productRef);
      return product ? roomFitScore(product, item, room, preferences) : 0;
    })(),
  })).sort((a, b) => b.score - a.score || a.index - b.index).map(value => value.item);
}
