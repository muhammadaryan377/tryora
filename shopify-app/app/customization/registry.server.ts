import { TryoraError } from "../core/index";
import { shopifyNativeAdapter } from "./adapters/shopify-native.server";
import { cloudliftAdapter } from "./adapters/cloudlift.server";
import { manualMappingAdapter } from "./adapters/manual-mapping.server";
import type { ProviderAdapter, ProviderContext } from "./adapters/types.server";
import { STORE_DEFAULT } from "./provider-config.server";

const unsupported: ProviderAdapter = { ...cloudliftAdapter, providerId: "unsupported", label: "Other providers — not yet supported" };
const registry = new Map<string, ProviderAdapter>([shopifyNativeAdapter, cloudliftAdapter, manualMappingAdapter, unsupported].map((a) => [a.providerId, Object.freeze({ ...a, capabilities: Object.freeze({ ...a.capabilities }) })]));
export function providerAdapter(id: string): ProviderAdapter { return registry.get(id) ?? unsupported; }
export function providerDiagnostic(id: string, active: boolean) {
  const adapter = providerAdapter(id);
  return { label: adapter.label, status: adapter.capabilities.authorization && (id === "shopify_native" || active) ? "Ready for validation" : "Needs setup" };
}
export async function resolveConfiguredPreview(context: ProviderContext, option: string, variantId?: string, revision?: string) {
  if (context.setting.shopId !== context.config.shopId || ![context.config.productId, STORE_DEFAULT].includes(context.setting.productId)) throw new TryoraError("BAD_REQUEST");
  const adapter = providerAdapter(context.setting.providerId);
  let result;
  try { result = await adapter.validate(context, { scope: { shopId: context.config.shopId, productId: context.config.productId },
    revision: revision ?? "", combinationId: option, nativeVariantId: variantId ?? "", selectedOptions: {} }); }
  catch (error) { if (error instanceof TryoraError) throw error; throw new TryoraError("BAD_REQUEST"); }
  if (result.status !== "approved" || !result.product) throw new TryoraError("BAD_REQUEST");
  return result.product;
}
