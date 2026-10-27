import { describe, expect, it, vi } from "vitest";
import { annualPrice, PLANS, TOP_UP_PURCHASE_NAME } from "../app/plans";

const state = vi.hoisted(() => ({ grants: [] as { shop: string; id: string; amount: number }[] }));
vi.mock("../app/tryora.server", () => ({ tryora: {
  grantTopUp: vi.fn(async (shop: string, id: string, amount: number) => {
    if (!state.grants.some(g => g.shop === shop && g.id === id)) state.grants.push({ shop, id, amount });
  }),
} }));
import {
  createTopUpCheckout, hasVerifiedPaidPlan, isApprovedTopUp, reconcileTopUps, CREATE_TOP_UP, TOP_UP_HISTORY,
} from "../app/billing-purchases.server";
import type { BillingStatus } from "../app/billing-status.server";

const shop = "store.myshopify.com";
const paid: BillingStatus = {
  developer: false, verified: true, allowance: 10,
  subscriptions: [{ id: "gid://shopify/AppSubscription/9", name: "Starter Annual",
    status: "ACTIVE", test: false, currentPeriodEnd: "2099-11-01T00:00:00Z" }],
};
const purchase = (n: number, overrides = {}) => ({
  id: `gid://shopify/AppPurchaseOneTime/${n}`,
  name: TOP_UP_PURCHASE_NAME, status: "ACTIVE", test: false,
  price: { amount: "25.0", currencyCode: "USD" }, ...overrides,
});

describe("billing security and customer actions", () => {
  it("annual pricing is exactly two months free, without multiplying monthly preview credits", () => {
    expect(PLANS.map(p => annualPrice(p.price))).toEqual([290, 690, 1590]);
    expect(PLANS.map(p => p.previews)).toEqual([100, 300, 800]);
  });
  it("only accepts a verified, recognised and unexpired paid Shopify subscription", () => {
    expect(hasVerifiedPaidPlan(paid)).toBe(true);
    expect(hasVerifiedPaidPlan({ ...paid, verified: false })).toBe(false);
    expect(hasVerifiedPaidPlan({ ...paid, subscriptions: [{ ...paid.subscriptions[0]!, status: "CANCELLED" }] })).toBe(false);
    expect(hasVerifiedPaidPlan({ ...paid, subscriptions: [{ ...paid.subscriptions[0]!, name: "Fake Plan" }] })).toBe(false);
    expect(hasVerifiedPaidPlan({ ...paid, subscriptions: [{ ...paid.subscriptions[0]!, currentPeriodEnd: "2024-01-01T00:00:00Z" }] })).toBe(false);
  });
  it("creates only a Shopify-approved one-time purchase link, never credits in the request", async () => {
    state.grants = [];
    const client = { graphql: vi.fn(async (query: string, args: any) => {
      expect(query).toBe(CREATE_TOP_UP);
      expect(args.variables).toMatchObject({
        name: TOP_UP_PURCHASE_NAME, price: { amount: 25, currencyCode: "USD" }, test: false,
      });
      expect(args.variables.returnUrl).toBe("https://visully.example/app/billing?topup=verify");
      return Response.json({ data: { appPurchaseOneTimeCreate: {
        appPurchaseOneTime: { id: "gid://shopify/AppPurchaseOneTime/5" },
        confirmationUrl: "https://store.myshopify.com/admin/charges/5/approve", userErrors: [],
      } } });
    }) };
    expect(await createTopUpCheckout(client, paid, "https://visully.example")).toContain("/approve");
    expect(state.grants).toEqual([]);
  });
  it("rejects non-paying shops and invalid approval responses", async () => {
    const client = { graphql: async () => Response.json({ data: { appPurchaseOneTimeCreate: {
      appPurchaseOneTime: null, confirmationUrl: null, userErrors: [{ message: "denied" }],
    } } }) };
    await expect(createTopUpCheckout(client, { ...paid, subscriptions: [] }, "https://visully.example")).rejects.toThrow("active");
    await expect(createTopUpCheckout(client, paid, "http://insecure.example")).rejects.toThrow("secure");
    await expect(createTopUpCheckout(client, paid, "https://visully.example")).rejects.toThrow("could not start");
  });
  it("checks exact purchase name, amount, currency, approved state and live/test environment", () => {
    expect(isApprovedTopUp(purchase(101), false)).toBe(true);
    expect(isApprovedTopUp(purchase(101, { status: "PENDING" }), false)).toBe(false);
    expect(isApprovedTopUp(purchase(101, { name: "Other top-up" }), false)).toBe(false);
    expect(isApprovedTopUp(purchase(101, { price: { amount: "1", currencyCode: "USD" } }), false)).toBe(false);
    expect(isApprovedTopUp(purchase(101, { test: true }), false)).toBe(false);
    expect(isApprovedTopUp(purchase(101, { price: { amount: "25", currencyCode: "GBP" } }), false)).toBe(false);
  });
  it("grants only exact approved purchases, remains idempotent across replays", async () => {
    state.grants = [];
    const admin = { graphql: vi.fn(async (query: string) => {
      expect(query).toBe(TOP_UP_HISTORY);
      return Response.json({ data: { currentAppInstallation: { oneTimePurchases: {
        nodes: [purchase(101), purchase(102, { status: "PENDING" }), purchase(103, { price: { amount: "20", currencyCode: "USD" } })],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } });
    }) };
    await reconcileTopUps(admin, shop, paid);
    await reconcileTopUps(admin, shop, paid);
    expect(state.grants).toEqual([{ shop, id: "gid://shopify/AppPurchaseOneTime/101", amount: 100 }]);
  });
});
