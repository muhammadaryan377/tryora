import prisma from "./db.server";
import { tryora } from "./tryora.server";
import { FREE_PLAN } from "./plans";
import type { AdminGraphql } from "./preview-product.server";

export const BILLING_STATUS_QUERY = `#graphql
  query TryoraBillingStatus {
    shop { plan { partnerDevelopment } }
    currentAppInstallation { activeSubscriptions { id name status test } }
  }
`;

export type Subscription = { id: string; name: string; status: string; test: boolean };
export type BillingStatus = { developer: boolean | null; subscriptions: Subscription[]; verified: boolean; allowance: number };

export function testCreditAllowance(value = process.env.TRYORA_DEV_TEST_CREDITS_PER_MONTH): number {
  if (!value?.trim()) return 0;
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 10000) return 0;
  return quantity;
}

/** The Admin client is supplied only by Shopify-authenticated server routes, never request fields. */
export async function ensureBillingAllowance(admin: AdminGraphql, shopId: string): Promise<BillingStatus> {
  let developer: boolean;
  let subscriptions: Subscription[];
  try {
    const response = await admin.graphql(BILLING_STATUS_QUERY);
    const result = await response.json();
    const flag = result.data?.shop?.plan?.partnerDevelopment;
    const active = result.data?.currentAppInstallation?.activeSubscriptions;
    if (!response.ok || result.errors?.length || typeof flag !== "boolean" || !Array.isArray(active)) {
      throw new Error("Unverified Shopify billing status");
    }
    developer = flag;
    subscriptions = active;
  } catch {
    // Unknown is not a live or development store. Existing credits still work; no new grants.
    return { developer: null, subscriptions: [], verified: false, allowance: 0 };
  }
  const allowance = developer ? testCreditAllowance() : FREE_PLAN.previews;
  const [shop, entitlement] = await Promise.all([
    prisma.shop.findUnique({ where: { id: shopId } }),
    prisma.billingEntitlement.findUnique({ where: { shopId } }),
  ]);
  // Shopify subscription truth and existing local entitlements remain separate and untouched.
  // A stale/mismatched local paid entitlement must never be replaced with a Free grant.
  const managed = shop?.paidPlanActive || subscriptions.length > 0 ||
    (entitlement && (entitlement.status === "active" || ["starter", "growth", "scale"].includes(entitlement.plan)));
  if (!managed) await tryora.grantMonthlyAllowance(shopId, allowance);
  return { developer, subscriptions, verified: true, allowance };
}

export function billingPresentation(status: BillingStatus, localPlan: string, localPaid: boolean) {
  const subscription = status.subscriptions.map((s) => `${s.name}: ${s.status}${s.test ? " (test)" : ""}`).join(", ");
  return {
    storeStatus: status.developer === true ? "DEVELOPER" : status.developer === false ? "LIVE" : "UNVERIFIED",
    subscriptionStatus: status.verified ? subscription || "No active Shopify subscription" : "Shopify subscription status could not be verified",
    plan: status.subscriptions.find((s) => s.status === "ACTIVE")?.name ?? (localPaid ? localPlan : "Free"),
    information: !status.verified ? "Store status could not be verified. No new credits were granted. Please try again." :
      status.developer ? `Verified Shopify development store for development testing. Configured test allowance: ${status.allowance} previews per UTC calendar month. Existing subscription entitlements are preserved. This does not activate a paid plan or provide unlimited AI credits.` :
      localPaid || status.subscriptions.length ? "Existing subscription and credit entitlements are preserved." :
      `Free includes ${FREE_PLAN.previews} previews per UTC calendar month. Credits reset on the first of each month and do not roll over.`,
  };
}
