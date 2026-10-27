import { TOP_UP, TOP_UP_PURCHASE_NAME, paidPlanForSubscription } from "./plans";
import type { BillingStatus } from "./billing-status.server";
import { tryora } from "./tryora.server";

type Admin = { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> };

export const CREATE_TOP_UP = `#graphql
  mutation VisullyTopUp($name: String!, $price: MoneyInput!, $returnUrl: URL!, $test: Boolean!) {
    appPurchaseOneTimeCreate(name: $name, price: $price, returnUrl: $returnUrl, test: $test) {
      appPurchaseOneTime { id }
      confirmationUrl
      userErrors { field message }
    }
  }
`;

export const TOP_UP_HISTORY = `#graphql
  query VisullyTopUps($after: String) {
    currentAppInstallation {
      oneTimePurchases(first: 100, after: $after, reverse: true) {
        nodes { id name status test price { amount currencyCode } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export function hasVerifiedPaidPlan(status: BillingStatus) {
  return status.verified && status.subscriptions.some(subscription => {
    const end = subscription.currentPeriodEnd && new Date(subscription.currentPeriodEnd);
    return !!paidPlanForSubscription(subscription.name) && subscription.status === "ACTIVE" &&
      !!end && Number.isFinite(end.getTime()) && end > new Date();
  });
}

/** A Shopify-approved charge is required before these credits can be granted. */
export async function createTopUpCheckout(admin: Admin, status: BillingStatus, appUrl: string) {
  if (!hasVerifiedPaidPlan(status)) throw new Error("An active, verified paid Shopify subscription is required for top-ups.");
  const url = new URL(appUrl);
  if (url.protocol !== "https:") throw new Error("A secure app URL is required for Shopify billing.");
  const response = await admin.graphql(CREATE_TOP_UP, { variables: {
    name: TOP_UP_PURCHASE_NAME,
    price: { amount: TOP_UP.price, currencyCode: "USD" },
    returnUrl: new URL("/app/billing?topup=verify", url).toString(),
    test: status.developer === true,
  } });
  const json = await response.json();
  const value = json.data?.appPurchaseOneTimeCreate;
  if (!response.ok || json.errors?.length || value?.userErrors?.length ||
      !value?.appPurchaseOneTime?.id?.startsWith("gid://shopify/AppPurchaseOneTime/") ||
      !/^https:\/\//.test(value?.confirmationUrl ?? "")) {
    throw new Error("Shopify could not start the top-up approval. No credits were granted.");
  }
  return String(value.confirmationUrl);
}

export function isApprovedTopUp(purchase: {
  id?: string; name?: string; status?: string; test?: boolean; price?: { amount?: string; currencyCode?: string };
}, developer: boolean | null): boolean {
  return !!purchase.id?.match(/^gid:\/\/shopify\/AppPurchaseOneTime\/\d+$/) &&
    purchase.name === TOP_UP_PURCHASE_NAME && purchase.status === "ACTIVE" &&
    Number(purchase.price?.amount) === TOP_UP.price && purchase.price?.currencyCode === "USD" &&
    // A Shopify test purchase must never unlock billable credits on a live shop.
    purchase.test === (developer === true);
}

/** Safe even after repeated reloads: ledger unique reference ensures each Shopify ID is granted once. */
export async function reconcileTopUps(admin: Admin, shopId: string, status: BillingStatus) {
  if (!hasVerifiedPaidPlan(status)) return 0;
  let cursor: string | null = null;
  let count = 0;
  // Bounded pagination; very old unsettled purchases need a support reconciliation.
  for (let page = 0; page < 5; page++) {
    const response = await admin.graphql(TOP_UP_HISTORY, { variables: { after: cursor } });
    const json = await response.json();
    const records = json.data?.currentAppInstallation?.oneTimePurchases;
    if (!response.ok || json.errors?.length || !Array.isArray(records?.nodes))
      throw new Error("Top-up payment verification is temporarily unavailable.");
    for (const purchase of records.nodes) {
      if (!isApprovedTopUp(purchase, status.developer)) continue;
      await tryora.grantTopUp(shopId, purchase.id, TOP_UP.previews);
      count++;
    }
    if (!records.pageInfo?.hasNextPage || !records.pageInfo.endCursor || records.pageInfo.endCursor === cursor) break;
    cursor = records.pageInfo.endCursor;
  }
  return count;
}
