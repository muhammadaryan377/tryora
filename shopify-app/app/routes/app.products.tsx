import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData } from "react-router";
import { useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listShopProducts, productRows } from "../products.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const rows = await productRows(session.shop, await listShopProducts(admin));
  const shop = await prisma.shop.findUnique({ where: { id: session.shop } });
  return { rows, autoEnabled: shop?.autoEnableProducts ?? true };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") !== "product-mode") return new Response("Invalid action", { status: 400 });
  const mode = String(form.get("mode") ?? "");
  if (mode !== "all" && mode !== "selected") return new Response("Invalid mode", { status: 400 });
  await prisma.shop.upsert({
    where: { id: session.shop },
    create: { id: session.shop, autoEnableProducts: mode === "all" },
    update: { autoEnableProducts: mode === "all" },
  });
  return redirect("/app/products");
};

const STATUS: Record<string, { tone: "success" | "caution" | "neutral"; label: string }> = {
  ready: { tone: "success", label: "Live" },
  needs_attention: { tone: "caution", label: "Needs attention" },
  off: { tone: "neutral", label: "Off" },
};

export default function Products() {
  const { rows, autoEnabled } = useLoaderData<typeof loader>();
  const [mode, setMode] = useState(autoEnabled ? "all" : "selected");
  const live = rows.filter((r) => r.readiness === "ready").length;

  return (
    <s-page heading="Products">
      <s-section heading="Where Tryora appears">
        <s-paragraph>
          All eligible furniture products can show Tryora automatically, including newly added products.
          Active products need a Shopify photo. Gift cards, bedding accessories and other products are excluded.
          You can still turn off or customise any individual product below.
        </s-paragraph>
        <Form method="post">
          <input type="hidden" name="intent" value="product-mode" />
          <input type="hidden" name="mode" value={mode} />
          <s-stack gap="base">
            <s-select label="Product availability mode" value={mode} onChange={(e: any) => setMode(e.currentTarget.value)}>
              <s-option value="all">All eligible furniture products (automatic)</s-option>
              <s-option value="selected">Only products enabled manually</s-option>
            </s-select>
            <s-button type="submit" variant="primary">Save product mode</s-button>
          </s-stack>
        </Form>
      </s-section>
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
                    {r.swatchNote && (
                      <s-text color="subdued"> {r.swatchNote}</s-text>
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
