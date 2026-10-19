import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Page() {
  return (
    <s-page heading="Appearance">
      <s-section>
        <s-paragraph>Pick one of the five popup styles, your brand colours and how shoppers open Tryora.</s-paragraph>
        <s-paragraph>
          <s-text color="subdued">This screen is being built next.</s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
