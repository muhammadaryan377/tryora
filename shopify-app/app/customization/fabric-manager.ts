/** Merchant-authored preview-only catalogue metadata. Sample images may be standalone Shopify Files; full furniture references remain product-owned. */
import type { ManualMapping } from "./option-model";
export class FabricConfigError extends Error {}
export interface ManagedColour { id: string; name: string; enabled: boolean; swatchMediaId: string | null; hex: string | null }
export interface ManagedFabric { id: string; name: string; description: string; enabled: boolean; textureMediaId: string | null; /** Optional on legacy records; required on new entries if no image is provided. */ hex?: string | null; colours: ManagedColour[] }
export interface SwatchPresentation { shape: "round" | "square"; size: number }
export const DEFAULT_SWATCH_PRESENTATION: SwatchPresentation = { shape: "round", size: 50 };
export function validSwatchPresentation(value: unknown): value is SwatchPresentation {
  if (!record(value) || !keys(value, ["shape", "size"])) return false;
  return (value.shape === "round" || value.shape === "square") && typeof value.size === "number" &&
    Number.isInteger(value.size) && value.size >= 25 && value.size <= 100;
}
export interface ManagedBinding {
  id: string; fabricId: string; colourId: string; variantId: string | null;
  nativeOptions: Record<string, string>; preserved: Record<string, string>; externalValues: Record<string, string>;
  referenceMediaIds: string[]; reviewed: boolean;
}
export interface FabricDraft { fabrics: ManagedFabric[]; bindings: ManagedBinding[]; roles: ManualMapping["roles"]; /** Optional for older saved records. */ presentation?: SwatchPresentation }
export interface FabricDocument {
  kind: "fabric_colour_manager"; schemaVersion: 1; shopId: string; productId: string;
  draft: FabricDraft; published: ManualMapping | null;
}
export const emptyFabricDraft = (): FabricDraft => ({ fabrics: [], bindings: [], roles: {} });
export const isFabricDocument = (value: unknown): value is FabricDocument => !!value && typeof value === "object" && (value as any).kind === "fabric_colour_manager";
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const id = (x: unknown): x is string => typeof x === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(x);
const text = (x: unknown, max: number): x is string => typeof x === "string" && x.trim().length > 0 && x.length <= max && !/[\u0000-\u001f]/.test(x);
const media = (x: unknown) => typeof x === "string" && /^gid:\/\/shopify\/MediaImage\/\d+$/.test(x);
const nullableMedia = (x: unknown) => x === null || media(x);
const keys = (x: Record<string, unknown>, allowed: string[]) => Object.keys(x).every((k) => allowed.includes(k));
const strings = (x: unknown): x is Record<string, string> => record(x) && Object.keys(x).length <= 32 && Object.entries(x).every(([k, v]) =>
  text(k, 256) && !["constructor", "prototype", "__proto__", "__tryora_preserved_configuration__", "__tryora_mapped_fabric__"].includes(k) && text(v, 2048));

