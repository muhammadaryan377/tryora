import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Page() {
  return (
    <s-page heading="Shopper limits">
      <s-section>
        <s-paragraph>Optional limits on how many previews each shopper can create.</s-paragraph>
        <s-paragraph>
          <s-text color="subdued">This screen is being built next.</s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
