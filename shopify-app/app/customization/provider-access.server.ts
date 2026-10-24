/** Operator-controlled rollout. Never accept installation grants from a request/form. */
export type ProviderAccessReason = "rollout_disabled" | "installation_not_authorized" | "invalid_allowlist" | null;
export function providerAccess(shopId: string, env: NodeJS.ProcessEnv = process.env): { enabled: boolean; reason: ProviderAccessReason } {
  if (env.TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED !== "true") return { enabled: false, reason: "rollout_disabled" };
  const domain = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;
  const authenticatedShop = typeof shopId === "string" ? shopId.toLowerCase() : "";
  if (!domain.test(authenticatedShop)) return { enabled: false, reason: "installation_not_authorized" };
  const configured = env.TRYORA_CUSTOMIZATION_PROVIDERS_SHOPS;
  // Preserve the existing explicitly enabled global rollout when no scoped policy is configured.
  if (configured === undefined) return { enabled: true, reason: null };
  const shops = configured.trim() ? configured.split(",").map((s) => s.trim().toLowerCase()) : [];
  if (configured.length > 65000 || shops.length > 1000 || shops.some((s) => !domain.test(s))) return { enabled: false, reason: "invalid_allowlist" };
  return shops.includes(authenticatedShop)
    ? { enabled: true, reason: null } : { enabled: false, reason: "installation_not_authorized" };
}
export const providerSettingsEnabled = (shopId: string) => providerAccess(shopId).enabled;
