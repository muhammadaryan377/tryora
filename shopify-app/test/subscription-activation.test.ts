// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

const state = vi.hoisted(() => ({
  data: {} as any, navigate: vi.fn(), search: "?subscription=verify&host=embedded-host&charge_id=9",
  status: {} as any, requestBilling: vi.fn(), cancelBilling: vi.fn(), routeState: null as any,
}));
vi.mock("react-router", async original => ({
  ...await original<typeof import("react-router")>(),
  useLoaderData: () => state.data,
  useActionData: () => undefined,
  useNavigation: () => ({ state: "idle" }),
  useLocation: () => ({ search: state.search, state: state.routeState }),
  useNavigate: () => state.navigate,
  Form: ({ children, ...props }: any) => createElement("form", props, children),
}));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: async () => ({
  session: { shop: "demo.myshopify.com" }, admin: {}, billing: { request: state.requestBilling, cancel: state.cancelBilling },
}) } }));
vi.mock("../app/db.server", () => ({ default: {
  shop: { findUnique: async () => ({ paidPlanActive: true }) },
  productPreviewConfig: { count: async () => 1 }, appearance: { findFirst: async () => ({}) },
  previewJob: { count: async () => 0 }, leadDelivery: { count: async () => 0 },
} }));
vi.mock("../app/tryora.server", () => ({ tryora: { balance: async () => ({ availableTotal: 100, reserved: 0 }) } }));
vi.mock("../app/attribution.server", () => ({ salesReport: async () => null }));
vi.mock("../app/billing-status.server", () => ({ ensureBillingAllowance: async () => state.status }));
vi.mock("../app/components/home-dashboard", () => ({ HomeDashboard: () => createElement("h1", null, "Home dashboard") }));
import Dashboard, { loader } from "../app/routes/app._index";
import { action } from "../app/routes/app.billing";
import Billing from "../app/routes/app.billing";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  state.navigate.mockReset();
  state.requestBilling.mockReset();
  state.cancelBilling.mockReset();
  state.routeState = null;
  state.search = "?subscription=verify&host=embedded-host&charge_id=9";
  state.status = { verified: true, developer: false, allowance: 10, subscriptions: [{
    id: "gid://shopify/AppSubscription/9", name: "Starter", status: "ACTIVE", currentPeriodEnd: "2099-01-01T00:00:00Z",
  }] };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const load = (query = "?subscription=verify") => loader({ request: new Request(`https://app.example/app${query}`) } as LoaderFunctionArgs);

