import { getCatalogue, type CatalogueSnapshot } from "./catalogue.server";
import type { AdminGraphql } from "../preview-product.server";
import { nativeOptionRole } from "../core/native-option-discovery";

/** Questions grounded in one merchant's published catalogue, never claims about best sellers or live stock. */
export function catalogueSuggestions(snapshot: CatalogueSnapshot | null, shopId: string, currentProductId?: string): string[] {
  if (!snapshot || snapshot.shopId !== shopId) return [];
  const clean = (value: string) => value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  const products = snapshot.products.filter((p) => clean(p.title) && p.variants.some((v) => v.available));
  if (!products.length) return [];
  const counts = new Map<string, number>();
  for (const product of products) if (clean(product.productType)) {
    const type = clean(product.productType);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const primaryType = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const current = products.find((p) => p.id === currentProductId || p.ref === currentProductId);
  const primary = current ?? products.find((p) => clean(p.productType) === primaryType) ?? products[0]!;
  const prompts: string[] = [];
  const add = (text: string) => {
    if (text.length <= 120 && !prompts.some((p) => p.toLowerCase() === text.toLowerCase())) prompts.push(text);
  };
  if (current) add(`Tell me about ${clean(current.title)}`);
  if (primaryType) add(`Show me ${primaryType.toLowerCase()} products`);
  // Each appearance suggestion is witnessed in an actual available variant. Composite strings stay opaque.
  const traits = new Map<string, number>();
  for (const product of products.filter((p) => clean(p.productType) === primaryType)) {
    const seen = new Set<string>();
    for (const variant of product.variants.filter((v) => v.available)) {
      for (const [name, value] of Object.entries(variant.options)) {
        const role = nativeOptionRole(name);
        const label = clean(value);
        if ((role === "colour" || role === "fabric") && label.length <= 32 && !/[|:]/.test(label)) seen.add(label);
      }
    }
    for (const label of seen) traits.set(label, (traits.get(label) ?? 0) + 1);
  }
  const trait = [...traits].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (trait && primaryType) add(`Show me ${trait} ${primaryType.toLowerCase()} products`);
  if (primary.options.some((o) => /^(?:\d+[.)]\s+)?(?:(?:choose|select) (?:your )?)?size$/i.test(o.name.trim()) &&
    primary.variants.some((v) => v.available && !!v.options[o.name]))) add(`What sizes does ${clean(primary.title)} come in?`);
  for (const product of products) {
    if (product !== current) add(`Show me ${clean(product.title)}`);
    if (prompts.length >= 4) break;
  }
  return prompts.slice(0, 4);
}

export async function loadCatalogueSuggestions(admin: AdminGraphql, shopId: string, productId?: string) {
  try {
    // Reuse the existing single-flight, bounded per-shop cache. No AI call or new Shopify query.
    const { snapshot } = await getCatalogue(admin, shopId, 4_000);
    return catalogueSuggestions(snapshot, shopId, productId);
  } catch {
    return [];
  }
}
