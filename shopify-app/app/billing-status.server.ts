import prisma from "./db.server";
import { tryora } from "./tryora.server";
import { FREE_PLAN, paidPlanForSubscription } from "./plans";
import type { AdminGraphql } from "./preview-product.server";

export const BILLING_STATUS_QUERY = `#graphql
  query TryoraBillingStatus {
    shop { plan { partnerDevelopment } }
    currentAppInstallation { activeSubscriptions { id name status test currentPeriodEnd } }
  }
`;

export type Subscription = { id: string; name: string; status: string; test: boolean; currentPeriodEnd?: string | null };
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
  // Shopify is the payment authority: never unlock paid credits from a local flag, URL or
  // a subscription with an unrecognised name, inactive status, or expired billing period.
  const now = new Date();
  const live = subscriptions.map(subscription => ({
    subscription, choice: paidPlanForSubscription(subscription.name),
    periodEnd: subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null,
  })).find(candidate => candidate.choice &&
    candidate.subscription.status === "ACTIVE" &&
    candidate.periodEnd && Number.isFinite(candidate.periodEnd.getTime()) && candidate.periodEnd > now);

  if (live && live.choice && live.periodEnd) {
    const settings = await tryora.ensureSettings(shopId);
    if (!settings.paidPlanActive) await tryora.updateSettings({ ...settings, paidPlanActive: true });
    await prisma.billingEntitlement.upsert({
      where: { shopId },
      create: { shopId, plan: live.choice.plan.id, status: "active", subscriptionId: live.subscription.id,
        currentPeriodEnds: live.periodEnd },
      update: { plan: live.choice.plan.id, status: "active", subscriptionId: live.subscription.id,
        currentPeriodEnds: live.periodEnd },
    });
    // Annual payment covers twelve distinct monthly credit windows, not an upfront
    // grant of 12x previews. Each month is granted at most once by the ledger reference.
    const period = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const expires = live.periodEnd < nextMonth ? live.periodEnd : nextMonth;
    await tryora.grantPeriodCredits(shopId,
      `${live.subscription.id}:${period.toISOString().slice(0, 7)}`,
      live.choice.plan.previews, expires);
  } else if (entitlement?.subscriptionId && (entitlement.status === "active" || shop?.paidPlanActive)) {
    // Verified absence of an approved subscription closes paid eligibility. Do NOT do
    // this on Shopify API errors (those returned above with verified:false).
    const settings = await tryora.ensureSettings(shopId);
    if (settings.paidPlanActive) await tryora.updateSettings({ ...settings, paidPlanActive: false });
    await prisma.billingEntitlement.update({
      where: { shopId }, data: { status: "cancelled" },
    });
    await tryora.grantMonthlyAllowance(shopId, allowance);
  } else if (!shop?.paidPlanActive && !subscriptions.length &&
    !(entitlement && (entitlement.status === "active" || ["starter", "growth", "scale"].includes(entitlement.plan)))) {
    await tryora.grantMonthlyAllowance(shopId, allowance);
  }
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