describe("subscription activation return", () => {
  it("reveals subscription details only after the paid user opens their management card", async () => {
    state.data = { paid: true, billingStatus: state.status, presentation: { storeStatus: "LIVE", plan: "Starter" },
      plan: "starter", entitlementStatus: "active", activeSubscriptionName: "Starter", availableCredits: 100 };
    await act(async () => root.render(createElement(Billing)));
    expect(container.textContent).toContain("Your Subscription");
    expect(container.textContent).not.toContain("Cancel Subscription");
    const card = container.querySelector<HTMLButtonElement>("[aria-controls='subscription-details']")!;
    await act(async () => card.click());
    expect(card.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("#subscription-details")!.textContent).toContain("Starter");
    expect(container.textContent).toContain("Cancel Subscription");
    expect(container.querySelector("input[value='switch-free']")).toBeNull();
    const cancel = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Cancel Subscription"))!;
    await act(async () => cancel.click());
    expect(container.textContent).toContain("Cancel your subscription?");
    expect(container.textContent).toContain("Starter — $29.00/month");
    expect(container.textContent).toContain("No automatic refund is requested.");
    expect(document.activeElement?.id).toBe("cancel-subscription-heading");
    expect(state.cancelBilling).not.toHaveBeenCalled();
    const finalButton = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Continue to Cancellation")!;
    expect(finalButton.type).toBe("submit");
    expect(finalButton.closest("form")?.querySelector<HTMLInputElement>("input[name='intent']")?.value).toBe("switch-free");
    const keep = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Keep My Subscription")!;
    await act(async () => keep.click());
    expect(container.textContent).toContain("Your Subscription");
    expect(container.textContent).not.toContain("Cancel your subscription?");
    expect(state.cancelBilling).not.toHaveBeenCalled();
  });
  it("hides subscription management for Free users", async () => {
    state.data = { paid: false, billingStatus: state.status, presentation: { storeStatus: "LIVE", plan: "Free" },
      plan: "free", entitlementStatus: "none", availableCredits: 10 };
    await act(async () => root.render(createElement(Billing)));
    expect(container.textContent).not.toContain("Your Subscription");
    expect(container.textContent).not.toContain("Cancel Subscription");
  });
  it("confirms cancellation only after Shopify verifies the subscription is no longer active", async () => {
    state.cancelBilling.mockImplementation(async () => { state.status = { ...state.status, subscriptions: [] }; });
    const result = await action({ request: new Request("https://app.example/app/billing", {
      method: "POST", body: new URLSearchParams({ intent: "switch-free" }),
    }) } as ActionFunctionArgs);
    expect(state.cancelBilling).toHaveBeenCalledWith({ subscriptionId: "gid://shopify/AppSubscription/9", prorate: false, isTest: false });
    expect(result).toMatchObject({ ok: true, cancelled: true });
  });
  it.each(["failed", "still-active", "unverified", "free"])("does not claim cancellation when %s", async reason => {
    if (reason === "failed") state.cancelBilling.mockRejectedValue(new Error("Shopify unavailable"));
    if (reason === "unverified") state.cancelBilling.mockImplementation(async () => { state.status.verified = false; });
    if (reason === "free") state.status.subscriptions = [];
    const result = await action({ request: new Request("https://app.example/app/billing", {
      method: "POST", body: new URLSearchParams({ intent: "switch-free" }),
    }) } as ActionFunctionArgs);
    expect(result).toMatchObject({ ok: false });
    if (reason === "free") expect(state.cancelBilling).not.toHaveBeenCalled();
  });
  it("shows a cancellation screen once and removes its state so refresh opens Home", async () => {
    state.data = await load("");
    state.routeState = { subscriptionCancelled: true };
    await act(async () => root.render(createElement(Dashboard)));
    expect(container.textContent).toContain("Subscription Cancelled");
    expect(container.textContent).toContain("You are now on the Free plan.");
    expect(state.navigate).toHaveBeenCalledWith({ pathname: "/app", search: state.search }, { replace: true, state: null });
    await act(async () => root.unmount());
    root = createRoot(container);
    state.routeState = null;
    await act(async () => root.render(createElement(Dashboard)));
    expect(container.textContent).toContain("Home dashboard");
    expect(container.textContent).not.toContain("Subscription Cancelled");
  });
  it("returns monthly and annual approvals to Home inside Shopify admin", async () => {
    vi.stubEnv("SHOPIFY_API_KEY", "visully-client-id");
    try {
      state.status.subscriptions = [];
      for (const cycle of ["monthly", "annual"]) {
        const body = new URLSearchParams({ intent: "select-plan", plan: "starter", cycle });
        await action({ request: new Request("https://app.example/app/billing", { method: "POST", body }) } as ActionFunctionArgs);
        expect(state.requestBilling).toHaveBeenLastCalledWith({
          plan: cycle === "annual" ? "Starter Annual" : "Starter", isTest: false,
          returnUrl: "https://admin.shopify.com/store/demo/apps/visully-client-id/app?subscription=verify",
        });
      }
    } finally { vi.unstubAllEnvs(); }
  });
  it("shows the success card only after verifying an active paid subscription and clears the callback for refresh", async () => {
    state.data = await load();
    expect(state.data.subscriptionActivated).toBe(true);
    await act(async () => root.render(createElement(Dashboard)));
    expect(container.textContent).toContain("Subscription Activated!");
    expect(container.textContent).toContain("Your plan credits are ready to use.");
    expect(state.navigate).toHaveBeenCalledWith({ pathname: "/app", search: "?host=embedded-host" }, { replace: true });
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toContain("Home dashboard");
  });
  it("opens Home after refreshing the clean callback URL", async () => {
    state.data = await load("");
    expect(state.data.subscriptionActivated).toBe(false);
    await act(async () => root.render(createElement(Dashboard)));
    expect(container.textContent).toContain("Home dashboard");
    expect(container.textContent).not.toContain("Subscription Activated!");
  });
  it.each(["unverified", "cancelled", "expired"])("does not claim activation for %s billing", async reason => {
    if (reason === "unverified") state.status.verified = false;
    if (reason === "cancelled") state.status.subscriptions[0].status = "CANCELLED";
    if (reason === "expired") state.status.subscriptions[0].currentPeriodEnd = "2020-01-01T00:00:00Z";
    state.data = await load();
    expect(state.data.subscriptionActivated).toBe(false);
    await act(async () => root.render(createElement(Dashboard)));
    expect(container.textContent).not.toContain("Subscription Activated!");
    expect(container.textContent).toContain("Go to Plans & Billing");
  });
});
