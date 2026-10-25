import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError, useLocation } from "react-router";
import { useEffect, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", shop: session.shop };
};

export default function App() {
  const { apiKey, shop } = useLoaderData<typeof loader>();
  const location = useLocation();
  const [lastFabricProduct, setLastFabricProduct] = useState<string | null>(null);
  useEffect(() => {
    const key = `tryora:last-fabric-product:${shop}`;
    const selected = location.pathname === "/app/fabrics" ? new URLSearchParams(location.search).get("product") : null;
    if (selected && /^gid:\/\/shopify\/Product\/\d{1,20}$/.test(selected)) {
      sessionStorage.setItem(key, selected);
      setLastFabricProduct(selected);
    } else {
      setLastFabricProduct(sessionStorage.getItem(key));
    }
  }, [location.pathname, location.search, shop]);

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/products">Products</s-link>
        <s-link href={lastFabricProduct ? `/app/fabrics?product=${encodeURIComponent(lastFabricProduct)}&workspace=manual` : "/app/fabrics?workspace=manual"}>Fabrics &amp; Colours</s-link>
        <s-link href="/app/appearance">Appearance</s-link>
        <s-link href="/app/assistant">Room assistant</s-link>
        <s-link href="/app/leads">Leads &amp; offers</s-link>
        <s-link href="/app/limits">Shopper limits</s-link>
        <s-link href="/app/billing">Plan &amp; credits</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
