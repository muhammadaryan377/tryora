import type { ProviderAdapter } from "./types.server";

/** Documented browser events are signals, not a verified catalogue or authorization.
 * No private endpoints, DOM scraping, or browser event payloads are trusted here. */
export const cloudliftAdapter: ProviderAdapter = {
  providerId: "cloudlift", version: "0-disabled", label: "Live Product Options by Cloudlift — Needs setup",
  capabilities: { discovery: false, selectionEvents: false, authorization: false },
  async discover() { return { status: "unsupported", reason: "unverified_provider" }; },
  async validate() { return { status: "rejected", reason: "unsupported" }; },
};
