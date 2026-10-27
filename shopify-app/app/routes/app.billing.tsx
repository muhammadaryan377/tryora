import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { tryora } from "../tryora.server";
import { TRIAL_CREDITS, TRIAL_DAYS } from "../core/index";

import { PLANS, TOP_UP } from "../plans";
import styles from "../styles/billing.module.css";

const usd = (n: number) => `$${n.toFixed(2)}`;

const GRANT_LABEL: Record<string, string> = {
  trial: "Free trial",
  period: "Monthly plan credits",
  topup: "Top-up",
  refund: "Credit returned for a reported issue",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shopId = session.shop;
  await tryora.grantTrial(shopId);
  const usage = await usageOverview(admin, shopId);

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [balance, trial, shop, entitlement, grants, deliveredThisMonth] = await Promise.all([
    tryora.balance(shopId),
    tryora.trialStatus(shopId),
    prisma.shop.findUnique({ where: { id: shopId } }),
    prisma.billingEntitlement.findUnique({ where: { shopId } }),
    prisma.creditLedgerEntry.findMany({ where: { shopId, type: "GRANT" }, orderBy: { createdAt: "desc" }, take: 25 }),
    prisma.previewJob.count({ where: { shopId, state: "DELIVERED", deliveredAt: { gte: monthStart } } }),
  ]);

  return {
    trialCredits: TRIAL_CREDITS,
    trialDays: TRIAL_DAYS,
    paid: shop?.paidPlanActive ?? false,
    plan: entitlement?.plan ?? "trial",
    periodEnds: entitlement?.currentPeriodEnds?.toISOString() ?? null,
    autoTopUp: entitlement?.autoTopUp ?? false,
    capDollars: entitlement?.monthlySpendCapCents != null ? (entitlement.monthlySpendCapCents / 100).toString() : "",
    balance: {
      total: balance.availableTotal,
      trial: balance.available.trial,
      period: balance.available.period + balance.available.refund,
      topup: balance.available.topup,
      reserved: balance.reserved,
    },
    trial: {
      started: trial.started,
      active: trial.started && trial.active,
      used: trial.started ? trial.delivered : 0,
      endsAt: trial.started && trial.endsAt ? new Date(trial.endsAt).toISOString() : null,
    },
    deliveredThisMonth,
    usage,
    grants: grants.map((g) => ({
      id: g.id,
      label: GRANT_LABEL[g.bucket ?? ""] ?? "Credits added",
      quantity: g.quantity,
      at: g.createdAt.toISOString(),
      expiresAt: g.expiresAt?.toISOString() ?? null,
    })),
  };
};

/** Last 30 days of delivered previews (one credit each), by day and by product. */
async function usageOverview(admin: { graphql: (q: string, o?: any) => Promise<Response> }, shopId: string) {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - 29);
  const [delivered, notCharged] = await Promise.all([
    prisma.previewJob.findMany({
      where: { shopId, state: "DELIVERED", deliveredAt: { gte: since } },
      select: { deliveredAt: true, productId: true, refundedAt: true },
    }),
    prisma.previewJob.count({ where: { shopId, createdAt: { gte: since }, state: { in: ["FAILED", "REJECTED", "EXPIRED", "CANCELLED"] } } }),
  ]);
  const days: { date: string; count: number }[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(since.getTime() + i * 86_400_000);
    days.push({ date: d.toISOString().slice(0, 10), count: 0 });
  }
  const byDay = new Map(days.map((d) => [d.date, d]));
  const byProduct = new Map<string, number>();
  let refunded = 0;
  for (const j of delivered) {
    const key = j.deliveredAt!.toISOString().slice(0, 10);
    const day = byDay.get(key);
    if (day) day.count++;
    byProduct.set(j.productId, (byProduct.get(j.productId) ?? 0) + 1);
    if (j.refundedAt) refunded++;
  }
  const top = [...byProduct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  let titles: Record<string, string> = {};
  if (top.length) {
    try {
      const res = await admin.graphql(`#graphql
        query T($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id title } } }`, { variables: { ids: top.map(([id]) => id) } });
      const json: any = await res.json();
      titles = Object.fromEntries((json.data?.nodes ?? []).filter(Boolean).map((n: any) => [n.id, n.title]));
    } catch {
      /* titles are a nicety */
    }
  }
  return {
    days,
    total: delivered.length,
    refunded,
    notCharged,
    products: top.map(([id, count]) => ({ id, title: titles[id] ?? "Removed product", count })),
  };
}

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
  const currentPlan = PLANS.find((p) => p.id === d.plan);

  return (
    <s-page heading="Plans & Billing" inlineSize="large">
      <p className={styles.subtitle}>Choose the right plan for your business. Simple, transparent pricing to grow with you.</p>
      <section className={styles.current} aria-label="Current plan">
        <p>Your current plan: <span className={styles.badge}>{d.paid && currentPlan ? currentPlan.name : "Free trial"}</span></p>
        <div className={styles.notice}><span aria-hidden="true">&#9432;</span> {d.paid ? `Your plan includes ${currentPlan?.previews ?? 0} previews each month.${d.periodEnds ? ` Credits renew on ${date(d.periodEnds)}.` : ""}` : `Try Tryora with ${d.trialCredits} previews for ${d.trialDays} days. No automatic charges.`}</div>
      </section>
      <div className={styles.plans}>
        {[{ id: "free", name: "Free", price: 0, previews: 10 }, ...PLANS].map((p) => {
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
        <a href="mailto:support@visully.io">Contact support <span aria-hidden="true">&#8599;</span></a>
      </section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
