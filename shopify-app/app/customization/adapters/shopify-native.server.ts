import { resolvePreviewProduct } from "../../preview-product.server";
import { nativeSelections, matchesOptions } from "../../core/customization";
import { nativeSnapshot, nativeOptionCatalog } from "../reference-resolver.server";
import { optionsOf } from "../option-model";
import type { ProviderAdapter } from "./types.server";
import { matchesProviderScope } from "./types.server";

export const shopifyNativeAdapter: ProviderAdapter = {
  providerId: "shopify_native", version: "1", label: "Shopify Native Options",
  capabilities: { discovery: true, selectionEvents: false, authorization: true },
  async discover(context, scope) {
    if (!matchesProviderScope(context, scope, "shopify_native")) return { status: "unsupported", reason: "missing_mapping" };
    const { product, variants } = await nativeSnapshot(context.admin, scope.productId, false);
    const model = nativeSelections(product.options, context.config.visualOptionName, variants);
    if (model.issue) return { status: "unsupported", reason: "missing_mapping" };
    return { status: "verified", snapshot: { scope, providerId: "shopify_native", providerVersion: "1", nativeOptionCatalog: nativeOptionCatalog(product), revision: context.setting.revision,
      source: "shopify_native", verifiedAt: new Date().toISOString(), combinations: variants.map((v) => ({
        id: v.id, nativeVariantId: v.id, options: optionsOf(v), available: v.availableForSale, swatches: [],
      })) } };
  },
  async validate(context, request) {
    if (context.config.enabled !== true || context.config.readiness !== "ready") return { status: "rejected", reason: "unsupported" };
    if (!matchesProviderScope(context, request.scope, "shopify_native")) return { status: "rejected", reason: "unsupported" };
    if (request.revision && request.revision !== context.setting.revision) return { status: "rejected", reason: "stale" };
    let option = request.combinationId;
    // The normalized adapter port uses full variant IDs as combination identities;
    // the existing widget still submits its native colour/appearance selection key.
    if (option.startsWith("gid://shopify/ProductVariant/")) {
      if (option !== request.nativeVariantId) return { status: "rejected", reason: "unsupported" };
      const snapshot = await nativeSnapshot(context.admin, request.scope.productId, false);
      const variant = snapshot.variants.find((v) => v.id === request.nativeVariantId);
      if (!variant) return { status: "rejected", reason: "unavailable" };
      const model = nativeSelections(snapshot.product.options, context.config.visualOptionName, snapshot.variants);
      option = model.selections.find((s) => matchesOptions(variant, s.options))?.value ?? "__single__";
    }
    const product = await resolvePreviewProduct(context.admin, context.config, option, request.nativeVariantId || undefined);
    if (Object.entries(request.selectedOptions).some(([name, value]) => product.selectedOptions[name] !== value)) return { status: "rejected", reason: "unsupported" };
    return { status: "approved", scope: request.scope, nativeVariantId: product.variantId, options: product.selectedOptions,
      referenceUrls: product.urls as [string, ...string[]], referenceVersion: product.referenceVersion, product };
  },
};
