import { nativeSnapshot, nativeOptionCatalog } from "../reference-resolver.server";
import { parseManualMapping, validateNativeBindings, optionsOf, canonicalOptions, preservationKey, type ManualMapping } from "../option-model";
import { matchesOptions } from "../../core/customization";
import { defaultNoun } from "../../products.server";
import type { ProviderAdapter } from "./types.server";
import { matchesProviderScope } from "./types.server";
import { isFabricDocument, parseFabricDocument } from "../fabric-manager";
import { isSampleMedia } from "../media-roles";
import { safeShopifyMediaUrl } from "../option-model";

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
    if (!matchesProviderScope(context, request.scope, "manual_mapping") || request.revision !== setting.revision) return { status: "rejected", reason: "stale" };
    // A merchant's unsupplemented fabric/colour catalogue is for Tryora AI
    // visualisation, not an actual Shopify colour or purchasable variant.
    // Exact native mappings, when published, retain the stricter path below.
    const catalogue = isFabricDocument(setting.mapping) ? parseFabricDocument(setting.mapping, config.shopId, config.productId) : null;
    if (catalogue && !catalogue.published && !catalogue.draft.bindings.length) {
      let key: unknown;
      try { key = JSON.parse(request.combinationId); } catch { /* invalid selection */ }
      if (!Array.isArray(key) || key.length !== 2 || key.some((id) => typeof id !== "string")) {
        return { status: "rejected", reason: "unsupported", issue: "option_not_mapped" };
      }
      const fabric = catalogue.draft.fabrics.find((f) => f.id === key[0] && f.enabled);
      const colour = fabric?.colours.find((c) => c.id === key[1] && c.enabled);
      if (!fabric || !colour) return { status: "rejected", reason: "unsupported", issue: "option_not_mapped" };
      // Never convert a preview-only colour into a Shopify variant. The source
      // must remain the shopper's exact, real, currently available variant.
      if (!context.sourceVariantId || context.sourceVariantId !== request.nativeVariantId)
        return { status: "rejected", reason: "unsupported", issue: "configuration_mismatch" };
      const { product, variants, media } = await nativeSnapshot(context.admin, config.productId);
      const source = variants.find((v) => v.id === context.sourceVariantId && v.availableForSale);
      if (!source) return { status: "rejected", reason: "unavailable", issue: "sold_out" };
      if (!matchesOptions(source, (config.frozenContext ?? {}) as Record<string, string>))
        return { status: "rejected", reason: "unsupported", issue: "outside_fixed_options" };
      const sourceOptions = optionsOf(source);
      if (Object.entries(request.selectedOptions).some(([name, value]) => sourceOptions[name] !== value))
        return { status: "rejected", reason: "unsupported" };
      const originalValue = config.visualOptionName ? sourceOptions[config.visualOptionName] : "";
      if (config.choices.some((choice) => {
        const ids = (choice.variantIds ?? []) as string[];
        return choice.optionValue === originalValue && (!choice.available || ids.length > 0 && !ids.includes(source.id));
      })) return { status: "rejected", reason: "unavailable", issue: "choice_disabled" };
      const approvedPhoto = config.referenceMediaId ? media.find((m) => m.id === config.referenceMediaId) : null;
      const reference = approvedPhoto?.image?.url && !isSampleMedia(approvedPhoto) && safeShopifyMediaUrl(approvedPhoto.image.url)
        ? approvedPhoto.image.url
        : source.image?.url && safeShopifyMediaUrl(source.image.url) ? source.image.url : null;
      if (!reference) return { status: "rejected", reason: "missing_reference", issue: "missing_reference" };
      const appearance = { fabric: fabric.name, colour: colour.name, hex: colour.hex };
      const preview = {
        urls: [reference], variantId: source.id, selectedOptions: sourceOptions,
        optionValue: `${fabric.name} / ${colour.name}`,
        referenceVersion: `${setting.revision}:illustrative:${fabric.id}:${colour.id}:${source.id}:${config.referenceMediaId ?? "variant"}`,
        referenceAngle: config.referenceAngle ?? "front",
        itemNoun: config.itemNoun || defaultNoun(product.productType, product.title),
        description: `${product.title}\nReference model design only; Tryora visual colour override is not a verified Shopify purchasable option.\n${product.description ?? ""}`.slice(0, 8000),
        previewOnlyAppearance: appearance,
      };
      return { status: "approved", scope: request.scope, nativeVariantId: source.id, options: sourceOptions,
        referenceUrls: [reference], referenceVersion: preview.referenceVersion, product: preview };
    }
    const unpublished = !setting.active || !!catalogue && !catalogue.published;
    if (unpublished) return { status: "rejected", reason: "stale", issue: "mapping_not_published" };
    const mapping = parseManualMapping(setting.mapping, config.shopId, config.productId);
    const { product, variants, media } = await nativeSnapshot(context.admin, config.productId);
    if (validateNativeBindings(mapping, variants, media).length) return { status: "rejected", reason: "stale", issue: "mapping_out_of_sync" };
    const entry = mapping.entries.find((e) => e.variantId === request.nativeVariantId && (e.id === request.combinationId || combinationKey(e) === request.combinationId));
    const source = mapping.entries.find((e) => e.variantId === context.sourceVariantId);
    if (!entry) return { status: "rejected", reason: "unsupported", issue: "variant_not_mapped" };
    if (!source || preservationKey(entry) !== preservationKey(source)) return { status: "rejected", reason: "unsupported", issue: "configuration_mismatch" };
    if (Object.entries(request.selectedOptions).some(([name, value]) => entry.nativeOptions[name] !== value)) return { status: "rejected", reason: "unsupported" };
    const changing = new Set([mapping.roles.fabric, mapping.roles.colour, mapping.roles.composite].filter(Boolean));
    if (Object.entries(source.nativeOptions).some(([name, value]) => !changing.has(name) && entry.nativeOptions[name] !== value)) return { status: "rejected", reason: "unsupported", issue: "configuration_mismatch" };
    const selected = variants.find((v) => v.id === entry.variantId);
    if (!selected?.availableForSale) return { status: "rejected", reason: "unavailable", issue: "sold_out" };
    if (!matchesOptions(selected, (config.frozenContext ?? {}) as Record<string, string>)) return { status: "rejected", reason: "unsupported", issue: "outside_fixed_options" };
    const value = config.visualOptionName ? optionsOf(selected)[config.visualOptionName] : "";
    if (config.choices.some((c) => (c.optionValue === value || c.optionValue === request.combinationId || c.optionValue === combinationKey(entry)) &&
      (!c.available || ((c.variantIds ?? []) as string[]).length > 0 && !((c.variantIds ?? []) as string[]).includes(selected.id)))) return { status: "rejected", reason: "unavailable", issue: "choice_disabled" };
    // A fabric or colour sample never authorizes generation as the full furniture reference.
    if (entry.referenceMediaIds.some((id) => isSampleMedia(media.find((m) => m.id === id)))) return { status: "rejected", reason: "missing_reference", issue: "missing_reference" };
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
