import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { tryora } from "../tryora.server";
import { TRIAL_CREDITS, TRIAL_DAYS } from "../core/index";

// Agreed pricing (build brief section 9). USD, per store, before tax.
const PLANS = [
  { id: "starter", name: "Starter", price: 34.8, previews: 100 },
  { id: "growth", name: "Growth", price: 82.8, previews: 250 },
  { id: "scale", name: "Scale", price: 178.8, previews: 600 },
] as const;
const TOP_UP = { price: 34.8, previews: 100 };

const usd = (n: number) => `$${n.toFixed(2)}`;

const GRANT_LABEL: Record<string, string> = {
  trial: "Free trial",
  period: "Monthly plan credits",
  topup: "Top-up",
  refund: "Credit returned for a reported issue",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  await tryora.grantTrial(shopId);

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
    grants: grants.map((g) => ({
      id: g.id,
      label: GRANT_LABEL[g.bucket ?? ""] ?? "Credits added",
      quantity: g.quantity,
      at: g.createdAt.toISOString(),
      expiresAt: g.expiresAt?.toISOString() ?? null,
    })),
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

function daysLeft(iso: string | null) {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default function Billing() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const [autoTopUp, setAutoTopUp] = useState(d.autoTopUp);
  const [cap, setCap] = useState(d.capDollars);
  const currentPlan = PLANS.find((p) => p.id === d.plan);
  const maxTopUps = cap && Number(cap) >= TOP_UP.price ? Math.floor(Number(cap) / TOP_UP.price) : 0;

  return (
    <s-page heading="Plan & credits">
      {result?.ok && <s-banner tone="success" heading="Saved" />}
      {result && !result.ok && (
        <s-banner tone="critical" heading="Please fix the following">
          <s-unordered-list>
            {result.errors.map((e) => (
              <s-list-item key={e}>{e}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}

      {!d.paid && d.trial.active && (
        <s-banner tone="info" heading={`Free trial: ${d.trial.used} of ${TRIAL_CREDITS} previews used, ${daysLeft(d.trial.endsAt)} days left`}>
          <s-paragraph>
            The trial ends after {TRIAL_DAYS} days or {TRIAL_CREDITS} previews, whichever comes first. It never turns into a
            paid plan on its own. Choose a plan below when you're ready.
          </s-paragraph>
        </s-banner>
      )}
      {!d.paid && d.trial.started && !d.trial.active && (
        <s-banner tone="warning" heading="Your free trial has ended">
          <s-paragraph>
            Shoppers can't make new previews until you choose a plan. Your store and checkout keep working as normal.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Credits">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="base">
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-text color="subdued">Available now</s-text>
            <s-heading>{d.balance.total}</s-heading>
          </s-box>
          {!d.paid ? (
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-text color="subdued">Trial credits</s-text>
              <s-heading>{d.balance.trial}</s-heading>
            </s-box>
          ) : (
            <>
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-text color="subdued">This month's plan credits</s-text>
                <s-heading>{d.balance.period}</s-heading>
              </s-box>
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-text color="subdued">Top-up credits</s-text>
                <s-heading>{d.balance.topup}</s-heading>
              </s-box>
            </>
          )}
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-text color="subdued">Being made right now</s-text>
            <s-heading>{d.balance.reserved}</s-heading>
          </s-box>
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-text color="subdued">Previews delivered this month</s-text>
            <s-heading>{d.deliveredThisMonth}</s-heading>
          </s-box>
        </s-grid>
        <s-paragraph>
          <s-text color="subdued">
            One credit is used only when a shopper receives a finished image. Failed or abandoned attempts, and photos
            we reject, don't use a credit. Monthly credits are used before top-ups.
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section heading={d.paid && currentPlan ? `Your plan: ${currentPlan.name}` : "Choose a plan"}>
        {d.paid && d.periodEnds && (
          <s-paragraph>Your monthly credits renew on {date(d.periodEnds)}.</s-paragraph>
        )}
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
          {PLANS.map((p) => {
            const current = d.paid && d.plan === p.id;
            return (
              <s-box key={p.id} padding="base" border={current ? "large-100 strong solid" : "base"} borderRadius="base">
                <s-stack gap="small-200">
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                    <s-heading>{p.name}</s-heading>
                    {current && <s-badge tone="success">Current plan</s-badge>}
                  </s-stack>
                  <s-text type="strong">{usd(p.price)} / month</s-text>
                  <s-text>{p.previews} previews a month</s-text>
                  <s-text color="subdued">About {usd(p.price / p.previews)} per preview</s-text>
                  {!current && (
                    <s-button disabled accessibilityLabel={`Choose ${p.name} (coming soon)`}>
                      Choose {p.name}
                    </s-button>
                  )}
                </s-stack>
              </s-box>
            );
          })}
        </s-grid>
        <s-paragraph>
          <s-text color="subdued">
            Prices in USD before tax, billed through Shopify. Every plan includes all five styles, downloads, email
            capture, offers and reports. Plan sign-up opens before launch.
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section heading="Top-ups">
        <s-paragraph>
          {TOP_UP.previews} extra previews for {usd(TOP_UP.price)}, paid once. Unused top-up credits carry over each month
          while you're on a paid plan.
        </s-paragraph>
        {!d.paid ? (
          <s-paragraph>
            <s-text color="subdued">Top-ups are available once you're on a paid plan.</s-text>
          </s-paragraph>
        ) : (
          <Form method="post">
            {autoTopUp && <input type="hidden" name="autoTopUp" value="on" />}
            <input type="hidden" name="cap" value={cap} />
            <s-stack gap="base">
              <s-button disabled>Buy a top-up (coming soon)</s-button>
              <s-switch
                label="Top up automatically when I run out"
                checked={autoTopUp || undefined}
                onChange={(e: any) => setAutoTopUp(!!e.currentTarget.checked)}
                details="Off by default. Without it, new previews pause when credits run out. Checkout is never affected."
              />
              {autoTopUp && (
                <s-number-field
                  label="Monthly limit for automatic top-ups (USD)"
                  value={cap}
                  min={TOP_UP.price}
                  onInput={(e: any) => setCap(e.currentTarget.value)}
                  details={
                    maxTopUps > 0
                      ? `Up to ${maxTopUps} automatic top-up${maxTopUps === 1 ? "" : "s"} a month.`
                      : `At least ${usd(TOP_UP.price)}.`
                  }
                />
              )}
              <s-button type="submit" variant="primary" loading={nav.state === "submitting" || undefined}>
                Save
              </s-button>
            </s-stack>
          </Form>
        )}
      </s-section>

      <s-section heading="Credit history">
        {d.grants.length === 0 ? (
          <s-paragraph>
            <s-text color="subdued">No credits added yet.</s-text>
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">What</s-table-header>
              <s-table-header>Credits</s-table-header>
              <s-table-header listSlot="secondary">Date</s-table-header>
              <s-table-header>Expires</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.grants.map((g) => (
                <s-table-row key={g.id}>
                  <s-table-cell>{g.label}</s-table-cell>
                  <s-table-cell>+{g.quantity}</s-table-cell>
                  <s-table-cell>{date(g.at)}</s-table-cell>
                  <s-table-cell>{g.expiresAt ? date(g.expiresAt) : "Doesn't expire"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section slot="aside" heading="When credits run out">
        <s-paragraph>
          The Tryora button stays on your product pages, but shoppers see a short message instead of starting a new
          preview. Your store and checkout keep working as normal.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
