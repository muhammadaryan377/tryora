import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { tryora } from "../tryora.server";
import { billingPresentation, ensureBillingAllowance } from "../billing-status.server";

import { FREE_PLAN, PLANS, TOP_UP } from "../plans";
import styles from "../styles/billing.module.css";

const usd = (n: number) => `$${n.toFixed(2)}`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shopId = session.shop;
  const billingStatus = await ensureBillingAllowance(admin, shopId);
  const [balance, shop, entitlement] = await Promise.all([
    tryora.balance(shopId),
    prisma.shop.findUnique({ where: { id: shopId } }),
    prisma.billingEntitlement.findUnique({ where: { shopId } }),
  ]);
  return {
    billingStatus,
    presentation: billingPresentation(billingStatus, entitlement?.plan ?? "free", shop?.paidPlanActive ?? false),
    entitlementStatus: entitlement?.status ?? "none",
    plan: entitlement?.plan ?? "free",
    periodEnds: entitlement?.currentPeriodEnds?.toISOString() ?? null,
    availableCredits: balance.availableTotal,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const f = await request.formData();
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop?.paidPlanActive) {
    return { ok: false as const, errors: ["Automatic top-ups are available once you're on a paid plan."] };
  }

  const autoTopUp = f.get("autoTopUp") === "on";
  const capRaw = String(f.get("cap") ?? "").trim();
  const cap = capRaw ? Number(capRaw) : NaN;
  if (autoTopUp && !(cap >= TOP_UP.price)) {
    return { ok: false as const, errors: [`Set a monthly limit of at least ${usd(TOP_UP.price)} (one top-up).`] };
  }
  const monthlySpendCapCents = Number.isFinite(cap) && cap > 0 ? Math.round(cap * 100) : null;
  await prisma.billingEntitlement.upsert({
    where: { shopId },
    create: { shopId, autoTopUp, monthlySpendCapCents },
    update: { autoTopUp, monthlySpendCapCents },
  });
  return { ok: true as const, errors: [] as string[] };
};

const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default function Billing() {
  const d = useLoaderData<typeof loader>();

  return (
    <s-page heading="Plans & Billing" inlineSize="large">
      <p className={styles.subtitle}>Choose the right plan for your business. Simple, transparent pricing to grow with you.</p>
      <section className={styles.current} aria-label="Current plan">
        <p>Store status: <span className={styles.badge}>{d.presentation.storeStatus}</span></p>
        <p>Your current plan: {d.presentation.plan}</p>
        <p>Shopify subscription: {d.presentation.subscriptionStatus}</p>
        <p>Saved entitlement: {d.plan} ({d.entitlementStatus})</p>
        <p>Available preview credits: {d.availableCredits}</p>
        <div className={styles.notice}><span aria-hidden="true">&#9432;</span> {d.presentation.information}{d.periodEnds ? ` Current credit period ends on ${date(d.periodEnds)}.` : ""}</div>
      </section>
      <div className={styles.plans}>
        {[FREE_PLAN, ...PLANS].map((p) => {
          return (
            <section key={p.id} className={styles.plan} aria-label={`${p.name} plan`}>
              <h2>{p.name}</h2>
              <p className={styles.price}><strong>${p.price}</strong><span>/month</span></p>
              <ul className={styles.features}>
                {["AI room previews", "Furniture recommendations", p.id === "free" ? "Basic analytics" : "Advanced analytics", p.id === "free" ? "Community support" : p.id === "starter" ? "Email support" : "Priority support"].map((feature) => <li key={feature}><span aria-hidden="true">&#10003;</span>{feature}</li>)}
                <li><span aria-hidden="true">&#10003;</span><div><strong>{p.previews} previews/month</strong>{p.id === "free" && <small className={styles.watermark}>with a small Tryora mark</small>}</div></li>
              </ul>
              <button className={styles.select} disabled>Select</button>
            </section>
          );
        })}
      </div>
      <section className={styles.information}>
        <h2>Additional information</h2>
        <p><span className={styles.infoIcon} aria-hidden="true">&#8853;</span><span><strong>Top-ups:</strong> extra images cost ${TOP_UP.price} per {TOP_UP.previews}, for paid plans only.</span></p>
        <p><span className={styles.infoIcon} aria-hidden="true">&#8853;</span><span><strong>Annual billing:</strong> paying yearly gets two months free.</span></p>
      </section>
      <section className={styles.help}>
        <div><h2>Need help?</h2><p>Have questions about our plans or need a custom solution?</p></div>
        <a href="mailto:support@visully.io?subject=Tryora%20Support%20Request" target="_top">Contact support <span aria-hidden="true">&#8599;</span></a>
      </section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
