import type { ProductPreviewConfig, VisualChoice } from "@prisma/client";
import { TryoraError } from "./core/index";
import { defaultNoun } from "./products.server";
import { matchesOptions, nativeSelections, type NativeSelection } from "./core/customization";
import { choicesFor, eligibleVariants } from "./native-selection.server";
import { PreviewIneligible, type PreviewIssue } from "./customization/preview-issues";
import { isSampleMedia } from "./customization/media-roles";

export type AdminGraphql = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };
export const PREVIEW_PRODUCT_QUERY = `#graphql
  query TryoraPreviewProduct($id: ID!, $after: String) {
    product(id: $id) {
      id title description productType
      options { id name optionValues { id name } }
      variants(first: 250, after: $after) {
        nodes { id availableForSale image { url } selectedOptions { name value } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;
export const PREVIEW_MEDIA_QUERY = `#graphql
  query TryoraPreviewMedia($id: ID!, $after: String) {
    product(id: $id) { media(first: 250, after: $after) {
      nodes { ... on MediaImage { id alt image { url } } }
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
  if (config.visualOptionName && !option) throw new PreviewIneligible("NOT_FOUND", "option_mapping_stale");
  const model = nativeSelections(product.options, config.visualOptionName, variants);
  if (model.issue || (config.autoConfigured && model.ambiguous)) throw new PreviewIneligible("BAD_REQUEST", model.issue === "stale_mapping" ? "option_mapping_stale" : "option_mapping_ambiguous");
  const selection = model.selections.find((s) => s.value === requested);
  if (model.fabricOptionName && !selection) throw new PreviewIneligible("BAD_REQUEST", "option_not_mapped");
  const values: string[] = option?.optionValues.map((v: any) => v.name) ?? [];
  if (model.selections.length && !selection) throw new PreviewIneligible("BAD_REQUEST", "option_not_mapped");
  if (!model.selections.length && requested && requested !== "__single__" && requested !== (values[0] ?? "")) throw new PreviewIneligible("BAD_REQUEST", "option_not_mapped");
  // A dependent selection must carry the exact variant; never pick another fabric or size.
  if (model.fabricOptionName && !requestedVariantId) throw new TryoraError("BAD_REQUEST");
  const optionValue = selection ? (selection.group ? [selection.group, selection.label].join(" / ") : selection.value) : (values[0] ?? "");
  const choices = selection ? choicesFor(config, selection) : config.choices.filter((c) => c.optionValue === optionValue);
  if (choices.some((c) => !c.available)) throw new PreviewIneligible("NOT_FOUND", "choice_disabled");
  // A fabric-only or colour-only approval cannot approve all combinations.
  const choice = model.fabricOptionName
    ? choices.find((c) => c.optionValue === selection!.value)
    : choices[0];
  let eligible = eligibleVariants(config, variants, selection);
  if (!selection) for (const c of choices) {
    const ids = (c.variantIds ?? []) as string[];
    if (ids.length) eligible = eligible.filter((v) => ids.includes(v.id));
  }
  if (!eligible.length) throw new PreviewIneligible("NOT_FOUND", ineligibility(config, variants, requestedVariantId, selection));
  if (!requestedVariantId && eligible.length > 1) throw new TryoraError("BAD_REQUEST");
  // The client may request a Shopify variant for the colour + product-page size.
  // Never trust that ID without checking the selected option, stock, frozen context
  // and merchant-approved variant IDs above.
  const selected = requestedVariantId
    ? eligible.find((v) => v.id === requestedVariantId)
    : eligible.find((v) => v.image?.url) ?? eligible[0];
  if (!selected) throw new PreviewIneligible("BAD_REQUEST", ineligibility(config, variants, requestedVariantId, selection));
  const variantUrl: string | undefined = selected.image?.url;
  const boundApproval = !model.fabricOptionName || ((choice?.variantIds ?? []) as string[]).includes(selected.id);
  const approved = (boundApproval ? choice?.approvedMediaIds ?? [] : []) as string[];
  // Never send a generic product reference for a multi-colour product: it may depict
  // the wrong colour. Only explicit images approved for this option are safe fallbacks.
  const ids = [...new Set((model.selections.length || model.fabricOptionName ? approved : [...approved, config.referenceMediaId])
    .filter((id): id is string => !!id))].slice(0, 4);
  if (!variantUrl && !ids.length) throw new PreviewIneligible("NOT_FOUND", "missing_reference");
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
  if (ids.some((id) => !media.some((m: any) => m?.id === id && m.image?.url))) throw new PreviewIneligible("NOT_FOUND", "reference_media_missing");
  // A fabric or colour sample is never a furniture reference, even when it was approved as one.
  const references = ids.filter((id) => !isSampleMedia(media.find((m) => m.id === id)));
  if (!variantUrl && !references.length) throw new PreviewIneligible("NOT_FOUND", "missing_reference");
  const urls = [...new Set<string>([variantUrl, ...references.map((id) => media.find((m) => m.id === id).image.url)].filter(Boolean))].slice(0, 4);
  return {
    urls, optionValue, variantId: selected.id as string,
    selectedOptions: Object.fromEntries(selected.selectedOptions.map((o: { name: string; value: string }) => [o.name, o.value])) as Record<string, string>,
    referenceVersion: `${choice?.referenceVersion ?? ids.join(",")}:${selected.id}`,
    referenceAngle: choice?.angle ?? config.referenceAngle ?? "front",
    itemNoun: config.itemNoun || defaultNoun(product.productType, product.title),
    description: `${product.title}\nSelected Shopify options: ${JSON.stringify(selected.selectedOptions)}\n${product.description ?? ""}`.slice(0, 8000),
  };
}

/** Explains why the requested variant is not eligible, in the order eligibleVariants checks it. */
function ineligibility(config: ProductPreviewConfig, variants: any[], requestedVariantId?: string, selection?: NativeSelection): PreviewIssue {
  const variant = requestedVariantId ? variants.find((v) => v.id === requestedVariantId) : null;
  if (!variant) return requestedVariantId ? "option_not_mapped" : "choice_disabled";
  if (selection && !matchesOptions(variant, selection.options)) return "option_not_mapped";
  if (!variant.availableForSale) return "sold_out";
  if (!matchesOptions(variant, (config.frozenContext ?? {}) as Record<string, string>)) return "outside_fixed_options";
  return "choice_disabled";
}
