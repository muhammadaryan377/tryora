import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { tryora } from "../tryora.server";
import { billingPresentation, ensureBillingAllowance } from "../billing-status.server";
import { createTopUpCheckout, hasVerifiedPaidPlan, reconcileTopUps } from "../billing-purchases.server";
import { FREE_PLAN, PLANS, TOP_UP, annualPrice, billingPlanName, type BillingCycle } from "../plans";
import styles from "../styles/billing.module.css";

const usd = (n: number) => `$${n.toFixed(2)}`;
const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shopId = session.shop;
  const billingStatus = await ensureBillingAllowance(admin, shopId);
  let topUpVerificationError = false;
  if (hasVerifiedPaidPlan(billingStatus)) {
    try { await reconcileTopUps(admin, shopId, billingStatus); }
    catch { topUpVerificationError = true; }
  }
  const [balance, shop, entitlement] = await Promise.all([
    tryora.balance(shopId),
    prisma.shop.findUnique({ where: { id: shopId } }),
    prisma.billingEntitlement.findUnique({ where: { shopId } }),
  ]);
  return {
    billingStatus,
    paid: hasVerifiedPaidPlan(billingStatus),
    topUpVerificationError,
    presentation: billingPresentation(billingStatus, entitlement?.plan ?? "free", shop?.paidPlanActive ?? false),
    entitlementStatus: entitlement?.status ?? "none",
    plan: entitlement?.plan ?? "free",
    activeSubscriptionName: billingStatus.subscriptions.find(sub => sub.status === "ACTIVE")?.name ?? null,
    periodEnds: entitlement?.currentPeriodEnds?.toISOString() ?? null,
    availableCredits: balance.availableTotal,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin, billing, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const status = await ensureBillingAllowance(admin, session.shop);
  if (!status.verified) return { ok: false, errors: ["Shopify billing status is unavailable. Please try again."] };

  if (intent === "select-plan") {
    const plan = PLANS.find(item => item.id === form.get("plan"));
    const cycle = form.get("cycle");
    if (!plan || (cycle !== "monthly" && cycle !== "annual"))
      return { ok: false, errors: ["Choose a valid Visully plan."] };
    const name = billingPlanName(plan, cycle);
    if (status.subscriptions.some(sub => sub.name === name && sub.status === "ACTIVE"))
      return { ok: true, errors: [], message: "This Shopify subscription is already active." };
    // Shopify handles approval and changes to an existing subscription; never grant
    // credits before its active subscription is re-verified by the authenticated loader.
    return billing.request({
      plan: name,
      isTest: status.developer === true,
      returnUrl: new URL("/app/billing", process.env.SHOPIFY_APP_URL || request.url).toString(),
    });
  }

  if (intent === "switch-free") {
    const active = status.subscriptions.find(sub => sub.status === "ACTIVE" && sub.currentPeriodEnd &&
      new Date(sub.currentPeriodEnd) > new Date());
    if (!active) return { ok: false, errors: ["No active Shopify subscription to cancel."] };
    // Shopify requires the merchant's authenticated billing permission.
    await billing.cancel({ subscriptionId: active.id, prorate: false, isTest: status.developer === true });
    return redirect("/app/billing");
  }

  if (intent === "buy-topup") {
    try {
      const confirmationUrl = await createTopUpCheckout(
        admin, status, process.env.SHOPIFY_APP_URL || "",
      );
      return redirect(confirmationUrl, { target: "_top" });
    } catch {
      return { ok: false, errors: ["Could not start Shopify top-up approval. Check your paid subscription and try again."] };
    }
  }
  return { ok: false, errors: ["Unknown billing action."] };
};