export function parseFabricDraft(raw: unknown): FabricDraft {
  if (!record(raw) || !keys(raw, ["fabrics", "bindings", "roles", "presentation"]) || (raw.presentation !== undefined && !validSwatchPresentation(raw.presentation)) || !Array.isArray(raw.fabrics) || raw.fabrics.length > 100 ||
      !Array.isArray(raw.bindings) || raw.bindings.length > 2048 || !strings(raw.roles) || !keys(raw.roles, ["fabric", "colour", "size", "composite"]) ||
      new Set(Object.values(raw.roles)).size !== Object.values(raw.roles).length || JSON.stringify(raw).length > 900_000) throw new FabricConfigError("Invalid or oversized fabric configuration.");
  const fabricIds = new Set<string>(), names = new Set<string>(), colourIds = new Set<string>();
  const pairs = new Set<string>();
  for (const fabric of raw.fabrics) {
    if (!record(fabric) || !keys(fabric, ["id", "name", "description", "enabled", "textureMediaId", "hex", "colours"]) || !id(fabric.id) || !text(fabric.name, 140) ||
        typeof fabric.description !== "string" || fabric.description.length > 1000 || typeof fabric.enabled !== "boolean" || !nullableMedia(fabric.textureMediaId) ||
        !(fabric.hex === undefined || fabric.hex === null || typeof fabric.hex === "string" && /^#[0-9a-fA-F]{6}$/.test(fabric.hex)) ||
        !Array.isArray(fabric.colours) || fabric.colours.length > 100 || fabricIds.has(fabric.id) || names.has(fabric.name.trim().toLocaleLowerCase())) throw new FabricConfigError("Fabric names and IDs must be unique; use a valid HEX colour or uploaded sample image.");
    fabricIds.add(fabric.id); names.add(fabric.name.trim().toLocaleLowerCase());
    const colourNames = new Set<string>();
    for (const colour of fabric.colours) {
      if (!record(colour) || !keys(colour, ["id", "name", "enabled", "swatchMediaId", "hex"]) || !id(colour.id) || !text(colour.name, 140) ||
          typeof colour.enabled !== "boolean" || !nullableMedia(colour.swatchMediaId) || !(colour.hex === null || typeof colour.hex === "string" && /^#[0-9a-fA-F]{6}$/.test(colour.hex)) ||
          colourIds.has(colour.id) || colourNames.has(colour.name.trim().toLocaleLowerCase())) throw new FabricConfigError("Colours need unique IDs and unique names within their fabric; HEX must be #RRGGBB.");
      colourIds.add(colour.id); colourNames.add(colour.name.trim().toLocaleLowerCase()); pairs.add(`${fabric.id}:${colour.id}`);
    }
  }
  const bindings = new Set<string>(), variants = new Set<string>();
  for (const binding of raw.bindings) {
    if (!record(binding) || !keys(binding, ["id", "fabricId", "colourId", "variantId", "nativeOptions", "preserved", "externalValues", "referenceMediaIds", "reviewed"]) ||
        !id(binding.id) || !id(binding.fabricId) || !id(binding.colourId) || !pairs.has(`${binding.fabricId}:${binding.colourId}`) || bindings.has(binding.id) ||
        !(binding.variantId === null || typeof binding.variantId === "string" && /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(binding.variantId)) ||
        !strings(binding.nativeOptions) || !strings(binding.preserved) || !strings(binding.externalValues) || typeof binding.reviewed !== "boolean" ||
        !Array.isArray(binding.referenceMediaIds) || binding.referenceMediaIds.length > 4 || !binding.referenceMediaIds.every(media) ||
        new Set(binding.referenceMediaIds).size !== binding.referenceMediaIds.length) throw new FabricConfigError("Invalid, duplicate or incorrectly linked product-reference mapping.");
    bindings.add(binding.id);
    if (binding.variantId) {
      if (variants.has(binding.variantId)) throw new FabricConfigError("Each exact Shopify variant can have only one fabric/colour binding.");
      variants.add(binding.variantId);
    } else if (Object.keys(binding.nativeOptions).length) throw new FabricConfigError("Native option values require an exact Shopify variant.");
  }
  return JSON.parse(JSON.stringify(raw)) as FabricDraft;
}
/** Check merchant-created preview-only fabric/colour entries before saving to the database.
 * Legacy variant-bound mappings stay readable and unchanged until explicitly migrated.
 */
export function validateFabricAppearance(draft: FabricDraft): void {
  for (const fabric of draft.fabrics) {
    if (!fabric.name.trim() || !(fabric.textureMediaId || fabric.hex)) {
      throw new FabricConfigError("Each fabric needs a name and either a HEX colour or a texture image.");
    }
    for (const colour of fabric.colours) {
      if (!colour.name.trim() || !(colour.hex || colour.swatchMediaId)) {
        throw new FabricConfigError("Each colour needs a name and either a HEX colour or a sample image.");
      }
    }
  }
}
export function parseFabricDocument(raw: unknown, shopId: string, productId: string): FabricDocument {
  if (!record(raw) || !keys(raw, ["kind", "schemaVersion", "shopId", "productId", "draft", "published"]) || raw.kind !== "fabric_colour_manager" ||
      raw.schemaVersion !== 1 || raw.shopId !== shopId || raw.productId !== productId || !(raw.published === null || record(raw.published))) throw new FabricConfigError("Fabric configuration belongs to a different shop/product or has an unsupported format.");
  return { kind: "fabric_colour_manager", schemaVersion: 1, shopId, productId, draft: parseFabricDraft(raw.draft), published: raw.published as ManualMapping | null };
}
