import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listShopProducts, productRows } from "../products.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const rows = await productRows(session.shop, await listShopProducts(admin));
  return { rows };
};

const STATUS: Record<string, { tone: "success" | "caution" | "neutral"; label: string }> = {
  ready: { tone: "success", label: "Live" },
  needs_attention: { tone: "caution", label: "Needs attention" },
  off: { tone: "neutral", label: "Off" },
};

export default function Products() {
  const { rows } = useLoaderData<typeof loader>();
  const live = rows.filter((r) => r.readiness === "ready").length;

  return (
    <s-page heading="Products">
      <s-section>
        <s-paragraph>
          Choose which products shoppers can see in their room. {live} of {rows.length} products are live.
        </s-paragraph>
        {rows.length === 0 ? (
          <s-paragraph>
            <s-text color="subdued">No products found in your store yet.</s-text>
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header>Type</s-table-header>
              <s-table-header>Shoppers can switch</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
              <s-table-header>Action</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-thumbnail size="small" src={r.image} alt={r.title} />
                      <s-text>{r.title}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{r.itemNoun}</s-table-cell>
                  <s-table-cell>{r.visualOptionName ?? "Single style"}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS[r.readiness].tone}>{STATUS[r.readiness].label}</s-badge>
                    {r.readinessReason && (
                      <s-text color="subdued"> {r.readinessReason}</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-button variant="tertiary" href={`/app/products/${encodeURIComponent(r.id.split("/").pop()!)}`}>
                      {r.enabled ? "Edit" : "Set up"}
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
