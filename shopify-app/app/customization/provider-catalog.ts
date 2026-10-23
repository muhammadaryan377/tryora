/** Public capability labels only. No credentials, persistence or provider URLs. */
export const STORE_DEFAULT = "__store__";
export const PROVIDERS = ["shopify_native", "cloudlift", "manual_mapping", "unsupported"] as const;
export type ProviderId = typeof PROVIDERS[number];
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  shopify_native: "Shopify Native Options", cloudlift: "Live Product Options by Cloudlift (native-linked mapping)",
  manual_mapping: "Manual / Custom Mapping", unsupported: "Other providers — not yet supported",
};
export function isProviderId(value: string): value is ProviderId { return (PROVIDERS as readonly string[]).includes(value); }
export function providerSummary(id: string, active: boolean) {
  if (id === "shopify_native") return { id, label: "Shopify Native Options", status: "Validated per preview", blocked: false };
  if (id === "manual_mapping") return { id, label: "Manual / Custom Mapping", status: active ? "Mapping active; validated per preview" : "Needs setup: reviewed product mapping required", blocked: !active };
  if (id === "cloudlift") return { id, label: "Live Product Options by Cloudlift (native-linked mapping)",
    status: active ? "Native-linked mapping active; validated against Shopify per preview" : "Needs setup: reviewed exact Shopify variants and media required",
    blocked: !active };
  return { id, label: "Unsupported provider", status: "Needs setup: no verified data source", blocked: true };
}
