// GENERATED from packages/core/src by scripts/sync-core.mjs. Do not edit here.
import type { QuotaPolicy, QuotaUsage } from "./types.js";

/**
 * Optional, merchant-controlled shopper limits. Off by default: Tryora imposes no app-wide shopper quota.
 * Counters are server-side and keyed by a store-scoped visitor id, reconciled with a verified customer id.
 * IP addresses are never used as identity.
 */

export interface ShopperIdentity {
  visitorId: string;
  verifiedCustomerId?: string;
}

export function windowStart(policy: QuotaPolicy, now: Date): Date {
  if (policy.window.type === "manual") return policy.window.resetEpoch;
  return new Date(now.getTime() - policy.window.hours * 3600_000);
}

/**
 * Visitor ids that belong to this shopper: their own, plus any browser that has been seen signed in as
 * the same verified customer. That lets earlier guest previews follow the customer to another device.
 */
function linkedVisitorIds(usages: QuotaUsage[], who: ShopperIdentity): Set<string> {
  const ids = new Set([who.visitorId]);
  if (who.verifiedCustomerId) {
    for (const u of usages) if (u.verifiedCustomerId === who.verifiedCustomerId) ids.add(u.visitorId);
  }
  return ids;
}

function belongsTo(u: QuotaUsage, who: ShopperIdentity, visitors: Set<string>): boolean {
  if (visitors.has(u.visitorId)) return true;
  return !!who.verifiedCustomerId && u.verifiedCustomerId === who.verifiedCustomerId;
}

/**
 * Counts usage that occupies the allowance: delivered previews inside the window plus live reservations.
 * Each job counts once even if it matches by both visitor and customer id.
 */
export function countUsage(
  usages: QuotaUsage[],
  who: ShopperIdentity,
  policy: QuotaPolicy,
  now: Date,
  productId?: string,
): number {
  const start = windowStart(policy, now).getTime();
  const visitors = linkedVisitorIds(usages, who);
  const counted = new Set<string>();
  for (const u of usages) {
    if (!belongsTo(u, who, visitors)) continue;
    if (productId && u.productId !== productId) continue;
    if (u.state === "RESERVED") counted.add(u.jobId);
    else if (u.state === "DELIVERED" && u.deliveredAt && u.deliveredAt.getTime() >= start) counted.add(u.jobId);
  }
  return counted.size;
}

export type QuotaCheck =
  | { ok: true; remainingForProduct?: number; remainingStoreWide?: number }
  | { ok: false; scope: "product" | "store" };

export function checkQuota(
  usages: QuotaUsage[],
  who: ShopperIdentity,
  policy: QuotaPolicy,
  productId: string,
  now: Date,
): QuotaCheck {
  if (!policy.enabled) return { ok: true };
  let remainingForProduct: number | undefined;
  let remainingStoreWide: number | undefined;
  if (policy.perProduct !== undefined) {
    const used = countUsage(usages, who, policy, now, productId);
    if (used >= policy.perProduct) return { ok: false, scope: "product" };
    remainingForProduct = policy.perProduct - used;
  }
  if (policy.storeWide !== undefined) {
    const used = countUsage(usages, who, policy, now);
    if (used >= policy.storeWide) return { ok: false, scope: "store" };
    remainingStoreWide = policy.storeWide - used;
  }
  return { ok: true, remainingForProduct, remainingStoreWide };
}
