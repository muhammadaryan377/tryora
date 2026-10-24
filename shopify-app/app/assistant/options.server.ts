/**
 * Product options for the Room Assistant's in-card selector (fabric family, colour swatches, size, headboard,
 * storage). Everything is derived from the product's real Shopify variants; a selection always resolves to one exact
 * variant by its original option values, never by a parsed or guessed label.
 *
 * Preview eligibility per variant comes from storefrontConfig, the same verified model the product-page popup uses
 * (readiness, auto-configuration, approved variants, provider rules). Native and explicitly managed native-linked configurations can be previewed from chat. Legacy
 * Cloudlift mappings keep the product-page source-selection handoff.
 */
import { PRESERVATION_OPTION } from "../customization/option-model";
import { TryoraError } from "../core/index";
import type { AdminGraphql } from "../preview-product.server";
import { storefrontConfig } from "../storefront.server";
import { getProductDetails, isRef, realOptions, ShopifyBudget, type CatalogueProduct } from "./catalogue.server";

export type AttributeKind = "fabric" | "colour" | "size" | "headboard" | "storage" | "other";
export interface OptionValue { value: string; colour: string | null; image: string | null; samples?: Record<string, { colour: string | null; image: string | null }> }
export interface OptionAttribute { name: string; kind: AttributeKind; values: OptionValue[] }
export interface OptionVariant {
  ref: string;
  id: string;
  /** Attribute name -> value, for selection. */
  values: Record<string, string>;
  /** The exact Shopify option tuple, for display and links. */
  options: Record<string, string>;
  price: string;
  available: boolean;
  image: string | null;
  /** The preview option key the popup would use for this exact variant, or null when it cannot be previewed. */
  previewOption: string | null;
  referenceImage?: string | null;
  previewContext?: { mappingRevision: string; sourceVariantId: string };
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
  lead: { mode: "required" | "skippable" | "off"; timing: "before" | "after"; showOptIn: boolean; optInWording: string } | null;
}

function kindOf(name: string): AttributeKind {
  const text = name.toLowerCase();
  if (/fabric|material|upholster/.test(text)) return "fabric";
  if (/colou?r|shade|finish/.test(text)) return "colour";
  if (/size|width|dimension/.test(text)) return "size";
  if (/headboard/.test(text)) return "headboard";
  if (/storage|ottoman|drawer/.test(text)) return "storage";
  return "other";
}

const SEGMENTS = /^\s*[^:|]{1,60}:\s*[^:|]{1,80}(\s*\|\s*[^:|]{1,60}:\s*[^:|]{1,80})*\s*$/;
const segments = (value: string) => value.split("|").map((part) => {
  const index = part.indexOf(":");
  return [part.slice(0, index).trim(), part.slice(index + 1).trim()] as const;
});

/**
 * Composite values such as "Plush Velvet: Cream | Headboard: 50 inches | Storage: No Storage" are split for display
 * only when every value of the option follows the same shape: the same number of segments and the same keys after
 * the first. The first segment's key is the fabric family when it varies, otherwise a named attribute.
 */
function compositeShape(values: string[]): { familyVaries: boolean; keys: string[] } | null {
  if (values.length < 2 || !values.every((value) => SEGMENTS.test(value) && value.includes("|"))) return null;
  const parsed = values.map(segments);
  const count = parsed[0]!.length;
  if (!parsed.every((entry) => entry.length === count)) return null;
  const keys = parsed[0]!.map(([key]) => key);
  if (!parsed.every((entry) => entry.every(([key], index) => index === 0 || key === keys[index]))) return null;
  return { familyVaries: !parsed.every((entry) => entry[0]![0] === keys[0]), keys };
}

