import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { tryora } from "../tryora.server";
import { TRIAL_CREDITS } from "../core/index";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  // The free trial starts the first time the merchant opens Tryora. Safe to call on every visit.
  await tryora.grantTrial(shopId);

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [balance, trial, shop, productsReady, appearance, previewsThisMonth, leadsThisMonth] = await Promise.all([
    tryora.balance(shopId),
    tryora.trialStatus(shopId),
    prisma.shop.findUnique({ where: { id: shopId } }),
    prisma.productPreviewConfig.count({ where: { shopId, enabled: true } }),
    prisma.appearance.findFirst({ where: { shopId, scope: "store" } }),
    prisma.previewJob.count({ where: { shopId, state: "DELIVERED", deliveredAt: { gte: monthStart } } }),
    prisma.leadDelivery.count({ where: { shopId, createdAt: { gte: monthStart } } }),
  ]);

  return {
    shop: shopId,
    credits: { available: balance.availableTotal, reserved: balance.reserved },
    trial: {
      active: trial.started && trial.active,
      used: trial.started ? trial.delivered : 0,
      total: TRIAL_CREDITS,
      endsAt: trial.started && trial.endsAt ? new Date(trial.endsAt).toISOString() : null,
    },
    paid: shop?.paidPlanActive ?? false,
    leadCapture: shop?.leadCapture ?? "required",
    checklist: {
      products: productsReady,
      style: !!appearance,
      storefront: shop?.storefrontEnabled ?? false,
    },
    month: { previews: previewsThisMonth, leads: leadsThisMonth },
  };
};

function daysLeft(iso: string | null) {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

export default function Dashboard() {
  const d = useLoaderData<typeof loader>();
  const themeEditor = `https://${d.shop}/admin/themes/current/editor?context=apps`;
  const steps = [
    {
      done: d.checklist.products > 0,
      title: "Choose your products",
      body: "Pick which products shoppers can preview, and which option (like colour) they can switch between.",
      href: "/app/products",
      cta: d.checklist.products > 0 ? `${d.checklist.products} set up` : "Choose products",
    },
    {
      done: d.checklist.style,
      title: "Pick a style",
      body: "Choose one of five popup styles and how shoppers open it.",
      href: "/app/appearance",
      cta: "Choose style",
    },
    {
      done: d.checklist.storefront,
      title: "Turn Tryora on in your theme",
      body: "Switch on the Tryora app embed in your theme editor so the button appears on product pages.",
      href: themeEditor,
      cta: "Open theme editor",
      external: true,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <s-page heading="Tryora">
      {d.trial.active && !d.paid && (
        <s-banner tone="info" heading={`Free trial: ${d.trial.total - d.trial.used} of ${d.trial.total} previews left`}>
          <s-paragraph>
            Your trial ends in {daysLeft(d.trial.endsAt)} days. Trial previews are free and don't renew automatically.
          </s-paragraph>
        </s-banner>
      )}
      {!d.trial.active && !d.paid && (
        <s-banner tone="warning" heading="Your free trial has ended">
          <s-paragraph>Choose a plan to keep showing previews to your shoppers.</s-paragraph>
          <s-button slot="primary-action" href="/app/billing">
            See plans
          </s-button>
        </s-banner>
      )}

      <s-section heading={`Get set up (${doneCount} of ${steps.length})`}>
        <s-progress value={doneCount} max={steps.length} accessibilityLabel="Setup progress" />
        <s-stack gap="base">
          {steps.map((s, i) => (
            <s-box key={s.title} padding="base" border="base" borderRadius="base" background={s.done ? "subdued" : "base"}>
              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                <s-stack gap="small-200">
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-badge tone={s.done ? "success" : "neutral"}>{s.done ? "Done" : `Step ${i + 1}`}</s-badge>
                    <s-heading>{s.title}</s-heading>
                  </s-stack>
                  <s-text color="subdued">{s.body}</s-text>
                </s-stack>
                <s-button variant={s.done ? "tertiary" : "primary"} href={s.href} target={s.external ? "_blank" : "auto"}>
                  {s.cta}
                </s-button>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="This month">
        <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
          <s-box padding="base" border="base" borderRadius="base">
            <s-text color="subdued">Previews shown</s-text>
            <s-heading>{d.month.previews}</s-heading>
          </s-box>
          <s-box padding="base" border="base" borderRadius="base">
            <s-text color="subdued">Emails captured</s-text>
            <s-heading>{d.month.leads}</s-heading>
          </s-box>
          <s-box padding="base" border="base" borderRadius="base">
            <s-text color="subdued">Credits left</s-text>
            <s-heading>{d.credits.available}</s-heading>
          </s-box>
        </s-grid>
      </s-section>

      <s-section slot="aside" heading="How credits work">
        <s-paragraph>
          One credit is used only when a shopper actually receives their preview. Rejected photos, failed images and
          confirmed problems don't cost you anything.
        </s-paragraph>
      </s-section>
      <s-section slot="aside" heading="Lead capture">
        <s-paragraph>
          Email before first preview:{" "}
          <s-text type="strong">
            {d.leadCapture === "required" ? "Required" : d.leadCapture === "skippable" ? "Optional" : "Off"}
          </s-text>
        </s-paragraph>
        <s-link href="/app/leads">Change</s-link>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
