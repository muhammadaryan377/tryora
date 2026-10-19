import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Page() {
  return (
    <s-page heading="Leads & offers">
      <s-section>
        <s-paragraph>Email capture before the first preview, and the offer shown after the result.</s-paragraph>
        <s-paragraph>
          <s-text color="subdued">This screen is being built next.</s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
