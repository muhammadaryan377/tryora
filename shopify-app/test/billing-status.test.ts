import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryStore, PreviewService } from "../app/core/index";
import { FREE_PLAN, PLANS } from "../app/plans";

const fixture = vi.hoisted(() => ({ service: null as any, admin: null as any, shop: { paidPlanActive: false }, entitlement: null as any }));
vi.mock("../app/tryora.server", () => ({ tryora: {
  grantMonthlyAllowance: (...args: any[]) => fixture.service.grantMonthlyAllowance(...args),
  balance: (...args: any[]) => fixture.service.balance(...args),
} }));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn(async () => ({ session: { shop: "test-sofa.myshopify.com" }, admin: fixture.admin })) } }));
vi.mock("../app/db.server", () => ({ default: {
  shop: { findUnique: async () => fixture.shop },
  billingEntitlement: { findUnique: async () => fixture.entitlement },
} }));
import { billingPresentation, BILLING_STATUS_QUERY, ensureBillingAllowance, testCreditAllowance } from "../app/billing-status.server";
import { loader } from "../app/routes/app.billing";
import { billingPlans } from "../app/billing-config.server";

const shop = "test-sofa.myshopify.com";
let now: Date;
let store: InMemoryStore;
const admin = (developer: boolean, subscriptions: unknown[] = []) => ({ graphql: vi.fn(async () => Response.json({ data: {
  shop: { plan: { partnerDevelopment: developer } }, currentAppInstallation: { activeSubscriptions: subscriptions },
} })) });

beforeEach(() => {
  now = new Date("2026-10-27T12:00:00Z");
  store = new InMemoryStore();
  fixture.service = new PreviewService(store, { now: () => new Date(now) });
  fixture.shop = { paidPlanActive: false };
  fixture.entitlement = null;
});
afterEach(() => vi.unstubAllEnvs());

