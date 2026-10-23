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

/**
 * Resolve the exact native source variant from the storefront's current state.
 *
 * Server-provided variant options can include two Tryora-only display keys.
 * These are NOT native Shopify option names: ignore them when counting native
 * dimensions, but require their values to agree with the candidate if present.
 * Reject unknown pseudo-options and incomplete/ambiguous native tuples.
 * The backend independently verifies the returned source variant.
 */
export function nativeSourceVariantId(
  pageOptions: Record<string, string>,
  variants: readonly { id: string; options: Record<string, string> }[],
): string | null {
  const virtual = new Set(["__tryora_preserved_configuration__", "__tryora_mapped_fabric__"]);
  const entries = Object.entries(pageOptions);
  const native = entries.filter(([name]) => !virtual.has(name));
  if (!native.length || entries.some(([name, value]) =>
    !name || !value || name === "__unsupported_variant__" ||
    (name.startsWith("__tryora_") && !virtual.has(name)))) return null;
  const exact = variants.filter((v) => {
    const nativeKeys = Object.keys(v.options).filter((name) => !virtual.has(name));
    return nativeKeys.length === native.length &&
      native.every(([name, value]) => v.options[name] === value) &&
      entries.filter(([name]) => virtual.has(name))
        .every(([name, value]) => v.options[name] === value);
  });
  return exact.length === 1 ? exact[0]!.id : null;
}
