import { BillingInterval } from "@shopify/shopify-app-react-router/server";
import { PLANS } from "./plans";

// Both Shopify charges and the billing cards use the shared tier definitions.
export const billingPlans = Object.fromEntries(PLANS.map((plan) => [plan.name, {
  lineItems: [{ amount: plan.price, currencyCode: "USD", interval: BillingInterval.Every30Days as const }],
}]));
