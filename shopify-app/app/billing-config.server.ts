import { BillingInterval } from "@shopify/shopify-app-react-router/server";
import { PLANS, annualPrice, billingPlanName, type BillingPlanName } from "./plans";

/** Shopify Manual Pricing. One-time top-up purchases use appPurchaseOneTimeCreate separately. */
type RecurringInterval = BillingInterval.Every30Days | BillingInterval.Annual;
type SubscriptionPlan = { lineItems: [{ amount: number; currencyCode: "USD"; interval: RecurringInterval }] };

const entries: [BillingPlanName, SubscriptionPlan][] = PLANS.flatMap(plan => [
  [billingPlanName(plan, "monthly"), {
    lineItems: [{ amount: plan.price, currencyCode: "USD" as const, interval: BillingInterval.Every30Days }],
  }],
  [billingPlanName(plan, "annual"), {
    lineItems: [{ amount: annualPrice(plan.price), currencyCode: "USD" as const, interval: BillingInterval.Annual }],
  }],
]);
export const billingPlans: Record<BillingPlanName, SubscriptionPlan> = Object.fromEntries(entries) as
  Record<BillingPlanName, SubscriptionPlan>;
