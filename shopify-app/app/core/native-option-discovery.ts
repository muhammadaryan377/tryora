// GENERATED from packages/core/src by scripts/sync-core.mjs. Do not edit here.
export type NativeOptionRole = "fabric" | "colour" | "finish";

/** Bounded aliases classify names only, never values or availability. Original names
 * remain the Shopify identity; normalization must not repair saved mappings. */
export function nativeOptionRole(name: string): NativeOptionRole | null {
  const normalized = name.normalize("NFKC").trim().toLowerCase()
    .replace(/^\d+[.)]\s+/, "")
    .replace(/[_-]+/g, " ").replace(/\s+/g, " ").replace(/:$/, "").trim()
    .replace(/^(?:choose|select) (?:your )?/, "");
  if (["fabric", "fabric type", "upholstery fabric"].includes(normalized)) return "fabric";
  if (["colour", "color", "fabric colour", "fabric color", "upholstery colour", "upholstery color"].includes(normalized)) return "colour";
  if (["finish", "wood finish"].includes(normalized)) return "finish";
  return null;
}

export function discoverNativeOptions<T extends { name: string }>(options: T[]) {
  const candidates = (role: NativeOptionRole) => options.filter((o) => nativeOptionRole(o.name) === role);
  const fabrics = candidates("fabric"), colours = candidates("colour"), finishes = candidates("finish");
  const ambiguous = fabrics.length > 1 || colours.length > 1 || finishes.length > 1;
  const fabric = fabrics.length === 1 ? fabrics[0]! : null;
  const colour = colours.length === 1 ? colours[0]! : null;
  const finish = finishes.length === 1 ? finishes[0]! : null;
  return { fabric, colour, finish, ambiguous,
    recommendedName: ambiguous ? null : (colour ?? fabric ?? finish)?.name ?? null };
}
