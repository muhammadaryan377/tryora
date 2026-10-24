import prisma from "../db.server";
import { STORE_DEFAULT } from "./provider-catalog";

export { STORE_DEFAULT } from "./provider-catalog";
import { providerSettingsEnabled } from "./provider-access.server";
export { providerSettingsEnabled, providerAccess } from "./provider-access.server";
export { PROVIDERS, isProviderId, providerSummary } from "./provider-catalog";
export type { ProviderId } from "./provider-catalog";
export interface ProviderSetting {
  shopId: string; productId: string; providerId: string; revision: string; active: boolean; mapping: unknown;
}
export function effectiveSetting(shopId: string, productId: string, rows: ProviderSetting[]): ProviderSetting {
  const scoped = rows.filter((r) => r.shopId === shopId);
  return scoped.find((r) => r.productId === productId) ?? scoped.find((r) => r.productId === STORE_DEFAULT) ??
    { shopId, productId, providerId: "shopify_native", revision: "legacy-native", active: true, mapping: null };
}
export async function loadProviderSetting(shopId: string, productId: string) {
  // Backward compatibility: no new-table reads before the explicit schema rollout.
  const rows = providerSettingsEnabled(shopId) ? await prisma.customizationConfig.findMany({
    where: { shopId, productId: { in: [STORE_DEFAULT, productId] } },
  }) : [];
  return effectiveSetting(shopId, productId, rows);
}
