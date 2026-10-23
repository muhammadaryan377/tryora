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
