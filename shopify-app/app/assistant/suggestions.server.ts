import { getCatalogue, type CatalogueSnapshot } from "./catalogue.server";
import type { AdminGraphql } from "../preview-product.server";
import { nativeOptionRole } from "../core/native-option-discovery";

export interface CatalogueWelcome {
  /** Kept empty for older storefront bundles using this endpoint. No question chips. */
  suggestions: [];
  recommendation: { noun: string; fabric: boolean; colour: boolean } | null;
}

const emptyWelcome = (): CatalogueWelcome => ({ suggestions: [], recommendation: null });
const clean = (value: string) => value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
// Exact product types only: e.g. "Bedside Table" must never become "bed".
// Unknown/custom merchant categories keep the neutral furniture wording.
const nouns: Record<string, string> = {
  bed: "bed", beds: "bed", sofa: "sofa", sofas: "sofa", couch: "sofa", couches: "sofa",
  chair: "chair", chairs: "chair", table: "table", tables: "table", desk: "desk", desks: "desk",
  wardrobe: "wardrobe", wardrobes: "wardrobe", armchair: "armchair", armchairs: "armchair",
};

/** Optional welcome copy from this merchant's catalogue; not an availability or preview approval. */
export function catalogueWelcome(snapshot: CatalogueSnapshot | null, shopId: string, currentProductId?: string): CatalogueWelcome {
  if (!snapshot || snapshot.shopId !== shopId) return emptyWelcome();
  const products = snapshot.products.filter((p) => clean(p.title) && p.variants.some((v) => v.available));
  if (!products.length) return emptyWelcome();
  const counts = new Map<string, number>();
  for (const product of products) {
    const type = clean(product.productType).toLowerCase();
    if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const current = products.find((p) => p.id === currentProductId || p.ref === currentProductId);
  const primaryType = current ? clean(current.productType).toLowerCase()
    : [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const related = products.filter((p) => clean(p.productType).toLowerCase() === primaryType);
  const noun = Object.hasOwn(nouns, primaryType ?? "") ? nouns[primaryType!]! : "furniture";
  const roles = new Set<string>();
  // Native appearance data only. Composite strings and external app labels stay opaque.
  for (const product of related) for (const variant of product.variants.filter((v) => v.available)) {
    for (const [name, value] of Object.entries(variant.options)) {
      const role = nativeOptionRole(name);
      const label = clean(value);
      if ((role === "colour" || role === "fabric") && label && label.length <= 32 && !/[|:]/.test(label)) roles.add(role);
    }
  }
  return { suggestions: [], recommendation: { noun, fabric: roles.has("fabric"), colour: roles.has("colour") } };
}

export async function loadCatalogueWelcome(admin: AdminGraphql, shopId: string, productId?: string): Promise<CatalogueWelcome> {
  try {
    // Reuse the existing single-flight, bounded per-shop cache. No AI call or new Shopify query.
    const { snapshot } = await getCatalogue(admin, shopId, 4_000);
    return catalogueWelcome(snapshot, shopId, productId);
  } catch {
    return emptyWelcome();
  }
}
