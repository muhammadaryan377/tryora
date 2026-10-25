import type { AdminGraphql } from "../preview-product.server";
import { safeShopifyMediaUrl } from "./option-model";
import { isSampleMedia } from "./media-roles";

type SampleFile = { id: string; alt: string | null; image: { url: string } };
const SHOPIFY_MEDIA_IMAGE_ID = /^gid:\/\/shopify\/MediaImage\/\d{1,20}$/;

// Shopify Files are not attached to any product, so they never enter a product
// gallery. Fetch only the merchant's saved sample IDs; do not scan shop-wide files.
export const FABRIC_SAVED_FILES_QUERY = `#graphql
query TryoraSavedFabricSamples($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on MediaImage {
      id
      alt
      fileStatus
      image { url }
    }
  }
}`;

export function sampleMediaIds(draft: { fabrics: { textureMediaId: string | null; colours: { swatchMediaId: string | null }[] }[] }): string[] {
  return [...new Set(draft.fabrics.flatMap((f) => [f.textureMediaId, ...f.colours.map((c) => c.swatchMediaId)]
    .filter((id): id is string => !!id && SHOPIFY_MEDIA_IMAGE_ID.test(id)))];
}

/** Resolve saved standalone Shopify Files without trusting client-submitted URLs. */
export async function savedFabricSampleFiles(admin: AdminGraphql, ids: string[], productMediaIds: ReadonlySet<string>): Promise<SampleFile[]> {
  const toFetch = [...new Set(ids)].filter((id) => SHOPIFY_MEDIA_IMAGE_ID.test(id) && !productMediaIds.has(id));
  if (!toFetch.length) return [];
  const assets: SampleFile[] = [];
  for (let i = 0; i < toFetch.length; i += 100) {
    const response = await admin.graphql(FABRIC_SAVED_FILES_QUERY, { variables: { ids: toFetch.slice(i, i + 100) } });
    const json = await response.json();
    if (!response.ok || json?.errors?.length || !Array.isArray(json?.data?.nodes)) {
      throw new Error("Saved fabric samples could not be verified in Shopify Files.");
    }
    for (const node of json.data.nodes) {
      if (node && toFetch.includes(node.id) && isSampleMedia(node) && node.fileStatus === "READY" &&
          node.image?.url && safeShopifyMediaUrl(node.image.url)) {
        assets.push({ id: node.id, alt: node.alt, image: { url: node.image.url } });
      }
    }
  }
  return assets;
}
