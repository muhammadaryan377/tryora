import type { ProductPreviewConfig, VisualChoice } from "@prisma/client";
import type { AdminGraphql, resolvePreviewProduct } from "../../preview-product.server";
import type { CustomizationAdapter, CustomizationValidation } from "../../core/customization-adapter";
import type { ProviderSetting } from "../provider-config.server";
import { STORE_DEFAULT } from "../provider-catalog";
import type { PreviewIssue } from "../preview-issues";

export interface ProviderContext {
  admin: AdminGraphql;
  config: ProductPreviewConfig & { choices: VisualChoice[] };
  setting: ProviderSetting;
  sourceVariantId?: string;
}
export type PreviewProduct = Awaited<ReturnType<typeof resolvePreviewProduct>> & {
  /** Never treat a virtual AI recolour as a Shopify sale variant. */
  previewOnlyAppearance?: { fabric: string; colour: string; hex: string | null };
};
/** issue explains a rejection precisely; it never changes whether the request is approved. */
export type ProviderValidation = CustomizationValidation & { product?: PreviewProduct; issue?: PreviewIssue };
export interface ProviderAdapter extends CustomizationAdapter<ProviderContext> {
  readonly version: string;
  readonly label: string;
  readonly capabilities: { discovery: boolean; selectionEvents: boolean; authorization: boolean };
  validate(context: ProviderContext, request: Parameters<CustomizationAdapter<ProviderContext>["validate"]>[1]): Promise<ProviderValidation>;
}

/** Defense in depth for direct adapter callers as well as the registry entry point. */
export function matchesProviderScope(context: ProviderContext, scope: { shopId: string; productId: string }, providerId: string) {
  return context.config.shopId === scope.shopId && context.config.productId === scope.productId &&
    context.setting.shopId === scope.shopId && [scope.productId, STORE_DEFAULT].includes(context.setting.productId) &&
    context.setting.providerId === providerId;
}
