import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Page() {
  return (
    <s-page heading="Products">
      <s-section>
        <s-paragraph>Choose which products shoppers can preview and which option they can switch between.</s-paragraph>
        <s-paragraph>
          <s-text color="subdued">This screen is being built next.</s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
