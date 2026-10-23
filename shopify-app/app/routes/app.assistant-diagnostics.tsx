import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { runAssistantDiagnostics } from "../assistant/diagnostics.server";

const LABELS: Record<string, string> = {
  scopes: "App permissions",
  counts: "Shopify product counts",
  catalogue: "Assistant catalogue query",
  search: "Product search",
  product: "Product lookup",
  cache: "Assistant cache",
};

/** Read-only: runs the Room Assistant's own catalogue queries against this store and shows what it can see. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = (url.searchParams.get("q") ?? "bed").slice(0, 60) || "bed";
  const handle = (url.searchParams.get("handle") ?? "").slice(0, 120);
  return { search, handle, ...(await runAssistantDiagnostics(admin, session.shop, { search, handle })) };
};

export default function AssistantDiagnostics() {
  const data = useLoaderData<typeof loader>();
  return (
    <s-page heading="Room assistant catalogue check">
      <s-section heading={`Store: ${data.shop}`}>
        <s-paragraph>
          <s-text color="subdued">Read-only. Runs the assistant's own Shopify queries now ({new Date(data.checkedAt).toLocaleString()}).</s-text>
        </s-paragraph>
        <Form method="get">
          <s-stack gap="base">
            <s-text-field label="Search the assistant would run" name="q" value={data.search} />
            <s-text-field label="Product handle to check (optional)" name="handle" value={data.handle} details="For example egerie-curved-headboard-beige-boucle-bed" />
            <s-button type="submit">Run check</s-button>
          </s-stack>
        </Form>
      </s-section>
      {Object.entries(data.checks).map(([key, check]) => (
        <s-section key={key} heading={`${check.ok ? "✓" : "✕"} ${LABELS[key] ?? key}`}>
          <s-paragraph>{check.detail}</s-paragraph>
          {check.code && <s-paragraph><s-text color="subdued">Shopify code: {check.code}</s-text></s-paragraph>}
        </s-section>
      ))}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
