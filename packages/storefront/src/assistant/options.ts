/**
 * In-card product option selection (fabric family, colour swatches, size, headboard, storage).
 * The data comes from the server's /assistant/options, which reads real Shopify variants and the product page's own
 * preview model. A selection resolves to exactly one Shopify variant or to nothing; it never picks a "closest" one.
 */
import type { Recommendation } from "./session.js";

export interface OptionValue { value: string; colour: string | null; image: string | null; samples?: Record<string, { colour: string | null; image: string | null }> }
export interface OptionAttribute { name: string; kind: "fabric" | "colour" | "size" | "headboard" | "storage" | "other"; values: OptionValue[] }
export interface OptionVariant {
  ref: string;
  id: string;
  values: Record<string, string>;
  options: Record<string, string>;
  price: string;
  available: boolean;
  image: string | null;
  previewOption: string | null;
  referenceImage?: string | null;
  previewContext?: { mappingRevision: string; sourceVariantId: string; pageSourceVariantId?: string };
}
export interface ProductOptions {
  productRef: string;
  productId: string;
  title: string;
  url: string;
  image: string | null;
  imageAlt: string | null;
  currencyCode: string;
  attributes: OptionAttribute[];
  variants: OptionVariant[];
  singleVariant: boolean;
  preview: { offered: boolean; reason: string | null };
}

export interface ValueState extends OptionValue { selected: boolean; disabled: boolean; soldOut: boolean }

const matches = (variant: OptionVariant, selections: Record<string, string>, except?: string) =>
  Object.entries(selections).every(([name, value]) => name === except || variant.values[name] === value);

/**
 * The values to show for one attribute given the other selections. Colours follow the chosen fabric family (other
 * families' colours are hidden); any value with no matching variant is disabled, and all-sold-out values are marked.
 */
export function valuesFor(data: ProductOptions, attribute: OptionAttribute, selections: Record<string, string>): ValueState[] {
  const fabric = data.attributes.find((entry) => entry.kind === "fabric" && entry !== attribute);
  const family = attribute.kind === "colour" && fabric ? selections[fabric.name] : undefined;
  const sampleFor = (option: OptionValue) => family && option.samples && Object.prototype.hasOwnProperty.call(option.samples, family) ? option.samples[family] : undefined;
  return attribute.values
    .filter((option) => !family || !!sampleFor(option) || data.variants.some((variant) => variant.values[fabric!.name] === family && variant.values[attribute.name] === option.value))
    .map((option) => {
      const dependentColour = attribute.kind === "fabric" ? data.attributes.find((a) => a.kind === "colour")?.name : undefined;
      const kept = Object.fromEntries(Object.entries(selections).filter(([name]) => name !== dependentColour));
      const candidates = data.variants.filter((variant) => variant.values[attribute.name] === option.value && matches(variant, kept, attribute.name));
      return {
        ...option,
        ...(sampleFor(option) ?? {}),
        selected: selections[attribute.name] === option.value,
        disabled: candidates.length === 0,
        soldOut: candidates.length > 0 && candidates.every((variant) => !variant.available),
      };
    });
}

/** The single variant matching every attribute, or null while the selection is incomplete or matches nothing. */
export function resolveVariant(data: ProductOptions, selections: Record<string, string>): OptionVariant | null {
  if (!data.attributes.every((attribute) => selections[attribute.name] !== undefined)) return null;
  const found = data.variants.filter((variant) => data.attributes.every((attribute) => variant.values[attribute.name] === selections[attribute.name]));
  return found.length === 1 ? found[0]! : null;
}

/** The selections that describe an existing variant (used to pre-fill the selector from a card's variant). */
export function selectionsFor(data: ProductOptions, variantRef: string | null): Record<string, string> {
  const variant = variantRef ? data.variants.find((entry) => entry.ref === variantRef) : null;
  if (!variant) return {};
  return Object.fromEntries(data.attributes.map((attribute) => [attribute.name, variant.values[attribute.name]!]).filter(([, value]) => value !== undefined));
}

/**
 * The card for one exact variant. The image is that variant's own photo when it has one; otherwise the product photo,
 * flagged so the card labels it. Preview is offered only when the product page would offer it for this variant.
 */
export function cardForVariant(item: Recommendation, data: ProductOptions, variant: OptionVariant, previewsAvailable: boolean): Recommendation {
  const preview = data.preview.offered && previewsAvailable && variant.available && !!variant.previewOption;
  const reason = preview ? null
    : !variant.available ? "This option is sold out, so it can't be previewed."
      : !previewsAvailable ? "New AI previews are temporarily unavailable."
        : data.preview.reason ?? "This exact option isn't approved for AI room preview.";
  const optionText = Object.values(variant.options).join(" / ");
  return {
    ...item,
    id: `${data.productRef}:${variant.ref}`,
    variantRef: variant.ref,
    variantId: variant.id,
    url: `${data.url}?variant=${encodeURIComponent(variant.ref)}`,
    options: variant.options,
    price: variant.price,
    maxPrice: null,
    currencyCode: data.currencyCode,
    purchaseAvailable: variant.available,
    image: variant.image ?? data.image,
    imageAlt: optionText ? `${data.title}, ${optionText}` : data.title,
    imageSource: variant.image ? "variant" : data.image ? "product" : null,
    referenceImage: variant.referenceImage ?? null,
    previewContext: variant.previewContext,
    previewAvailable: preview,
    previewStatus: preview ? "available" : data.preview.offered ? "unavailable" : "not_configured",
    previewReason: reason,
    optionValue: preview ? variant.previewOption : null,
    variantCount: data.variants.length,
    hasOptions: data.attributes.length > 0 && data.variants.length > 1,
  };
}
