import { nativeSnapshot } from "./reference-resolver.server";
import { optionsOf, parseManualMapping, preservationKey, PRESERVATION_OPTION, MAPPED_FABRIC_OPTION, validateNativeBindings, type ManualEntry } from "./option-model";
import { combinationKey } from "./adapters/manual-mapping.server";
import { matchesOptions } from "../core/customization";
import type { ProviderContext } from "./adapters/types.server";

export async function manualStorefrontData(context: ProviderContext, prefetched?: Parameters<typeof nativeSnapshot>[3]) {
  const { config, setting } = context;
  if (!setting.active) throw new Error("Mapping needs activation.");
  const mapping = parseManualMapping(setting.mapping, config.shopId, config.productId);
  const snapshot = await nativeSnapshot(context.admin, config.productId, true, prefetched);
  const errors = validateNativeBindings(mapping, snapshot.variants, snapshot.media);
  if (errors.length) throw new Error("Mapping needs synchronization.");
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
  const swatches = [...new Set(mapping.entries.map(combinationKey))].map((key) => {
    const entries = mapping.entries.filter((e) => combinationKey(e) === key);
    const e = entries[0]!;
    // Samples must be consistent across sizes/configurations for the same appearance.
    const samples = new Set(entries.map((e) => e.swatchMediaId ?? ""));
    const swatchId = samples.size === 1 ? e.swatchMediaId : undefined;
    return { value: key, label: e.colour.label, group: e.fabric.label, colour: null,
      image: swatchId ? snapshot.media.find((m) => m.id === swatchId)?.image?.url ?? null : null,
      available: entries.some(allowed), variants: entries.filter(allowed).map(variantChoice) };
  });
  const productVariants = snapshot.variants.map((v) => {
    const e = mapping.entries.find((e) => e.variantId === v.id);
    return e ? variantChoice(e) : { id: v.id, image: v.image?.url ?? null, options: optionsOf(v) };
  });
  return { swatches, productVariants, selectionOptionNames: [mapping.roles.fabric, mapping.roles.colour, mapping.roles.composite, MAPPED_FABRIC_OPTION].filter((s): s is string => !!s),
    // The virtual selector name is display metadata; it is never a native Shopify identity.
    optionName: "Colour", selectorLabel: "Colour", fabricOptionName: MAPPED_FABRIC_OPTION, singleVariants: [],
    mappingRevision: setting.revision, providerId: "manual_mapping" };
}
