import { createHash } from "node:crypto";
import type { NativeVariant } from "../core/customization";

export const PRESERVATION_OPTION = "__tryora_preserved_configuration__";
export const MAPPED_FABRIC_OPTION = "__tryora_mapped_fabric__";
export interface ManualEntry {
  id: string; variantId: string; nativeOptions: Record<string, string>;
  fabric: { id: string; label: string }; colour: { id: string; label: string };
  preserved: Record<string, string>;
  referenceMediaIds: string[]; swatchMediaId?: string;
}
export interface ManualMapping {
  schemaVersion: 1; providerId: "manual_mapping"; shopId: string; productId: string;
  reviewed: true;
  roles: { fabric?: string; colour?: string; composite?: string; size?: string };
  entries: ManualEntry[];
}
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown, max = 2048): x is string => typeof x === "string" && x.length > 0 && x.length <= max;
const forbidden = new Set(["__proto__", "constructor", "prototype", PRESERVATION_OPTION, MAPPED_FABRIC_OPTION]);
function strings(x: unknown): x is Record<string, string> {
  return record(x) && Object.keys(x).length <= 32 && Object.entries(x).every(([k, v]) => text(k, 256) && !forbidden.has(k) && text(v));
}
function exactKeys(x: Record<string, unknown>, allowed: string[]) { return Object.keys(x).every((k) => allowed.includes(k)); }
export function canonicalOptions(x: Record<string, string>) { return JSON.stringify(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)); }
export function optionsOf(v: NativeVariant) { return Object.fromEntries(v.selectedOptions.map((o) => [o.name, o.value])); }
export function preservationKey(entry: ManualEntry) { return createHash("sha256").update(canonicalOptions(entry.preserved)).digest("hex"); }

/** Strict input boundary. Labels and full native strings are never parsed by delimiter. */
export function parseManualMapping(input: unknown, shopId: string, productId: string): ManualMapping {
  if (!record(input) || !exactKeys(input, ["schemaVersion", "providerId", "shopId", "productId", "reviewed", "roles", "entries"]) ||
    input.schemaVersion !== 1 || input.providerId !== "manual_mapping" || input.shopId !== shopId || input.productId !== productId ||
    input.reviewed !== true || !record(input.roles) || !exactKeys(input.roles, ["fabric", "colour", "composite", "size"]) ||
    !Object.values(input.roles).every((v) => text(v, 256)) || new Set(Object.values(input.roles)).size !== Object.values(input.roles).length ||
    !Array.isArray(input.entries) || !input.entries.length || input.entries.length > 2048 || JSON.stringify(input).length > 512_000) {
    throw new Error("Invalid, unreviewed or incorrectly scoped mapping.");
  }
  const ids = new Set<string>(), variants = new Set<string>(), tuples = new Set<string>();
  let preservedKeys: string | undefined;
  for (const value of input.entries) {
    if (!record(value) || !exactKeys(value, ["id", "variantId", "nativeOptions", "fabric", "colour", "preserved", "referenceMediaIds", "swatchMediaId"]) ||
      !text(value.id, 128) || !text(value.variantId, 128) || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(value.variantId) ||
      !strings(value.nativeOptions) || !Object.keys(value.nativeOptions).length || !strings(value.preserved) ||
      !Array.isArray(value.referenceMediaIds) || !value.referenceMediaIds.length || value.referenceMediaIds.length > 4 ||
      !value.referenceMediaIds.every((id) => typeof id === "string" && /^gid:\/\/shopify\/MediaImage\/\d+$/.test(id)) ||
      (value.swatchMediaId !== undefined && (typeof value.swatchMediaId !== "string" || !/^gid:\/\/shopify\/MediaImage\/\d+$/.test(value.swatchMediaId)))) throw new Error("Invalid mapping entry or full-product reference.");
    for (const field of [value.fabric, value.colour]) if (!record(field) || !exactKeys(field, ["id", "label"]) || !text(field.id, 128) || !text(field.label, 256)) throw new Error("Invalid fabric or colour identity.");
    if (value.swatchMediaId && value.referenceMediaIds.includes(value.swatchMediaId)) throw new Error("A swatch sample cannot also approve a full-product reference.");
    const tuple = canonicalOptions(value.nativeOptions);
    if (ids.has(value.id) || variants.has(value.variantId) || tuples.has(tuple)) throw new Error("Ambiguous duplicate mapping binding.");
    ids.add(value.id); variants.add(value.variantId); tuples.add(tuple);
    const keys = JSON.stringify(Object.keys(value.preserved).sort());
    if (preservedKeys !== undefined && preservedKeys !== keys) throw new Error("Missing preserved configuration dimensions.");
    preservedKeys = keys;
    for (const name of Object.values(input.roles) as string[]) if (!(name in value.nativeOptions)) throw new Error("Mapped role is missing from the exact native tuple.");
    for (const role of ["fabric", "colour"] as const) {
      const name = input.roles[role];
      if (typeof name === "string" && value.nativeOptions[name] !== (value[role] as { label: string }).label) throw new Error("Conflicting native and mapped appearance.");
    }
    if (input.roles.composite && !Object.keys(value.preserved).length) throw new Error("Composite mappings require explicit reviewed preservation dimensions.");
  }
  const identity = new Map<string, string>(), composites = new Map<string, string>();
  for (const raw of input.entries) {
    const e = raw as unknown as ManualEntry;
    for (const role of ["fabric", "colour"] as const) {
      const key = role + ":" + e[role].id;
      if (identity.has(key) && identity.get(key) !== e[role].label) throw new Error("Conflicting stable appearance identity.");
      identity.set(key, e[role].label);
    }
    const compositeRole = input.roles.composite;
    if (typeof compositeRole === "string") {
      const rawValue = JSON.stringify([e.nativeOptions[compositeRole], typeof input.roles.fabric === "string" ? e.nativeOptions[input.roles.fabric] : null]);
      const meaning = JSON.stringify([e.fabric, e.colour, canonicalOptions(e.preserved)]);
      if (composites.has(rawValue) && composites.get(rawValue) !== meaning) throw new Error("Conflicting composite value meanings.");
      composites.set(rawValue, meaning);
    }
  }
  // Detach from mutable form objects. Never retain arbitrary prototypes or extra keys.
  return JSON.parse(JSON.stringify(input)) as ManualMapping;
}

export function validateNativeBindings(mapping: ManualMapping, variants: NativeVariant[], media: { id: string; image?: { url: string } | null }[]) {
  const errors: string[] = [];
  const byId = new Map<string, NativeVariant[]>();
  for (const v of variants) byId.set(v.id, [...(byId.get(v.id) ?? []), v]);
  const mediaById = new Map(media.map((m) => [m.id, m]));
  for (const e of mapping.entries) {
    const matches = (byId.get(e.variantId) ?? []).filter((v) => canonicalOptions(optionsOf(v)) === canonicalOptions(e.nativeOptions));
    if (matches.length !== 1) errors.push(`Entry ${e.id}: stale or missing exact variant binding.`);
    for (const id of [...e.referenceMediaIds, ...(e.swatchMediaId ? [e.swatchMediaId] : [])]) {
      const m = mediaById.get(id);
      if (!m?.image?.url || !safeShopifyMediaUrl(m.image.url)) errors.push(`Entry ${e.id}: missing or unsafe product media.`);
    }
  }
  return errors;
}
export function safeShopifyMediaUrl(value: string) {
  try { const u = new URL(value); return u.protocol === "https:" && u.hostname === "cdn.shopify.com" && !u.username && !u.password && !u.port; } catch { return false; }
}
