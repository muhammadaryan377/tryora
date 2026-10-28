import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { exportShopifyDataRequest } from "../privacy.server";

/** Merchant-only. No untrusted shop domain or customer ID is accepted as authority. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const requests = await prisma.privacyRequest.findMany({
    where: { shopId: session.shop },
    take: 100,
    orderBy: { createdAt: "desc" },
    select: { requestId: true, customerId: true, email: true, status: true,
      createdAt: true, exportedAt: true },
  });
  return { requests };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const id = String(form.get("requestId") ?? "");
  if (!/^\d{1,30}$/.test(id)) throw new Response("Invalid request", { status: 400 });
  try {
    const data = await exportShopifyDataRequest(session.shop, id);
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="visully-customer-request-${id}.json"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    // Keep private customer details and database errors out of the response/logs.
    throw new Response("Unable to export this request. Verify the request or contact support.", { status: 404 });
  }
};

export default function PrivacyRequests() {
  const { requests } = useLoaderData<typeof loader>();
  return <s-page heading="Privacy requests">
    <s-section heading="Shopify customer data requests">
      <s-paragraph>
        Shopify sends customer data requests to Visully. Only authenticated staff on this shop can
        export records retained by Visully. Download the data and securely deliver it to the
        merchant or requesting customer through your established privacy process within the required timeframe.
        Exporting is not the same as fulfilling the request.
      </s-paragraph>
      <s-paragraph>
        The export contains recorded lead submissions and consent information, not Shopify orders
        or other apps' records. Keep the exported file secure and delete it after handling.
      </s-paragraph>
      {requests.length === 0 ? <s-paragraph>No customer data requests recorded.</s-paragraph> :
        <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
          <thead><tr>{["Shopify request", "Customer", "Status", "Received", "Export"].map(h =>
            <th key={h} style={{ padding: "12px 8px", borderBottom: "1px solid #ddd" }}>{h}</th>)}</tr></thead>
          <tbody>{requests.map(row => <tr key={row.requestId}>
            <td style={{ padding: "12px 8px" }}>{row.requestId}</td>
            <td style={{ padding: "12px 8px" }}>{row.email || row.customerId || "No subject supplied"}</td>
            <td style={{ padding: "12px 8px" }}>{row.status}</td>
            <td style={{ padding: "12px 8px" }}>{new Date(row.createdAt).toLocaleDateString("en-GB")}</td>
            <td style={{ padding: "12px 8px" }}>
              <Form method="post" reloadDocument>
                <input type="hidden" name="requestId" value={row.requestId}/>
                <button type="submit">Download private export</button>
              </Form>
            </td>
          </tr>)}</tbody>
        </table>}
    </s-section>
  </s-page>;
}

export const headers: HeadersFunction = (args) => {
  const headers = new Headers(boundary.headers(args));
  headers.set("Cache-Control", "no-store");
  return headers;
};
