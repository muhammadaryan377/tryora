import prisma from "./db.server";
import { PLANS, TOP_UP } from "./plans";

/**
 * "Sales from Tryora" (owner decision, 19 Oct 2026): orders whose basket carries Tryora's hidden note, counting only
 * the products the shopper actually saw in their room. Shown on Home only when it's at least 3× what the merchant
 * pays for Tryora and there are at least 3 such orders, so it's never noise.
 */

export const MIN_ROAS = 3;
export const MIN_ORDERS = 3;
const CACHE_MS = 6 * 3_600_000;
const DAYS = 30;

// Approximate USD → store currency, to compare sales with Tryora's USD price. Unknown currencies show no card.
const USD_RATE: Record<string, number> = { USD: 1, GBP: 0.75, EUR: 0.92, CAD: 1.37, AUD: 1.52, NZD: 1.66 };

export interface SalesReport {
  computedAt: string;
  days: number;
  orders: number;
  sales: number;
  currency: string;
  cost: number;
  roas: number | null;
  show: boolean;
}

type Admin = { graphql: (q: string, o?: any) => Promise<Response> };

export async function salesReport(admin: Admin, shopId: string, force = false): Promise<SalesReport | null> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, include: { entitlement: true } });
  const cached = shop?.salesReport as SalesReport | null | undefined;
  if (!force && cached && Date.now() - new Date(cached.computedAt).getTime() < CACHE_MS) return cached;

  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  let orders = 0;
  let sales = 0;
  let currency = "USD";
  let after: string | null = null;
  try {
    for (let page = 0; page < 10; page++) {
      const res = await admin.graphql(
        `#graphql
        query TryoraOrders($q: String!, $after: String) {
          shop { currencyCode }
          orders(first: 250, after: $after, query: $q) {
            pageInfo { hasNextPage endCursor }
            nodes {
              customAttributes { key value }
              lineItems(first: 50) { nodes { product { id } discountedTotalSet { shopMoney { amount } } } }
            }
          }
        }`,
        { variables: { q: `created_at:>='${since}' AND -status:cancelled`, after } },
      );
      const json: any = await res.json();
      if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 300));
      currency = json.data.shop.currencyCode;
      for (const o of json.data.orders.nodes) {
        const attrs = Object.fromEntries((o.customAttributes ?? []).map((a: any) => [a.key, a.value]));
        if (attrs._tryora !== "1") continue;
        const seen = new Set(String(attrs._tryora_products ?? "").split(",").filter(Boolean));
        let orderSales = 0;
        for (const li of o.lineItems.nodes) {
          const id = li.product?.id?.split("/").pop();
          if (id && seen.has(id)) orderSales += Number(li.discountedTotalSet.shopMoney.amount);
        }
        if (orderSales > 0) {
          orders++;
          sales += orderSales;
        }
      }
      if (!json.data.orders.pageInfo.hasNextPage) break;
      after = json.data.orders.pageInfo.endCursor;
    }
  } catch (e) {
    console.error("Sales report failed", shopId, e);
    return cached ?? null;
  }

  // What the merchant pays for 30 days: their plan (Starter's price while on the free trial), plus top-ups bought.
  const plan = PLANS.find((p) => p.id === shop?.entitlement?.plan) ?? PLANS[0];
  const topUps = await prisma.creditLedgerEntry.count({
    where: { shopId, type: "GRANT", bucket: "topup", createdAt: { gte: new Date(since) } },
  });
  const rate = USD_RATE[currency];
  const cost = rate ? (plan.price + topUps * TOP_UP.price) * rate : 0;
  const roas = cost > 0 ? sales / cost : null;
  const report: SalesReport = {
    computedAt: new Date().toISOString(),
    days: DAYS,
    orders,
    sales: Math.round(sales * 100) / 100,
    currency,
    cost: Math.round(cost * 100) / 100,
    roas: roas === null ? null : Math.round(roas * 10) / 10,
    show: roas !== null && roas >= MIN_ROAS && orders >= MIN_ORDERS,
  };
  await prisma.shop.update({ where: { id: shopId }, data: { salesReport: report as object } });
  return report;
}