/** Builds selectable attributes and per-variant attribute values from real Shopify options and variants. */
export function optionModel(product: Pick<CatalogueProduct, "options" | "variants">) {
  const attributes: OptionAttribute[] = [];
  const readers: ((variant: Record<string, string>) => [string, string][])[] = [];
  const add = (name: string, kind?: AttributeKind) => {
    let unique = name;
    for (let i = 2; attributes.some((attribute) => attribute.name === unique); i += 1) unique = `${name} ${i}`;
    attributes.push({ name: unique, kind: kind ?? kindOf(name), values: [] });
    return unique;
  };
  for (const option of realOptions(product.options)) {
    const shape = compositeShape(option.values);
    if (!shape) {
      const name = add(option.name);
      readers.push((variant) => variant[option.name] !== undefined ? [[name, variant[option.name]!]] : []);
      continue;
    }
    const names = shape.familyVaries ? [add("Fabric", "fabric"), add("Colour", "colour")] : [add(shape.keys[0]!)];
    const rest = shape.keys.slice(1).map((key) => add(key));
    readers.push((variant) => {
      const value = variant[option.name];
      if (value === undefined) return [];
      const parsed = segments(value);
      const first: [string, string][] = shape.familyVaries ? [[names[0]!, parsed[0]![0]], [names[1]!, parsed[0]![1]]] : [[names[0]!, parsed[0]![1]]];
      return [...first, ...rest.map((name, index) => [name, parsed[index + 1]![1]] as [string, string])];
    });
  }
  const swatchFor = (attributeName: string, value: string) => {
    for (const option of product.options) {
      const swatch = option.swatches?.[value];
      if (swatch && (option.name === attributeName || attributes.find((attribute) => attribute.name === attributeName)?.kind === "colour")) return swatch;
    }
    return null;
  };
  const variants = product.variants.map((variant) => {
    const values = Object.fromEntries(readers.flatMap((read) => read(variant.options)));
    for (const [name, value] of Object.entries(values)) {
      const attribute = attributes.find((entry) => entry.name === name)!;
      if (!attribute.values.some((entry) => entry.value === value)) {
        const swatch = swatchFor(name, value);
        attribute.values.push({ value, colour: swatch?.colour ?? null, image: swatch?.image ?? null });
      }
    }
    return { variant, values };
  });
  return { attributes: attributes.filter((attribute) => attribute.values.length > 1 || attributes.length === 1), variants };
}

const REASONS = {
  notOffered: "AI room preview isn't offered for this product.",
  productPage: "This configuration is not verified for an in-chat preview. Choose another verified appearance or product.",
  paused: "New AI previews are temporarily unavailable.",
};

export async function productOptionsForAssistant(admin: AdminGraphql, shopId: string, productId: string, sourceVariantId?: string): Promise<ProductOptions> {
  const ref = productId.split("/").pop() ?? "";
  if (!/^gid:\/\/shopify\/Product\/\d{1,20}$/.test(productId) || !isRef(ref)) throw new TryoraError("BAD_REQUEST");
  const [details, config] = await Promise.all([
    getProductDetails(admin, [ref], new ShopifyBudget(6)),
    // The same verified model the product-page popup loads; a failure simply means "not previewable from chat".
    storefrontConfig(admin, shopId, productId).catch(() => ({ enabled: false as const })),
  ]);
  const product = details.get(ref);
  if (!product) throw new TryoraError("NOT_FOUND");
  const preview = config.enabled ? config : null;
  if (sourceVariantId && !product.variants.some((v) => v.id === sourceVariantId)) throw new TryoraError("BAD_REQUEST");
  if (config.enabled && "managerManaged" in config && config.managerManaged && config.providerId === "manual_mapping") {
    return managedOptions(product, config, sourceVariantId);
  }
  const native = !!preview && (!("providerId" in preview) || !preview.providerId || preview.providerId === "shopify_native");
  const previewOption = (variantId: string): string | null => {
    if (!preview || !native) return null;
    if (preview.swatches.length) return preview.swatches.find((swatch) => swatch.available && swatch.variants.some((entry) => entry.id === variantId))?.value ?? null;
    return (preview.singleVariants ?? []).some((entry) => entry.id === variantId) ? "__single__" : null;
  };
  const model = optionModel(product);
  // Fill swatch colours the merchant set for the popup when Shopify has none for a value.
  for (const swatch of preview?.swatches ?? []) {
    for (const attribute of model.attributes) {
      const match = attribute.values.find((entry) => entry.value === swatch.label || entry.value === swatch.value);
      if (match && !match.colour && !match.image) { match.colour = swatch.colour; match.image = swatch.image; }
    }
  }
  return {
    productRef: product.ref,
    productId: product.id,
    title: product.title,
    url: product.url,
    image: product.image,
    imageAlt: product.imageAlt,
    currencyCode: product.currencyCode,
    attributes: model.attributes,
    variants: model.variants.map(({ variant, values }) => ({
      ref: variant.ref,
      id: variant.id,
      values,
      options: Object.fromEntries(Object.entries(variant.options).filter(([name, value]) => !(name === "Title" && value === "Default Title"))),
      price: variant.price,
      available: variant.available,
      image: variant.image,
      previewOption: variant.available ? previewOption(variant.id) : null,
    })),
    singleVariant: product.variants.length === 1 && product.variantsComplete,
    preview: {
      offered: !!preview && native && preview.available,
      reason: !preview ? REASONS.notOffered : !native ? REASONS.productPage : !preview.available ? REASONS.paused : null,
    },
    lead: preview ? preview.lead : null,
  };
}