describe("authenticated store classification and credits", () => {
  it("shows DEVELOPER without claiming a subscription or granting unlimited credits", async () => {
    vi.stubEnv("TRYORA_DEV_TEST_CREDITS_PER_MONTH", "4");
    const client = admin(true);
    const status = await ensureBillingAllowance(client, shop);
    expect(client.graphql).toHaveBeenCalledWith(BILLING_STATUS_QUERY);
    expect(billingPresentation(status, "trial", false)).toMatchObject({ storeStatus: "DEVELOPER", subscriptionStatus: "No active Shopify subscription" });
    expect((await fixture.service.balance(shop)).availableTotal).toBe(4);
    await Promise.all(Array.from({ length: 5 }, () => ensureBillingAllowance(client, shop)));
    expect((await fixture.service.balance(shop)).availableTotal).toBe(4);
    expect((await fixture.service.ensureSettings(shop)).paidPlanActive).toBe(false);
  });

  it("defaults development credits to zero and rejects invalid/unbounded configuration", async () => {
    vi.stubEnv("TRYORA_DEV_TEST_CREDITS_PER_MONTH", "");
    await ensureBillingAllowance(admin(true), shop);
    expect((await fixture.service.balance(shop)).availableTotal).toBe(0);
    for (const value of ["-1", "Infinity", "10001", "1.5", "garbage"]) expect(testCreditAllowance(value)).toBe(0);
    vi.stubEnv("TRYORA_DEV_TEST_CREDITS_PER_MONTH", "3");
    await ensureBillingAllowance(admin(true), shop);
    expect((await fixture.service.balance(shop)).availableTotal).toBe(3);
  });

  it("gives live Free stores 10 monthly credits regardless of developer configuration", async () => {
    vi.stubEnv("TRYORA_DEV_TEST_CREDITS_PER_MONTH", "500");
    const status = await ensureBillingAllowance(admin(false), shop);
    expect(status.developer).toBe(false);
    expect(billingPresentation(status, "trial", false).storeStatus).toBe("LIVE");
    expect((await fixture.service.balance(shop)).availableTotal).toBe(10);
    now = new Date("2026-11-01T00:00:00Z");
    await ensureBillingAllowance(admin(false), shop);
    expect((await fixture.service.balance(shop)).availableTotal).toBe(10);
    expect((await store.transaction({ shopId: shop }, (tx) => tx.ledger(shop))).length).toBe(2);
  });

  it("does not grant again when a verified store changes classification in the same month", async () => {
    vi.stubEnv("TRYORA_DEV_TEST_CREDITS_PER_MONTH", "4");
    await ensureBillingAllowance(admin(true), shop);
    await ensureBillingAllowance(admin(false), shop);
    expect((await fixture.service.balance(shop)).availableTotal).toBe(4);
  });

  it("keeps legacy trial history intact without stacking 10 more credits", async () => {
    await fixture.service.grantTrial(shop);
    const original = await store.transaction({ shopId: shop }, (tx) => tx.ledger(shop));
    await ensureBillingAllowance(admin(false), shop);
    expect((await fixture.service.balance(shop)).availableTotal).toBe(10);
    const entries = await store.transaction({ shopId: shop }, (tx) => tx.ledger(shop));
    expect(entries[0]).toEqual(original[0]);
    now = new Date("2026-11-01T00:00:00Z");
    await ensureBillingAllowance(admin(false), shop);
    expect((await fixture.service.balance(shop)).availableTotal).toBe(10);
    now = new Date("2026-12-01T00:00:00Z");
    await ensureBillingAllowance(admin(false), shop);
    expect((await fixture.service.balance(shop)).availableTotal).toBe(10);
  });

  it("preserves existing paid credits and entitlement even when Shopify returns no subscription", async () => {
    fixture.entitlement = { plan: "growth", status: "active", subscriptionId: "existing" };
    await fixture.service.grantPeriodCredits(shop, "paid-oct", 300, new Date("2026-11-01"));
    await ensureBillingAllowance(admin(true), shop);
    expect((await fixture.service.balance(shop)).availableTotal).toBe(300);
    expect(fixture.entitlement).toEqual({ plan: "growth", status: "active", subscriptionId: "existing" });
  });

  it("shows actual Shopify test subscription status separately from store status", async () => {
    const status = await ensureBillingAllowance(admin(true, [{ id: "gid://shopify/AppSubscription/1", name: "Starter", status: "ACTIVE", test: true }]), shop);
    expect(billingPresentation(status, "trial", false)).toMatchObject({ storeStatus: "DEVELOPER", subscriptionStatus: "Starter: ACTIVE (test)" });
    expect((await fixture.service.balance(shop)).availableTotal).toBe(0);
    expect((await fixture.service.ensureSettings(shop)).paidPlanActive).toBe(false);
  });

  it("does not replace a live Shopify subscription with Free credits", async () => {
    const status = await ensureBillingAllowance(admin(false, [{ id: "gid://shopify/AppSubscription/2", name: "Growth", status: "ACTIVE", test: false }]), shop);
    expect(billingPresentation(status, "free", false)).toMatchObject({ storeStatus: "LIVE", plan: "Growth", subscriptionStatus: "Growth: ACTIVE" });
    expect((await fixture.service.balance(shop)).availableTotal).toBe(0);
  });

  it("does not charge this month's budget for legacy credits delivered last month", async () => {
    await fixture.service.grantTrial(shop);
    for (let i = 0; i < 10; i++) {
      const { job } = await fixture.service.createPreview({ shopId: shop, idempotencyKey: `legacy-${i}`, visitorId: `visitor-${i}`,
        productId: "sofa", optionValue: "Blue", referenceVersion: "1", roomPhotoHash: "hash", leadStepDone: true });
      await fixture.service.transition(job.id, "GENERATING");
      await fixture.service.transition(job.id, "CHECKING_RESULT");
      const ready = await fixture.service.markReadyToDeliver(job.id);
      await fixture.service.acknowledgeDelivery(job.id, ready.job.deliveryToken);
    }
    now = new Date("2026-11-01T00:00:00Z");
    await ensureBillingAllowance(admin(false), shop);
    expect(await fixture.service.balance(shop)).toMatchObject({ availableTotal: 10, consumed: 10 });
  });

  it("never converts API errors or missing developer flags into credit grants", async () => {
    for (const body of [{ errors: [{ message: "denied" }] }, { data: { shop: { plan: {} }, currentAppInstallation: { activeSubscriptions: [] } } }]) {
      const status = await ensureBillingAllowance({ graphql: async () => Response.json(body) }, shop);
      expect(status.developer).toBeNull();
      expect(billingPresentation(status, "trial", false).storeStatus).toBe("UNVERIFIED");
    }
    expect((await fixture.service.balance(shop)).availableTotal).toBe(0);
  });

  it("ignores browser-supplied developer status in the authenticated billing loader", async () => {
    vi.stubEnv("TRYORA_DEV_TEST_CREDITS_PER_MONTH", "200");
    fixture.admin = admin(false);
    const result = await loader({ request: new Request("https://app.example/app/billing?developer=true&partnerDevelopment=true"), params: {}, context: {} } as any);
    expect(result.presentation.storeStatus).toBe("LIVE");
    expect(result.availableCredits).toBe(10);
    expect(result.presentation.plan).toBe("Free");
  });

  it("does not reset spent or reserved monthly credits on refresh and preserves reservations across renewal", async () => {
    await ensureBillingAllowance(admin(false), shop);
    for (let i = 0; i < 10; i++) {
      await fixture.service.createPreview({ shopId: shop, idempotencyKey: `monthly-${i}`, visitorId: `visitor-${i}`,
        productId: "sofa", optionValue: "Blue", referenceVersion: "1", roomPhotoHash: "hash", leadStepDone: true });
    }
    await ensureBillingAllowance(admin(false), shop);
    expect((await fixture.service.balance(shop)).availableTotal).toBe(0);
    now = new Date("2026-11-01T00:00:00Z");
    await ensureBillingAllowance(admin(false), shop);
    expect(await fixture.service.balance(shop)).toMatchObject({ availableTotal: 10, reserved: 10 });
  });

  it("keeps the agreed tier prices and allowances in one shared configuration", () => {
    expect(FREE_PLAN.previews).toBe(10);
    expect(PLANS.map(({ price, previews }) => [price, previews])).toEqual([[29, 100], [69, 300], [159, 800]]);
    expect(Object.values(billingPlans).map((p) => p.lineItems[0])).toEqual([
      { amount: 29, currencyCode: "USD", interval: "EVERY_30_DAYS" },
      { amount: 69, currencyCode: "USD", interval: "EVERY_30_DAYS" },
      { amount: 159, currencyCode: "USD", interval: "EVERY_30_DAYS" },
    ]);
  });
});
