import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

// Shopify may launch the app root without a shop query parameter. Always enter
// the authenticated app shell, preserving the embedded launch/auth context.
export const loader = ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  throw redirect(`/app${url.search}`);
};

export default function AppEntry() {
  return null;
}