/** Explicit reviewed manager projection only; legacy/external providers keep their existing product-page handoff. */
function managedOptions(product: CatalogueProduct, preview: any, sourceVariantId?: string): ProductOptions {
  const attributes: OptionAttribute[] = [
    { name: "Fabric", kind: "fabric", values: [] }, { name: "Colour", kind: "colour", values: [] },
  ];
  const extraNames = new Map<string, string>();
  const addExtra = (key: string, label: string) => {
    if (extraNames.has(key)) return extraNames.get(key)!;
    let name = label;
    while (attributes.some((a) => a.name === name)) name = `Shopify ${name}`;
    extraNames.set(key, name); attributes.push({ name, kind: kindOf(label), values: [] }); return name;
  };
  const changing = new Set<string>(preview.selectionOptionNames ?? []);
  const source = sourceVariantId ? preview.productVariants.find((v: any) => v.id === sourceVariantId) : null;
  const variants: OptionVariant[] = [];
  for (const entry of preview.mappedEntries ?? []) {
    const variant = product.variants.find((v) => v.id === entry.variantId);
    if (!variant) continue;
    const projected = preview.productVariants.find((v: any) => v.id === variant.id);
    const equivalent = !sourceVariantId || !!source?.options[PRESERVATION_OPTION] && !!projected && Object.entries(source.options).every(([name, value]) => changing.has(name) || projected.options[name] === value);
    const values: Record<string, string> = { Fabric: entry.fabric, Colour: entry.colour };
    for (const [name, value] of Object.entries(variant.options)) if (!changing.has(name) && !(name === "Title" && value === "Default Title")) values[addExtra(`native:${name}`, name)] = value;
    for (const [name, value] of Object.entries(entry.preserved as Record<string, string>)) values[addExtra(`preserved:${name}`, `Reviewed ${name}`)] = value;
    const swatch = preview.swatches.find((s: any) => s.group === entry.fabric && s.label === entry.colour);
    for (const attribute of attributes) {
      const value = values[attribute.name]; if (value === undefined) continue;
      let option = attribute.values.find((v) => v.value === value);
      if (!option) { option = { value, image: attribute.kind === "fabric" ? preview.fabricImages?.[entry.fabric] ?? null : null, colour: null }; attribute.values.push(option); }
      if (attribute.name === "Colour") { option.samples ??= Object.create(null) as NonNullable<OptionValue["samples"]>; option.samples[entry.fabric] = { image: swatch?.image ?? null, colour: swatch?.colour ?? null }; }
    }
    variants.push({ ref: variant.ref, id: variant.id, values, options: variant.options, price: variant.price, available: variant.available,
      image: variant.image, referenceImage: entry.referenceImage,
      previewOption: variant.available && equivalent && swatch?.available && swatch.variants.some((v: any) => v.id === variant.id) ? swatch.value : null,
      previewContext: { mappingRevision: preview.mappingRevision, sourceVariantId: sourceVariantId ?? variant.id } });
  }
  // Unbound samples stay visible with disabled choices; they never create synthetic native variants.
  for (const swatch of preview.swatches) {
    if (!attributes[0]!.values.some((v) => v.value === swatch.group)) attributes[0]!.values.push({ value: swatch.group, image: preview.fabricImages?.[swatch.group] ?? null, colour: null });
    let colour = attributes[1]!.values.find((v) => v.value === swatch.label);
    if (!colour) { colour = { value: swatch.label, image: null, colour: null }; attributes[1]!.values.push(colour); }
    colour.samples ??= Object.create(null) as NonNullable<OptionValue["samples"]>; colour.samples[swatch.group] = { image: swatch.image, colour: swatch.colour };
  }
  return { productRef: product.ref, productId: product.id, title: product.title, url: product.url, image: product.image, imageAlt: product.imageAlt,
    currencyCode: product.currencyCode, attributes, variants, singleVariant: product.variants.length === 1 && product.variantsComplete,
    preview: { offered: preview.available && variants.some((v) => !!v.previewOption), reason: preview.available ? "This exact configuration needs an approved full-product reference." : REASONS.paused }, lead: preview.lead };
}
