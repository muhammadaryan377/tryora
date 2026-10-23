/**
 * Cloudlift documents option:changed with e.detail.name and e.detail.value.
 * This is a UI change signal ONLY. It must not authorize a variant or image.
 * Unknown/non-native options are intentionally classified unsupported.
 */
export type CloudliftSignal =
  | { kind: "native"; name: string; value: string }
  | { kind: "unverified" };

export function classifyCloudliftOption(detail: unknown, nativeOptionNames: ReadonlySet<string>): CloudliftSignal {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return { kind: "unverified" };
  const { name, value } = detail as Record<string, unknown>;
  if (typeof name !== "string" || !name || name.length > 256 ||
      typeof value !== "string" || !value || value.length > 2048 ||
      !nativeOptionNames.has(name)) return { kind: "unverified" };
  return { kind: "native", name, value };
}

/** Ignore virtual display dimensions when finding the exact real Shopify source. */
export function nativeSourceVariantId(
  pageOptions: Record<string, string>,
  variants: readonly { id: string; options: Record<string, string> }[],
): string | null {
  const entries = Object.entries(pageOptions);
  if (!entries.length || entries.some(([name, value]) => !name || !value || name.startsWith("__tryora_") || name === "__unsupported_variant__")) return null;
  const exact = variants.filter((v) =>
    Object.keys(v.options).filter((name) => !name.startsWith("__tryora_")).length === entries.length &&
    entries.every(([name, value]) => v.options[name] === value));
  return exact.length === 1 ? exact[0]!.id : null;
}
