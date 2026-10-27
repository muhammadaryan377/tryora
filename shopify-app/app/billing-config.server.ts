import { BillingInterval } from "@shopify/shopify-app-react-router/server";
import { PLANS, annualPrice, billingPlanName } from "./plans";

/** Manual Shopify Billing API: needed for our one-time $25 top-up purchases. */
export const billingPlans = Object.fromEntries(PLANS.flatMap(plan => [
  [billingPlanName(plan, "monthly"), {
    lineItems: [{ amount: plan.price, currencyCode: "USD", interval: BillingInterval.Every30Days }],
  }],
  [billingPlanName(plan, "annual"), {
    lineItems: [{ amount: annualPrice(plan.price), currencyCode: "USD", interval: BillingInterval.Annual }],
  }],
]));
