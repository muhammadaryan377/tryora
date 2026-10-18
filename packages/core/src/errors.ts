/** Reason codes returned to callers. Shopper-facing copy is chosen by the popup, never from these strings. */
export type ReasonCode =
  | "CREDITS_EXHAUSTED" // merchant has no available credits: shopper sees "New previews are temporarily unavailable"
  | "QUOTA_PRODUCT" // merchant-enabled per-product shopper limit reached
  | "QUOTA_STORE" // merchant-enabled store-wide shopper limit reached
  | "LEAD_REQUIRED" // merchant requires the email step before generating
  | "PLAN_INACTIVE" // trial ended and no paid plan approved
  | "INVALID_TRANSITION"
  | "NOT_FOUND"
  | "BAD_TOKEN"
  | "ALREADY_REFUNDED"
  | "NOT_DELIVERED";

export class TryoraError extends Error {
  constructor(
    public readonly code: ReasonCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "TryoraError";
  }
}
