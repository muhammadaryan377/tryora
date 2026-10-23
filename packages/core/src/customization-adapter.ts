/** Server-side contract for future verified providers; no external adapter is registered. */
export interface CustomizationScope {
  shopId: string;
  productId: string;
}

export interface VerifiedCustomizationSnapshot {
  scope: CustomizationScope;
  providerId: string;
  providerVersion?: string;
  nativeOptionCatalog?: { id: string; name: string; values: { id: string; name: string }[] }[];
  /** Version for revalidation/idempotency; never use another merchant's snapshot. */
  revision: string;
  verifiedAt: string;
  source: "shopify_native" | "verified_external";
  combinations: {
    id: string;
    nativeVariantId: string;
    options: Record<string, string>;
    available: boolean;
    /** Merchant/provider supplied samples; not generation references. */
    swatches: { optionName: string; value: string; imageUrl: string | null }[];
  }[];
}

export type CustomizationDiscovery =
  | { status: "unsupported"; reason: "unverified_provider" | "unreadable_source" | "missing_mapping" }
  | { status: "verified"; snapshot: VerifiedCustomizationSnapshot };

export type CustomizationValidation =
  | { status: "rejected"; reason: "stale" | "unavailable" | "missing_reference" | "unsupported" }
  | { status: "approved"; scope: CustomizationScope; nativeVariantId: string;
      options: Record<string, string>; referenceUrls: [string, ...string[]]; referenceVersion: string };

/** Credentials stay in a server-owned context, not snapshots or client requests.
 * Implementations must enforce scope, re-read availability, validate every selected
 * option, and resolve approved full-product references. Client URLs are never approvals. */
export interface CustomizationAdapter<AuthenticatedContext> {
  readonly providerId: string;
  discover(context: AuthenticatedContext, scope: CustomizationScope): Promise<CustomizationDiscovery>;
  validate(context: AuthenticatedContext, request: {
    scope: CustomizationScope;
    revision: string;
    combinationId: string;
    nativeVariantId: string;
    selectedOptions: Record<string, string>;
  }): Promise<CustomizationValidation>;
}
