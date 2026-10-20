/** Reason codes returned to callers. Shopper-facing copy is chosen by the popup, never from these strings. */
export type ReasonCode =
  | "BAD_PHOTO"
  | "BAD_REQUEST"
  | "RESULT_REJECTED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "CREDITS_EXHAUSTED" // merchant has no available credits: shopper sees "New previews are temporarily unavailable"
  | "QUOTA_PRODUCT" // merchant-enabled per-product shopper limit reached
  | "QUOTA_STORE" // merchant-enabled store-wide shopper limit reached
  | "LEAD_REQUIRED" // merchant requires the email step before generating
  | "PLAN_INACTIVE" // trial ended and no paid plan approved
  | "INVALID_TRANSITION"
  | "NOT_FOUND"
  | "BAD_TOKEN"
  | "ALREADY_REFUNDED"
  | "NOT_DELIVERED"
  | "BAD_EMAIL" // shopper typed an email that is not valid
  | "RATE_LIMITED" // too many requests from one shopper, or an unusual burst for the store (abuse protection)
  | "DAILY_CAP"; // the store's daily preview limit is reached

export class TryoraError extends Error {
  constructor(
    public readonly code: ReasonCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "TryoraError";
  }
}
