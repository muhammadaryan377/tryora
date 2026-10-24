import { TryoraError, type ReasonCode } from "../core/index";

/**
 * Why Tryora's strict validation refused one exact variant. The TryoraError code (and so every HTTP response and
 * startPreview outcome) is unchanged; the issue only explains the refusal to the shopper and the merchant.
 */
export type PreviewIssue =
  | "provider_not_supported" | "mapping_not_published" | "mapping_out_of_sync" | "variant_not_mapped"
  | "configuration_mismatch" | "option_mapping_stale" | "option_mapping_ambiguous" | "option_not_mapped"
  | "outside_fixed_options" | "choice_disabled" | "missing_reference" | "reference_media_missing"
  | "sold_out" | "check_failed" | "not_approved";

export class PreviewIneligible extends TryoraError {
  constructor(code: ReasonCode, readonly issue: PreviewIssue) { super(code); }
}

/** Shopper text never names admin screens; merchant text names the exact Tryora admin action. */
export const PREVIEW_ISSUES: Record<PreviewIssue, { shopper: string; merchant: string }> = {
  provider_not_supported: {
    shopper: "AI room preview isn't offered for this product.",
    merchant: "This product's customization provider can't authorize AI previews. Choose Shopify native options or a reviewed mapping in Tryora › Customization.",
  },
  mapping_not_published: {
    shopper: "The store is still setting up AI room preview for this product.",
    merchant: "Publish the reviewed fabric & colour mapping in Tryora › Fabrics & Colours, then validate and activate it in Tryora › Customization.",
  },
  mapping_out_of_sync: {
    shopper: "The store is updating AI room preview for this product.",
    merchant: "The reviewed mapping no longer matches this product's Shopify variants or media. Re-sync, review and publish it in Tryora › Fabrics & Colours.",
  },
  variant_not_mapped: {
    shopper: "This exact fabric and colour hasn't been approved for AI room preview yet.",
    merchant: "Add this exact Shopify variant to the reviewed fabric & colour mapping with its full-product reference photo in Tryora › Fabrics & Colours.",
  },
  configuration_mismatch: {
    shopper: "This option can't be previewed with the selected size and configuration.",
    merchant: "The reviewed mapping has no entry for this fabric and colour with the same size, headboard and storage as the shopper's selection. Add that exact variant in Tryora › Fabrics & Colours.",
  },
  option_mapping_stale: {
    shopper: "The store needs to finish setting up AI room preview for this product.",
    merchant: "The appearance option saved for this product no longer exists in Shopify. Re-select it in Tryora › Products.",
  },
  option_mapping_ambiguous: {
    shopper: "The store needs to finish setting up AI room preview for this product.",
    merchant: "Tryora can't tell which Shopify option controls this product's appearance. Choose it explicitly in Tryora › Products.",
  },
  option_not_mapped: {
    shopper: "This exact option isn't one of the store's verified AI preview options.",
    merchant: "This variant's appearance value isn't one of the product's verified preview options. Check the Fabric and Colour option values in Shopify and the appearance option in Tryora › Products.",
  },
  outside_fixed_options: {
    shopper: "AI room preview is set up for a different size or configuration of this product.",
    merchant: "This variant doesn't match the options fixed for previews on this product. Update the fixed options in Tryora › Products if this configuration should be previewable.",
  },
  choice_disabled: {
    shopper: "The store has turned off AI room preview for this option.",
    merchant: "This option is disabled, or limited to other variants, in Tryora › Products. Enable it or add this variant.",
  },
  missing_reference: {
    shopper: "The store hasn't approved a photo of this exact option for AI room preview yet.",
    merchant: "This exact variant has no Shopify variant image and no approved full-product reference photo for its fabric and colour. Assign a variant image in Shopify, or approve a reference photo for this variant in Tryora › Products.",
  },
  reference_media_missing: {
    shopper: "The store hasn't approved a photo of this exact option for AI room preview yet.",
    merchant: "An approved reference photo was removed from the Shopify product. Approve a current product photo in Tryora › Products.",
  },
  sold_out: {
    shopper: "This option is sold out, so it can't be previewed.",
    merchant: "This exact variant isn't available for sale in Shopify. Previews return when it is back in stock.",
  },
  check_failed: {
    shopper: "AI room preview couldn't be checked just now. Please try again shortly.",
    merchant: "Shopify product data couldn't be read while checking this variant. Retry; if it persists, run Tryora › Room assistant › Check catalogue connection.",
  },
  not_approved: {
    shopper: "This exact option isn't approved for AI room preview.",
    merchant: "Tryora's preview validation rejected this exact variant. Check its reference photo and appearance settings in Tryora › Products.",
  },
};

/** The explanation for a refusal; anything unrecognised keeps the existing conservative wording. */
export function previewIssueOf(error: unknown): PreviewIssue {
  if (error instanceof PreviewIneligible) return error.issue;
  if (error instanceof TryoraError && (error.code === "PROVIDER_UNAVAILABLE" || error.code === "PROVIDER_TIMEOUT")) return "check_failed";
  return "not_approved";
}

/** Adapter rejections are coarse ("stale", "unsupported", "unavailable"); keep the adapter's precise issue when it gave one. */
export function rejectionIssue(reason: string | undefined): PreviewIssue {
  return reason === "stale" ? "mapping_out_of_sync" : reason === "unavailable" ? "choice_disabled" : reason === "missing_reference" ? "missing_reference" : "not_approved";
}