export default function Billing() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  const saving = navigation.state !== "idle";
  return (
    <s-page heading="Plans & Billing" inlineSize="large">
      <p className={styles.subtitle}>Choose a plan and approve payment through Shopify. You can change plans without leaving Shopify.</p>
      {result?.errors?.length ? <s-banner tone="critical" heading="Billing action not completed">
        {result.errors.map(error => <s-paragraph key={error}>{error}</s-paragraph>)}
      </s-banner> : null}
      {result?.ok && "message" in result ? <s-banner tone="success" heading={result.message} /> : null}
      {d.topUpVerificationError && <s-banner tone="warning" heading="Payment verification is temporarily unavailable">
        Your approved top-up will be credited after Shopify payment verification succeeds. Please refresh or contact support.
      </s-banner>}
      <section className={styles.current} aria-label="Current plan">
        <p>Store status: <span className={styles.badge}>{d.presentation.storeStatus}</span></p>
        <p>Your current plan: {d.presentation.plan}</p>
        <p>Shopify subscription: {d.presentation.subscriptionStatus}</p>
        <p>Saved entitlement: {d.plan} ({d.entitlementStatus})</p>
        <p>Available preview credits: {d.availableCredits}</p>
        <div className={styles.notice}><span aria-hidden="true">&#9432;</span>
          {d.presentation.information}{d.periodEnds ? ` Current subscription period ends on ${date(d.periodEnds)}.` : ""}
        </div>
      </section>

      <section className={styles.information} aria-label="Billing frequency">
        <h2>Choose billing frequency</h2>
        <div className={styles.billingToggle} role="group" aria-label="Billing frequency">
          <button type="button" className={cycle === "monthly" ? styles.activeCycle : styles.cycle}
            onClick={() => setCycle("monthly")}>Monthly</button>
          <button type="button" className={cycle === "annual" ? styles.activeCycle : styles.cycle}
            onClick={() => setCycle("annual")}>Yearly — 2 months free</button>
        </div>
      </section>

      <div className={styles.plans}>
        <section className={styles.plan} aria-label="Free plan">
          <h2>{FREE_PLAN.name}</h2>
          <p className={styles.price}><strong>$0</strong><span>/month</span></p>
          <ul className={styles.features}><li><span>✓</span>{FREE_PLAN.previews} previews/month</li></ul>
          {d.paid ? (
            <Form method="post" className={styles.planForm} onSubmit={e => {
              if (!window.confirm("Cancel your paid Visully plan and switch to Free? Paid benefits will end when Shopify confirms cancellation.")) e.preventDefault();
            }}>
              <input type="hidden" name="intent" value="switch-free" />
              <button type="submit" className={styles.select} disabled={saving}>Switch to Free</button>
            </Form>
          ) : <button type="button" className={styles.select} disabled>Current plan</button>}
        </section>
        {PLANS.map(plan => {
          const name = billingPlanName(plan, cycle);
          const active = d.activeSubscriptionName === name;
          return <section key={plan.id} className={styles.plan} aria-label={`${plan.name} plan`}>
            <h2>{plan.name}</h2>
            <p className={styles.price}><strong>{usd(cycle === "annual" ? annualPrice(plan.price) : plan.price)}</strong>
              <span>/{cycle === "annual" ? "year" : "month"}</span></p>
            <ul className={styles.features}>
              <li><span>✓</span>{plan.previews} previews each month</li>
              <li><span>✓</span>Furniture recommendations</li>
              <li><span>✓</span>AI room previews</li>
              <li><span>✓</span>{cycle === "annual" ? "Save two months" : "Billed through Shopify"}</li>
            </ul>
            <Form method="post" className={styles.planForm}>
              <input type="hidden" name="intent" value="select-plan" />
              <input type="hidden" name="plan" value={plan.id} />
              <input type="hidden" name="cycle" value={cycle} />
              <button type="submit" className={styles.select} disabled={saving || active || !d.billingStatus.verified}>
                {active ? "Current plan" : saving ? "Opening Shopify…" : "Choose plan"}
              </button>
            </Form>
          </section>;
        })}
      </div>

      <section className={styles.information} aria-label="Additional information">
        <h2>Additional information</h2>
        <div className={styles.purchaseRow}>
          <span className={styles.infoIcon} aria-hidden="true">⊕</span>
          <div className={styles.purchaseText}>
            <strong>Top-ups</strong>
            <span>Extra {TOP_UP.previews} image previews for {usd(TOP_UP.price)}. Available on paid plans only. Credits roll over while subscribed.</span>
          </div>
          <Form method="post">
            <input type="hidden" name="intent" value="buy-topup" />
            <button type="submit" className={styles.purchaseButton} disabled={!d.paid || saving}>
              {saving ? "Opening Shopify…" : `Buy ${TOP_UP.previews} credits`}
            </button>
          </Form>
        </div>
        <div className={styles.purchaseRow}>
          <span className={styles.infoIcon} aria-hidden="true">⊕</span>
          <div className={styles.purchaseText}>
            <strong>Annual billing</strong>
            <span>Pay for 10 months and get 12 months of access. Preview allowances renew monthly.</span>
          </div>
          <button type="button" className={styles.purchaseButton} onClick={() => setCycle("annual")}>
            View annual plans
          </button>
        </div>
      </section>
      <section className={styles.help}>
        <div><h2>Need help?</h2><p>Questions about your Visully plan or payments?</p></div>
        <a href="mailto:support@visully.io?subject=Visully%20Support%20Request" target="_top">Contact support</a>
      </section>
    </s-page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
