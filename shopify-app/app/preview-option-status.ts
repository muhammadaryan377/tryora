import { discoverNativeOptions, nativeOptionRole } from "./core/native-option-discovery";

type SavedMapping = { visualOptionName: string | null; autoConfigured: boolean };
type NativeOption = { name: string; values: string[] };

/** Admin diagnostics only: absence of native data does not prove a single style. */
export function previewOptionStatus(options: NativeOption[], name: string | null, saved?: SavedMapping) {
  const discovery = discoverNativeOptions(options);
  const ambiguity = {
    state: "ambiguous" as const, label: "Ambiguous native appearance options",
    warning: "Multiple Shopify options describe the same appearance setting. Open settings to inspect the option names. Resolve duplicate appearance fields before enabling a dependent preview.",
  };
  if (name !== null) {
    const option = options.find((o) => o.name === name);
    if (!option) return {
      state: "stale" as const,
      label: `Unavailable option: ${name}`,
      warning: "The saved preview option is no longer in this product's Shopify options. Open settings to review and select an available option, or configure no selector.",
    };
    if (nativeOptionRole(name) && discovery.ambiguous) return ambiguity;
    return { state: "mapped" as const,
      label: `${name} (${option.values.length} ${option.values.length === 1 ? "value" : "values"})`, warning: null };
  }
  if (saved && !saved.autoConfigured && saved.visualOptionName === null) return {
    state: "configured_without_selector" as const,
    label: "Configured without selector",
    warning: null,
  };
  if (discovery.ambiguous) return ambiguity;
  return { state: "missing" as const, label: "No preview option found or configured", warning: null };
}
