import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { tryora } from "../tryora.server";
import { salesReport } from "../attribution.server";
import { ensureBillingAllowance } from "../billing-status.server";
import { HomeDashboard } from "../components/home-dashboard";

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
  return <HomeDashboard data={data} />;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
