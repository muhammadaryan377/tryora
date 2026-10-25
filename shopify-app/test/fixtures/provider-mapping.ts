import type { ManualMapping } from "../../app/customization/option-model";
import type { ProviderContext } from "../../app/customization/adapters/types.server";
import { vi } from "vitest";

// Synthetic numbered/composite product; no real merchant availability is asserted.
export const shopId = "synthetic.myshopify.com", productId = "gid://shopify/Product/1";
const tuple = (colour: string, size = "King", storage = "None") => ({
  "1. Choose Your Size": size, "2. Choose Your Fabric": "Velvet",
  "Other bed choices": `synthetic opaque ${colour} storage=${storage}`,
});
export function providerFixture() {
  const mapping: ManualMapping = { schemaVersion: 1, providerId: "manual_mapping", shopId, productId, reviewed: true,
    roles: { size: "1. Choose Your Size", fabric: "2. Choose Your Fabric", composite: "Other bed choices" }, entries: [
      { id: "cream", variantId: "gid://shopify/ProductVariant/11", nativeOptions: tuple("Cream"), fabric: { id: "velvet", label: "Velvet" }, colour: { id: "cream", label: "Cream" }, preserved: { storage: "None", headboard: "Tall" }, referenceMediaIds: ["gid://shopify/MediaImage/101"], swatchMediaId: "gid://shopify/MediaImage/201" },
      { id: "grey", variantId: "gid://shopify/ProductVariant/12", nativeOptions: tuple("Grey"), fabric: { id: "velvet", label: "Velvet" }, colour: { id: "grey", label: "Grey" }, preserved: { storage: "None", headboard: "Tall" }, referenceMediaIds: ["gid://shopify/MediaImage/102"] },
      { id: "grey-king-storage", variantId: "gid://shopify/ProductVariant/13", nativeOptions: tuple("Grey", "King", "Ottoman"), fabric: { id: "velvet", label: "Velvet" }, colour: { id: "grey", label: "Grey" }, preserved: { storage: "Ottoman", headboard: "Tall" }, referenceMediaIds: ["gid://shopify/MediaImage/103"] },
      { id: "grey-double", variantId: "gid://shopify/ProductVariant/14", nativeOptions: tuple("Grey", "Double"), fabric: { id: "velvet", label: "Velvet" }, colour: { id: "grey", label: "Grey" }, preserved: { storage: "None", headboard: "Tall" }, referenceMediaIds: ["gid://shopify/MediaImage/104"] },
    ] };
  const variants = mapping.entries.map((e) => ({ id: e.variantId, availableForSale: true,
    selectedOptions: Object.entries(e.nativeOptions).map(([name, value]) => ({ name, value })), image: { url: "https://cdn.shopify.com/native.jpg" } }));
  // 101-104 are full furniture photos; 201 is a colour sample uploaded through Tryora (its alt marker proves the role).
  const media = [101, 102, 103, 104, 201].map((n) => ({ id: `gid://shopify/MediaImage/${n}`, ...(n >= 200 ? { alt: `Tryora fabric sample fixture-${n}` } : {}), image: { url: `https://cdn.shopify.com/${n}.jpg` } }));
  const options = Object.keys(mapping.entries[0]!.nativeOptions).map((name) => ({ name,
    optionValues: [...new Set(mapping.entries.map((e) => e.nativeOptions[name]!))].map((name) => ({ name })) }));
  const graphql = vi.fn(async (query: string) => Response.json({ data: { product: query.includes("TryoraPreviewMedia")
    ? { id: productId, media: { nodes: media, pageInfo: { hasNextPage: false } } }
    : { id: productId, title: "Synthetic bed", productType: "Bed", options, variants: { nodes: variants, pageInfo: { hasNextPage: false } } } } }));
  const context: ProviderContext = { admin: { graphql }, sourceVariantId: mapping.entries[0]!.variantId,
    config: { shopId, productId, enabled: true, readiness: "ready", visualOptionName: "2. Choose Your Fabric", frozenContext: {}, choices: [], itemNoun: "bed" } as any,
    setting: { shopId, productId, providerId: "manual_mapping", revision: "revision-1", active: true, mapping } };
  return { mapping, variants, media, context, graphql };
}
