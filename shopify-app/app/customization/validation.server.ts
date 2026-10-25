import { isFabricDocument, parseFabricDocument } from "./fabric-manager";
import { safeShopifyMediaUrl } from "./option-model";
import { nativeSnapshot } from "./reference-resolver.server";
import { optionsOf, parseManualMapping, preservationKey, PRESERVATION_OPTION, MAPPED_FABRIC_OPTION, validateNativeBindings, type ManualEntry } from "./option-model";
import { combinationKey } from "./adapters/manual-mapping.server";
import { matchesOptions } from "../core/customization";
import type { ProviderContext } from "./adapters/types.server";
import { isSampleMedia } from "./media-roles";

export async function manualStorefrontData(context: ProviderContext, prefetched?: Parameters<typeof nativeSnapshot>[3]) {
  const { config, setting } = context;
  const manager = isFabricDocument(setting.mapping) ? parseFabricDocument(setting.mapping, config.shopId, config.productId) : null;
  if (!setting.active && !manager) throw new Error("Mapping needs activation.");
  const mapping = manager && !manager.published ? { entries: [], roles: manager.draft.roles } : parseManualMapping(setting.mapping, config.shopId, config.productId);
  const snapshot = await nativeSnapshot(context.admin, config.productId, true, prefetched);
  const errors = validateNativeBindings(mapping as Parameters<typeof validateNativeBindings>[0], snapshot.variants, snapshot.media);
  if (errors.length) throw new Error("Mapping needs synchronization.");
  // Only images uploaded as samples are shown as textures or swatches; a bound product photo becomes a labelled placeholder.
  const sampleUrl = (id: string | null | undefined) => {
    const m = id ? snapshot.media.find((m) => m.id === id) : undefined;
    return m?.image?.url && isSampleMedia(m) && safeShopifyMediaUrl(m.image.url) ? m.image.url : null;
  };
  function allowed(e: ManualEntry) {
    const v = snapshot.variants.find((v) => v.id === e.variantId)!;
    const original = config.visualOptionName ? optionsOf(v)[config.visualOptionName] : "";
    return v.availableForSale && matchesOptions(v, (config.frozenContext ?? {}) as Record<string, string>) &&
      config.choices.every((c) => !(c.optionValue === original || c.optionValue === combinationKey(e)) ||
        c.available && (!((c.variantIds ?? []) as string[]).length || ((c.variantIds ?? []) as string[]).includes(v.id)));
  }
  const variantChoice = (e: ManualEntry) => ({ id: e.variantId,
    image: snapshot.media.find((m) => m.id === e.referenceMediaIds[0])!.image!.url,
    options: { ...e.nativeOptions, [PRESERVATION_OPTION]: preservationKey(e), [MAPPED_FABRIC_OPTION]: e.fabric.label } });
  let swatches = [...new Set(mapping.entries.map(combinationKey))].map((key) => {
    const entries = mapping.entries.filter((e) => combinationKey(e) === key);
    const e = entries[0]!;
    // Samples must be consistent across sizes/configurations for the same appearance.
    const samples = new Set(entries.map((e) => e.swatchMediaId ?? ""));
    const swatchId = samples.size === 1 ? e.swatchMediaId : undefined;
    return { value: key, label: e.colour.label, group: e.fabric.label, colour: null as string | null,
      image: sampleUrl(swatchId),
      available: entries.some(allowed), variants: entries.filter(allowed).map(variantChoice) };
  });
  // Preview-only catalogues are merchant-authored appearance choices, not Shopify
  // variants. Reuse a real in-stock source variant solely as product identity.
  // The original configuration is preserved; colours are AI illustration inputs.
  const previewOnly = !!manager && !manager.published && !manager.draft.bindings.length;
  const illustrativeSources = previewOnly ? snapshot.variants
    .filter((v) => v.availableForSale && matchesOptions(v, (config.frozenContext ?? {}) as Record<string, string>))
    .map((v) => ({ id: v.id, image: v.image?.url ?? null, options: optionsOf(v) }))
    .filter((v) => !!v.image || !!config.referenceMediaId) : [];
  const fabricImages: Record<string, string> = Object.create(null);
  if (manager) {
    swatches = manager.draft.fabrics.filter((f) => f.enabled).flatMap((f) => {
      const texture = sampleUrl(f.textureMediaId);
      if (texture) fabricImages[f.name] = texture;
      return f.colours.filter((c) => c.enabled).map((c) => {
        const value = JSON.stringify([f.id, c.id]);
        const approved = swatches.find((s) => s.value === value);
        const previewVariants = previewOnly ? illustrativeSources.map((v) => ({
          ...v, options: { ...v.options, [MAPPED_FABRIC_OPTION]: f.name },
        })) : [];
        return { value, label: c.name, group: f.name, colour: c.hex, image: sampleUrl(c.swatchMediaId),
          available: previewOnly ? previewVariants.length > 0 : !!setting.active && !!approved?.available,
          variants: previewOnly ? previewVariants : setting.active ? approved?.variants ?? [] : [] };
      });
    });
  }
  const productVariants = snapshot.variants.map((v) => {
    const e = mapping.entries.find((e) => e.variantId === v.id);
    return e ? variantChoice(e) : { id: v.id, image: v.image?.url ?? null, options: optionsOf(v) };
  });
  return { swatches, productVariants, selectionOptionNames: [mapping.roles.fabric, mapping.roles.colour, mapping.roles.composite, MAPPED_FABRIC_OPTION].filter((s): s is string => !!s),
    // The virtual selector name is display metadata; it is never a native Shopify identity.
    optionName: "Colour", selectorLabel: "Colour", fabricOptionName: MAPPED_FABRIC_OPTION, singleVariants: [],
    ...(manager ? { managerManaged: true as const, previewOnly, mappedEntries: mapping.entries.map((e) => ({ variantId: e.variantId, fabric: e.fabric.label, colour: e.colour.label,
      preserved: e.preserved, referenceImage: snapshot.media.find((m) => m.id === e.referenceMediaIds[0])!.image!.url })) } : {}),
    fabricImages, mappingRevision: setting.revision, providerId: "manual_mapping" };
}
