// GENERATED from packages/core/src by scripts/sync-core.mjs. Do not edit here.
/** Native Shopify options only. App-owned properties need an explicit adapter. */
export interface NativeOption {
  name: string;
  optionValues: { name: string; swatch?: { color?: string | null; image?: { image?: { url?: string } } } | null }[];
}
export interface NativeVariant {
  id: string;
  availableForSale: boolean;
  image?: { url: string } | null;
  selectedOptions: { name: string; value: string }[];
}
export interface NativeSelection {
  value: string;
  label: string;
  group: string | null;
  options: Record<string, string>;
  image: string | null;
  colour: string | null;
}

export function nativeSelections(options: NativeOption[], configuredName: string | null, variants: NativeVariant[]) {
  const primary = options.find((o) => o.name === configuredName);
  const fabric = options.find((o) => /^(?:choose\s+)?fabric(?:\s+type)?$/i.test(o.name.trim()));
  const colour = options.find((o) => /^(?:choose\s+)?colou?r$/i.test(o.name.trim()));
  // Respect a merchant's unrelated visual option (or single-style setting).
  const dependent = !!fabric && !!colour && (primary === fabric || primary === colour);
  // Some catalogues name the native option "Colour" but supply only fabric types.
  // This changes the label only; it never manufactures a colour or variant mapping.
  const fabricValues = !!primary?.optionValues.length && primary.optionValues.every((v) =>
    /^(plush velvet|teddy boucle|linoso|naples|chenille|crushed velvet|coniston)$/i.test(
      v.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim()));
  const selections: NativeSelection[] = [];
  if (dependent) {
    for (const variant of variants) {
      const f = variant.selectedOptions.find((o) => o.name === fabric!.name)?.value;
      const c = variant.selectedOptions.find((o) => o.name === colour!.name)?.value;
      const colourValue = colour!.optionValues.find((v) => v.name === c);
      if (!f || !fabric!.optionValues.some((v) => v.name === f) || !c || !colourValue) continue;
      const value = JSON.stringify([f, c]);
      if (selections.some((s) => s.value === value)) continue;
      selections.push({ value, label: c, group: f, options: { [fabric!.name]: f, [colour!.name]: c },
        image: colourValue.swatch?.image?.image?.url ?? null, colour: colourValue.swatch?.color ?? null });
    }
  } else if (primary && primary.optionValues.length > 1) {
    for (const v of primary.optionValues) selections.push({ value: v.name, label: v.name, group: null,
      options: { [primary.name]: v.name }, image: v.swatch?.image?.image?.url ?? null, colour: v.swatch?.color ?? null });
  }
  return { selections, fabricOptionName: dependent ? fabric!.name : null,
    selectorLabel: dependent ? colour!.name : fabricValues ? "Fabric" : configuredName,
    optionNames: dependent ? [fabric!.name, colour!.name] : primary ? [primary.name] : [],
    optionName: dependent ? colour!.name : configuredName };
}

export function matchesOptions(variant: NativeVariant, options: Record<string, string>): boolean {
  return Object.entries(options).every(([name, value]) => variant.selectedOptions.some((o) => o.name === name && o.value === value));
}
