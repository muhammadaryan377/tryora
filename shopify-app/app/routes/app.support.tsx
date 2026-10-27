import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { sendSupportMessage } from "../support.server";
import styles from "../styles/billing.module.css";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  return { email: session.onlineAccessInfo?.associated_user?.email ?? "" };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const message = String(form.get("message") ?? "").trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\r\n]/.test(email)) {
    return data({ ok: false, message: "Enter a valid email address so we can reply." }, { status: 400 });
  }
  if (!message || message.length > 5000) {
    return data({ ok: false, message: "Enter a message between 1 and 5,000 characters." }, { status: 400 });
  }
  try {
    await sendSupportMessage({ shop: session.shop, email, message });
    return data({ ok: true, message: "Your message has been sent. Our support team will reply by email." });
  } catch {
    return data({ ok: false, message: "We couldn't send your message. Please try again later or email support@visully.io directly." }, { status: 503 });
  }
}

export default function Support() {
  const { email } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  return (
    <s-page heading="Contact support">
      <section className={styles.information}>
        <h2>How can we help?</h2>
        <p>Send us a message and the Tryora team will get back to you by email.</p>
        {result && <p role={result.ok ? "status" : "alert"}>{result.message}</p>}
        {!result?.ok && (
          <Form method="post" className={styles.supportForm}>
            <label htmlFor="support-email">Your email</label>
            <input id="support-email" name="email" type="email" autoComplete="email" defaultValue={email} required maxLength={254} />
            <label htmlFor="support-message">Message</label>
            <textarea id="support-message" name="message" placeholder="Tell us what you need help with..." required maxLength={5000} rows={7} />
            <button type="submit" disabled={submitting}>{submitting ? "Sending..." : "Submit"}</button>
          </Form>
        )}
      </section>
    </s-page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
