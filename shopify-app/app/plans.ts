// USD, per store, before tax. Shared by billing and the sales report.
export const FREE_PLAN = { id: "free", name: "Free", price: 0, previews: 10 } as const;
export const PLANS = [
  { id: "starter", name: "Starter", price: 29, previews: 100 },
  { id: "growth", name: "Growth", price: 69, previews: 300 },
  { id: "scale", name: "Scale", price: 159, previews: 800 },
] as const;
export const TOP_UP = { price: 25, previews: 100 };

/** One annual charge gives the equivalent of two months free. Allowances still refresh monthly. */
export type PaidPlanId = (typeof PLANS)[number]["id"];
export type BillingCycle = "monthly" | "annual";
export const annualPrice = (monthlyPrice: number) => monthlyPrice * 10;
export const billingPlanName = (plan: (typeof PLANS)[number], cycle: BillingCycle) =>
  cycle === "annual" ? `${plan.name} Annual` : plan.name;
export function paidPlanForSubscription(name: string) {
  for (const plan of PLANS) {
    if (name === plan.name) return { plan, cycle: "monthly" as const };
    if (name === billingPlanName(plan, "annual")) return { plan, cycle: "annual" as const };
  }
  return null;
}
export const TOP_UP_PURCHASE_NAME = `Visully ${TOP_UP.previews} preview credits top-up`;
