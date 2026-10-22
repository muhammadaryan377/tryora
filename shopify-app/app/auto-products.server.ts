import prisma from "./db.server";
import type { AdminGraphql } from "./preview-product.server";

/** Conservative allowlist: do not expose the AI tool on non-furniture or bedding accessories. */
export function autoFurnitureCategory(productType: string, title: string): string | null {
  const name = `${productType} ${title}`.toLowerCase();
  if (/\b(gift cards?|mattresses?|mattress toppers?|pillowcases?|bedding|bedsheets?|duvets?|blankets?|throws?|cushions?|pillows?|covers?|spare parts?|fittings?)\b/.test(name)) return null;
  if (/\b(sofas?|couches?|settees?|loveseats?|sectionals?)\b/.test(productType.toLowerCase())) return "sofa";
  if (/\b(beds?|bedframes?|bed frames?|divans?)\b/.test(name)) return "bed";
  if (/\b(sofas?|couches?|settees?|loveseats?|sectionals?)\b/.test(name)) return "sofa";
  if (/\b(chairs?|armchairs?|recliners?|stools?|benches?)\b/.test(name)) return "chair";
  if (/\b(tables?|desks?)\b/.test(name)) return "table";
  if (/\b(wardrobes?|cabinets?|dressers?|cupboards?|sideboards?|bookcases?|shelves|shelving|chests? of drawers|storage furniture)\b/.test(name)) return "storage furniture";
  if (/\b(rugs?|carpets?|runners?)\b/.test(name)) return "rug";
  if (/\b(lamps?|lighting fixtures?|pendant lights?|chandeliers?|sconces?)\b/.test(name)) return "lighting fixture";
  return null;
}

export function isAutoEligibleProduct(p: {
  productType: string; title: string; status: string; media: { id: string }[];
}): boolean {
  return p.status === "ACTIVE" && p.media.length > 0 && !!autoFurnitureCategory(p.productType, p.title);
}

/** One Shopify query on first view (and for automatically managed records) keeps new products in sync.
 * Manual product settings, including an explicit OFF choice, always win.
 */
export async function ensureAutoProductConfig(admin: AdminGraphql, shopId: string, productId: string) {
  const gid = productId.startsWith("gid://") ? productId : `gid://shopify/Product/${productId}`;
  const existing = await prisma.productPreviewConfig.findUnique({
    where: { shopId_productId: { shopId, productId: gid } },
  });
  if (existing && !existing.autoConfigured) return existing;

  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop?.autoEnableProducts) return null;

  const res = await admin.graphql(`#graphql
    query TryoraAutoProduct($id: ID!) {
      product(id: $id) {
        id title productType status
        media(first: 20) { nodes { ... on MediaImage { id image { url } } } }
        options { name }
      }
    }`, { variables: { id: gid } });
  const body: any = await res.json();
  const product = body.data?.product;
  if (!res.ok || body.errors?.length || !product) return null;
  const media = (product.media?.nodes ?? []).filter((m: any) => m?.id && m?.image?.url);
  if (!isAutoEligibleProduct({ ...product, media })) return null;
  const category = autoFurnitureCategory(product.productType, product.title)!;
  const referenceMediaId = media[0]!.id as string;
  const option = (product.options ?? []).find((o: { name: string }) => /colou?r|fabric|finish/i.test(o.name))?.name ?? null;

  if (existing && existing.referenceMediaId === referenceMediaId &&
      existing.visualOptionName === option && existing.enabled && existing.readiness === "ready") return existing;

  return prisma.productPreviewConfig.upsert({
    where: { shopId_productId: { shopId, productId: gid } },
    create: {
      shopId, productId: gid, enabled: true, autoConfigured: true, readiness: "ready",
      readinessReasons: [], itemNoun: category, placement: "replace", setting: "indoor",
      visualOptionName: option, visualOptionType: option ? "colour" : null,
      referenceMediaId, frozenContext: {},
    },
    update: {
      enabled: true, autoConfigured: true, readiness: "ready",
      readinessReasons: [], itemNoun: category, placement: "replace", setting: "indoor",
      visualOptionName: option, visualOptionType: option ? "colour" : null, referenceMediaId,
    },
  });
}
