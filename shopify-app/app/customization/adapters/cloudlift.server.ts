import { manualMappingAdapter } from "./manual-mapping.server";
import { matchesProviderScope, type ProviderAdapter, type ProviderContext } from "./types.server";

/**
 * Cloudlift native-linked mode only.
 *
 * Cloudlift's documented option:changed event is a browser notification, not an
 * authenticated API or proof of image/variant ownership. A merchant must first
 * approve an exact Shopify-variant mapping using the existing strict manual
 * schema. That mapping is revalidated against live Shopify variants and product
 * media for EVERY preview. Independent Cloudlift-only properties are unsupported.
 *
 * We intentionally reuse the proven manual adapter instead of claiming access
 * to Cloudlift private endpoints, or authorizing generated previews from events.
 */
function reviewedNativeContext(context: ProviderContext): ProviderContext {
  return { ...context, setting: { ...context.setting, providerId: "manual_mapping" } };
}

export const cloudliftAdapter: ProviderAdapter = {
  providerId: "cloudlift",
  version: "1-native-linked",
  label: "Live Product Options by Cloudlift (reviewed Shopify variants only)",
  capabilities: { discovery: true, selectionEvents: true, authorization: true },

  async discover(context, scope) {
    if (!context.setting.active || context.setting.productId !== scope.productId ||
        !matchesProviderScope(context, scope, "cloudlift")) {
      return { status: "unsupported", reason: "missing_mapping" };
    }
    try {
      const result = await manualMappingAdapter.discover(reviewedNativeContext(context), scope);
      if (result.status !== "verified") return result;
      return { ...result, snapshot: { ...result.snapshot, providerId: "cloudlift", providerVersion: "1-native-linked" } };
    } catch {
      return { status: "unsupported", reason: "missing_mapping" };
    }
  },

  async validate(context, request) {
    if (!context.setting.active || context.setting.productId !== request.scope.productId ||
        !matchesProviderScope(context, request.scope, "cloudlift")) {
      return { status: "rejected", reason: "unsupported" };
    }
    try {
      return await manualMappingAdapter.validate(reviewedNativeContext(context), request);
    } catch {
      return { status: "rejected", reason: "stale" };
    }
  },
};
