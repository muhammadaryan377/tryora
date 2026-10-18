// Shared domain types for Tryora's core engine.
// Nothing in this package stores image bytes: jobs refer to photos by an opaque hash only.

export type ShopId = string;
export type JobId = string;

/** Where a credit came from. Consumption order is defined in ledger.ts. */
export type CreditBucket = "trial" | "period" | "refund" | "topup";

export type LedgerEntryType =
  | "GRANT" // credits added (trial, billing period, paid top-up, refund restore)
  | "RESERVE" // one credit held for a running job
  | "CONSUME" // reservation settled after a valid result was delivered
  | "RELEASE"; // reservation returned (rejected input, failed or abandoned job)

export interface LedgerEntry {
  id: string;
  shopId: ShopId;
  type: LedgerEntryType;
  quantity: number;
  /** Unique per shop. Makes every grant, reservation and settlement idempotent. */
  reference: string;
  /** For GRANT entries: which bucket. For RESERVE/CONSUME/RELEASE: the grant they draw on. */
  bucket?: CreditBucket;
  grantId?: string;
  jobId?: JobId;
  /** GRANT entries only: credits cannot be newly reserved at or after this time. */
  expiresAt?: Date;
  createdAt: Date;
}

export type JobState =
  | "CREATED"
  | "VALIDATING"
  | "RESERVED"
  | "QUEUED"
  | "GENERATING"
  | "CHECKING_RESULT"
  | "READY_TO_DELIVER"
  | "DELIVERED"
  | "REJECTED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED";

export interface PreviewJob {
  id: JobId;
  shopId: ShopId;
  idempotencyKey: string;
  visitorId: string;
  /** Only set when Shopify has verified the customer. Never trusted from the browser. */
  verifiedCustomerId?: string;
  productId: string;
  optionValue: string;
  referenceVersion: string;
  /** Opaque hash of the room photo, used to recognise "same room" in a live session. Not the image. */
  roomPhotoHash: string;
  state: JobState;
  reasonCode?: string;
  providerRequestId?: string;
  attempts: number;
  deliveryToken?: string;
  deliveryTokenExpiresAt?: Date;
  /** Variable processing cost recorded for internal reporting (micro-units of USD). Never shown to shoppers. */
  costMicros: number;
  createdAt: Date;
  updatedAt: Date;
  deliveredAt?: Date;
  refundedAt?: Date;
}

export type QuotaWindow =
  | { type: "rolling"; hours: number }
  | { type: "manual"; resetEpoch: Date };

export interface QuotaPolicy {
  enabled: boolean;
  /** Allowance per product, shared across all its colours/options. */
  perProduct?: number;
  /** Allowance across the whole store. */
  storeWide?: number;
  window: QuotaWindow;
}

export type QuotaUsageState = "RESERVED" | "DELIVERED" | "RELEASED";

export interface QuotaUsage {
  jobId: JobId;
  shopId: ShopId;
  visitorId: string;
  verifiedCustomerId?: string;
  productId: string;
  state: QuotaUsageState;
  reservedAt: Date;
  deliveredAt?: Date;
}

export type LeadCaptureMode = "off" | "required" | "skippable";

export interface ShopSettings {
  shopId: ShopId;
  quota: QuotaPolicy;
  leadCapture: LeadCaptureMode;
  /** True once the merchant has an active paid plan approved through Shopify billing. */
  paidPlanActive: boolean;
}
