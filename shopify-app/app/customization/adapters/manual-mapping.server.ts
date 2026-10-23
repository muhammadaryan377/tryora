import { nativeSnapshot, nativeOptionCatalog } from "../reference-resolver.server";
import { parseManualMapping, validateNativeBindings, optionsOf, canonicalOptions, preservationKey, type ManualMapping } from "../option-model";
import { matchesOptions } from "../../core/customization";
import { defaultNoun } from "../../products.server";
import type { ProviderAdapter } from "./types.server";
import { matchesProviderScope } from "./types.server";

export function combinationKey(entry: ManualMapping["entries"][number]) { return JSON.stringify([entry.fabric.id, entry.colour.id]); }
export const manualMappingAdapter: ProviderAdapter = {
  providerId: "manual_mapping", version: "1", label: "Manual / Custom Mapping",
  capabilities: { discovery: true, selectionEvents: false, authorization: true },
  async discover(context, scope) {
    if (!context.setting.active || !matchesProviderScope(context, scope, "manual_mapping")) return { status: "unsupported", reason: "missing_mapping" };
    const mapping = parseManualMapping(context.setting.mapping, scope.shopId, scope.productId);
    const snapshot = await nativeSnapshot(context.admin, scope.productId);
    if (validateNativeBindings(mapping, snapshot.variants, snapshot.media).length) return { status: "unsupported", reason: "missing_mapping" };
    return { status: "verified", snapshot: { scope, providerId: "manual_mapping", providerVersion: "1", nativeOptionCatalog: nativeOptionCatalog(snapshot.product), revision: context.setting.revision,
      verifiedAt: new Date().toISOString(), source: "shopify_native", combinations: mapping.entries.map((e) => ({
        id: e.id, nativeVariantId: e.variantId, options: e.nativeOptions,
        available: snapshot.variants.find((v) => v.id === e.variantId)?.availableForSale ?? false,
        swatches: e.swatchMediaId ? [{ optionName: "Colour", value: e.colour.label,
          imageUrl: snapshot.media.find((m) => m.id === e.swatchMediaId)?.image?.url ?? null }] : [],
      })) } };
  },
  async validate(context, request) {
    const { config, setting } = context;
    if (config.enabled !== true || config.readiness !== "ready") return { status: "rejected", reason: "unsupported" };
    if (!setting.active || !matchesProviderScope(context, request.scope, "manual_mapping") || request.revision !== setting.revision) return { status: "rejected", reason: "stale" };
    const mapping = parseManualMapping(setting.mapping, config.shopId, config.productId);
    const { product, variants, media } = await nativeSnapshot(context.admin, config.productId);
    if (validateNativeBindings(mapping, variants, media).length) return { status: "rejected", reason: "stale" };
    const entry = mapping.entries.find((e) => e.variantId === request.nativeVariantId && (e.id === request.combinationId || combinationKey(e) === request.combinationId));
    const source = mapping.entries.find((e) => e.variantId === context.sourceVariantId);
    if (!entry || !source || preservationKey(entry) !== preservationKey(source)) return { status: "rejected", reason: "unsupported" };
    if (Object.entries(request.selectedOptions).some(([name, value]) => entry.nativeOptions[name] !== value)) return { status: "rejected", reason: "unsupported" };
    const changing = new Set([mapping.roles.fabric, mapping.roles.colour, mapping.roles.composite].filter(Boolean));
    if (Object.entries(source.nativeOptions).some(([name, value]) => !changing.has(name) && entry.nativeOptions[name] !== value)) return { status: "rejected", reason: "unsupported" };
    const selected = variants.find((v) => v.id === entry.variantId);
    if (!selected?.availableForSale) return { status: "rejected", reason: "unavailable" };
    if (!matchesOptions(selected, (config.frozenContext ?? {}) as Record<string, string>)) return { status: "rejected", reason: "unsupported" };
    const value = config.visualOptionName ? optionsOf(selected)[config.visualOptionName] : "";
    if (config.choices.some((c) => (c.optionValue === value || c.optionValue === request.combinationId || c.optionValue === combinationKey(entry)) &&
      (!c.available || ((c.variantIds ?? []) as string[]).length > 0 && !((c.variantIds ?? []) as string[]).includes(selected.id)))) return { status: "rejected", reason: "unavailable" };
    const urls = entry.referenceMediaIds.map((id) => media.find((m) => m.id === id)!.image!.url);
    const preview = { urls, variantId: selected.id, selectedOptions: entry.nativeOptions, optionValue: `${entry.fabric.label} / ${entry.colour.label}`,
      referenceVersion: `${setting.revision}:${entry.id}:${selected.id}:${entry.referenceMediaIds.join(",")}`,
      referenceAngle: config.referenceAngle ?? "front", itemNoun: config.itemNoun || defaultNoun(product.productType, product.title),
      description: `${product.title}\nVerified Shopify options: ${canonicalOptions(entry.nativeOptions)}\nReviewed configuration: ${canonicalOptions(entry.preserved)}\n${product.description ?? ""}`.slice(0, 8000),
    };
    return { status: "approved", scope: request.scope, nativeVariantId: selected.id, options: entry.nativeOptions,
      referenceUrls: urls as [string, ...string[]], referenceVersion: preview.referenceVersion, product: preview };
  },
};
