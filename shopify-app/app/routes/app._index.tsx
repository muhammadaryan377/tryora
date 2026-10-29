import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useLocation, useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { tryora } from "../tryora.server";
import { salesReport } from "../attribution.server";
import { ensureBillingAllowance } from "../billing-status.server";
import { HomeDashboard } from "../components/home-dashboard";
import { hasVerifiedPaidPlan } from "../billing-purchases.server";
import styles from "../styles/billing.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shopId = session.shop;

  const billingStatus = await ensureBillingAllowance(admin, shopId);

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [balance, shop, productsReady, appearance, previewsThisMonth, leadsThisMonth] = await Promise.all([
    tryora.balance(shopId),
    prisma.shop.findUnique({ where: { id: shopId } }),
    prisma.productPreviewConfig.count({ where: { shopId, enabled: true } }),
    prisma.appearance.findFirst({ where: { shopId, scope: "store" } }),
    prisma.previewJob.count({ where: { shopId, state: "DELIVERED", deliveredAt: { gte: monthStart } } }),
    prisma.leadDelivery.count({ where: { shopId, OR: [{ email: { not: null } }, { customerRef: { not: null } }], createdAt: { gte: monthStart } } }),
  ]);

  const sales = await salesReport(admin, shopId);

  return {
    subscriptionActivated: new URL(request.url).searchParams.get("subscription") === "verify" && hasVerifiedPaidPlan(billingStatus),
    subscriptionVerificationPending: new URL(request.url).searchParams.get("subscription") === "verify" && !hasVerifiedPaidPlan(billingStatus),
    shop: shopId,
    sales: sales?.show ? sales : null,
    credits: { available: balance.availableTotal, reserved: balance.reserved },
    allowance: { developer: billingStatus.developer, verified: billingStatus.verified, monthly: billingStatus.allowance },
    paid: shop?.paidPlanActive ?? false,
    abuseAlert: shop?.abuseAlertAt && Date.now() - shop.abuseAlertAt.getTime() < 86_400_000 ? shop.abuseAlertAt.toISOString() : null,
    leadCapture: shop?.leadCapture ?? "required",
    leadTiming: shop?.leadTiming ?? "before",
    checklist: {
      products: productsReady,
      style: !!appearance,
      storefront: shop?.storefrontEnabled ?? false,
    },
    month: { previews: previewsThisMonth, leads: leadsThisMonth },
  };
};

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const [showSuccess, setShowSuccess] = useState(data.subscriptionActivated);
  const location = useLocation();
  const [showCancelled, setShowCancelled] = useState(location.state?.subscriptionCancelled === true);
  const navigate = useNavigate();
  useEffect(() => {
    if (location.state?.subscriptionCancelled === true) {
      setShowCancelled(true);
      navigate({ pathname: "/app", search: location.search }, { replace: true, state: null });
    }
  }, [location.state, location.search, navigate]);
  useEffect(() => {
    if (!data.subscriptionActivated) return;
    setShowSuccess(true);
    const search = new URLSearchParams(location.search);
    search.delete("subscription");
    search.delete("charge_id");
    // Keep the card for this visit, but remove the callback from the URL so
    // refreshing opens Home without repeating the activation message.
    navigate({ pathname: "/app", search: search.size ? `?${search}` : "" }, { replace: true });
  }, [data.subscriptionActivated, location.search, navigate]);
  if (showSuccess || showCancelled) return <s-page heading="">
    <section className={styles.activationCard} aria-labelledby="subscription-activated">
      <svg className={styles.activationCheck} viewBox="0 0 36 36" fill="none" aria-hidden="true">
        <circle cx="18" cy="18" r="15" stroke="currentColor" strokeWidth="3" />
        <path d="m11.5 18 4.5 5 8.5-11" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <h1 id="subscription-activated">{showCancelled ? "Subscription Cancelled" : "Subscription Activated!"}</h1>
      <p>{showCancelled ? "Your paid Visully subscription has been cancelled." : "Your Visully subscription is now active."}</p>
      <p className={styles.activationCredits}>{showCancelled ? "You are now on the Free plan." : "Your plan credits are ready to use."}</p>
      <button type="button" className={styles.dashboardButton} onClick={() => { setShowSuccess(false); setShowCancelled(false); }}>Go to Dashboard</button>
    </section>
  </s-page>;
  if (data.subscriptionVerificationPending) return <s-page heading="Subscription verification">
    <s-banner tone="warning" heading="Your subscription is not verified yet">
      We could not confirm an active subscription with Shopify. Check Plans &amp; Billing before trying another payment.
    </s-banner>
    <s-link href="/app/billing">Go to Plans &amp; Billing</s-link>
  </s-page>;
  return <HomeDashboard data={data} />;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
