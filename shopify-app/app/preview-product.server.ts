import type { ProductPreviewConfig, VisualChoice } from "@prisma/client";
import { TryoraError } from "./core/index";
import { defaultNoun } from "./products.server";

export type AdminGraphql = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };
export const PREVIEW_PRODUCT_QUERY = `#graphql
  query TryoraPreviewProduct($id: ID!, $after: String) {
    product(id: $id) {
      id title description productType
      options { name optionValues { name } }
      variants(first: 250, after: $after) {
        nodes { id availableForSale image { url } selectedOptions { name value } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;
export const PREVIEW_MEDIA_QUERY = `#graphql
  query TryoraPreviewMedia($id: ID!, $after: String) {
    product(id: $id) { media(first: 250, after: $after) {
      nodes { ... on MediaImage { id image { url } } }
      pageInfo { hasNextPage endCursor }
    } }
  }`;

export async function resolvePreviewProduct(admin: AdminGraphql, config: ProductPreviewConfig & { choices: VisualChoice[] }, requested: string, requestedVariantId?: string) {
  let product: any;
  const variants: any[] = [];
  let after: string | null = null;
  do {
    const res = await admin.graphql(PREVIEW_PRODUCT_QUERY, { variables: { id: config.productId, after } });
    const json = await res.json();
    if (!res.ok || json.errors?.length || !json.data?.product) throw new TryoraError("NOT_FOUND");
    product = json.data.product;
    variants.push(...product.variants.nodes);
    const info = product.variants.pageInfo;
    if (info.hasNextPage && (!info.endCursor || info.endCursor === after)) throw new TryoraError("PROVIDER_UNAVAILABLE");
    after = info.hasNextPage ? info.endCursor : null;
  } while (after);
  const option = product.options.find((o: any) => o.name === config.visualOptionName);
  if (config.visualOptionName && !option) throw new TryoraError("NOT_FOUND");
  const values: string[] = option?.optionValues.map((v: any) => v.name) ?? [];
  const optionValue = values.length > 1 ? requested : (values[0] ?? "");
  if ((values.length > 1 && !values.includes(requested)) ||
      (values.length <= 1 && requested && requested !== "__single__" && requested !== optionValue)) throw new TryoraError("BAD_REQUEST");
  const frozen = (config.frozenContext ?? {}) as Record<string, string>;
  const matching = variants.filter((v) => v.availableForSale &&
    (!config.visualOptionName || v.selectedOptions.some((s: any) => s.name === config.visualOptionName && s.value === optionValue)) &&
    Object.entries(frozen).every(([name, value]) => v.selectedOptions.some((s: any) => s.name === name && s.value === value)));
  if (!matching.length) throw new TryoraError("NOT_FOUND");
  const choice = config.choices.find((c) => c.optionValue === optionValue);
  if (choice && !choice.available) throw new TryoraError("NOT_FOUND");
  const eligibleIds = (choice?.variantIds ?? []) as string[];
  const eligible = eligibleIds.length ? matching.filter((v) => eligibleIds.includes(v.id)) : matching;
  if (!eligible.length) throw new TryoraError("NOT_FOUND");
  // The client may request a Shopify variant for the colour + product-page size.
  // Never trust that ID without checking the selected option, stock, frozen context
  // and merchant-approved variant IDs above.
  const selected = requestedVariantId
    ? eligible.find((v) => v.id === requestedVariantId)
    : eligible.find((v) => v.image?.url) ?? eligible[0];
  if (!selected) throw new TryoraError("BAD_REQUEST");
  const variantUrl: string | undefined = selected.image?.url;
  const approved = (choice?.approvedMediaIds ?? []) as string[];
  // Never send a generic product reference for a multi-colour product: it may depict
  // the wrong colour. Only explicit images approved for this option are safe fallbacks.
  const ids = [...new Set((values.length > 1 ? approved : [...approved, config.referenceMediaId])
    .filter((id): id is string => !!id))].slice(0, 4);
  if (!variantUrl && !ids.length) throw new TryoraError("NOT_FOUND");
  const media: any[] = [];
  after = null;
  while (ids.length) {
    const mediaRes = await admin.graphql(PREVIEW_MEDIA_QUERY, { variables: { id: config.productId, after } });
    const mediaJson = await mediaRes.json();
    if (!mediaRes.ok || mediaJson.errors?.length || !mediaJson.data?.product) throw new TryoraError("PROVIDER_UNAVAILABLE");
    const page = mediaJson.data.product.media;
    media.push(...page.nodes.filter((m: any) => ids.includes(m?.id)));
    if (page.pageInfo.hasNextPage && (!page.pageInfo.endCursor || page.pageInfo.endCursor === after)) throw new TryoraError("PROVIDER_UNAVAILABLE");
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (!after || ids.every((id) => media.some((m) => m.id === id))) break;
  }
  if (ids.some((id) => !media.some((m: any) => m?.id === id && m.image?.url))) throw new TryoraError("NOT_FOUND");
  const urls = [...new Set<string>([variantUrl, ...ids.map((id) => media.find((m) => m.id === id).image.url)].filter(Boolean))].slice(0, 4);
  return {
    urls, optionValue, variantId: selected.id as string,
    referenceVersion: `${choice?.referenceVersion ?? ids.join(",")}:${selected.id}`,
    referenceAngle: choice?.angle ?? config.referenceAngle ?? "front",
    itemNoun: config.itemNoun || defaultNoun(product.productType, product.title),
    description: `${product.title}\n${product.description ?? ""}`.slice(0, 8000),
  };
}
