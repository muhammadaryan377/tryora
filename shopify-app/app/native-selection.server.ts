import type { ProductPreviewConfig, VisualChoice } from "@prisma/client";
import { matchesOptions, type NativeSelection, type NativeVariant } from "./core/customization";

type Config = ProductPreviewConfig & { choices: VisualChoice[] };

/** Existing per-option restrictions still apply to every dependent combination. */
export function choicesFor(config: Config, selection: NativeSelection): VisualChoice[] {
  return config.choices.filter((c) => c.optionValue === selection.value ||
    c.optionValue === selection.options[config.visualOptionName ?? ""]);
}

export function eligibleVariants(config: Config, variants: NativeVariant[], selection?: NativeSelection) {
  const choices = selection ? choicesFor(config, selection) : [];
  return variants.filter((v) => v.availableForSale &&
    matchesOptions(v, (config.frozenContext ?? {}) as Record<string, string>) &&
    (!selection || matchesOptions(v, selection.options)) &&
    choices.every((c) => {
      const ids = (c.variantIds ?? []) as string[];
      return c.available && (!ids.length || ids.includes(v.id));
    }));
}
