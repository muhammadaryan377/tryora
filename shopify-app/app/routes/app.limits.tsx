import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { tryora } from "../tryora.server";
import type { QuotaPolicy } from "../core/index";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const s = await tryora.ensureSettings(session.shop);
  const w = s.quota.window;
  return {
    enabled: s.quota.enabled,
    perProduct: s.quota.perProduct ?? null,
    storeWide: s.quota.storeWide ?? null,
    windowHours: w.type === "rolling" ? w.hours : null,
    resetAt: w.type === "manual" ? new Date(w.resetEpoch).toISOString() : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const f = await request.formData();
  const s = await tryora.ensureSettings(session.shop);
  const num = (k: string) => {
    const v = String(f.get(k) ?? "").trim();
    if (!v) return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : NaN;
  };

  if (f.get("intent") === "reset") {
    // Starts a fresh allowance for every shopper from now.
    await tryora.updateSettings({ ...s, quota: { ...s.quota, window: { type: "manual", resetEpoch: new Date() } } });
    return { ok: true as const, message: "All shopper allowances have been reset.", errors: [] as string[] };
  }

  const enabled = f.get("enabled") === "on";
  const perProduct = num("perProduct");
  const storeWide = num("storeWide");
  const windowChoice = String(f.get("window") ?? "24");
  const errors: string[] = [];
  if (Number.isNaN(perProduct) || Number.isNaN(storeWide)) errors.push("Limits must be whole numbers above zero.");
  if (enabled && perProduct === undefined && storeWide === undefined) errors.push("Set at least one limit, or turn limits off.");
  if (errors.length) return { ok: false as const, message: "", errors };

  const window: QuotaPolicy["window"] =
    windowChoice === "manual"
      ? { type: "manual", resetEpoch: s.quota.window.type === "manual" ? s.quota.window.resetEpoch : new Date() }
      : { type: "rolling", hours: Number(windowChoice) };
  await tryora.updateSettings({ ...s, quota: { enabled, perProduct, storeWide, window } });
  return { ok: true as const, message: "Saved.", errors: [] as string[] };
};

export default function Limits() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const [enabled, setEnabled] = useState(d.enabled);
  const [perProduct, setPerProduct] = useState(d.perProduct?.toString() ?? "");
  const [storeWide, setStoreWide] = useState(d.storeWide?.toString() ?? "");
  const [windowChoice, setWindowChoice] = useState(d.resetAt ? "manual" : String(d.windowHours ?? 24));
  const val = (e: any) => e.currentTarget.value as string;

  return (
    <s-page heading="Shopper limits">
      {result?.ok && <s-banner tone="success" heading={result.message} />}
      {result && !result.ok && (
        <s-banner tone="critical" heading="Please fix the following">
          <s-unordered-list>
            {result.errors.map((e) => (
              <s-list-item key={e}>{e}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}
      <Form method="post">
        {enabled && <input type="hidden" name="enabled" value="on" />}
        <input type="hidden" name="perProduct" value={perProduct} />
        <input type="hidden" name="storeWide" value={storeWide} />
        <input type="hidden" name="window" value={windowChoice} />

        <s-section heading="Limit previews per shopper">
          <s-paragraph>
            <s-text color="subdued">
              On by default: each shopper can make 10 previews a day across your store. We recommend 10 – enough to
              try several colours – but you can change it or turn it off. Shoppers are recognised by their browser, and
              by their account if they're signed in.
            </s-text>
          </s-paragraph>
          <s-switch label="Limit previews per shopper" checked={enabled || undefined} onChange={(e: any) => setEnabled(!!e.currentTarget.checked)} />
          {enabled && (
            <s-stack gap="base">
              <s-number-field
                label="Previews per product"
                value={perProduct}
                min={1}
                onInput={(e: any) => setPerProduct(val(e))}
                details="Across all colours of the same product. Leave empty for no per-product limit."
              />
              <s-number-field
                label="Previews across the whole store"
                value={storeWide}
                min={1}
                onInput={(e: any) => setStoreWide(val(e))}
                details="Leave empty for no store-wide limit."
              />
              <s-select label="Allowance resets" value={windowChoice} onChange={(e: any) => setWindowChoice(val(e))}>
                <s-option value="24">Every 24 hours</s-option>
                <s-option value="168">Every 7 days</s-option>
                <s-option value="720">Every 30 days</s-option>
                <s-option value="manual">Only when I reset it</s-option>
              </s-select>
            </s-stack>
          )}
        </s-section>
        <s-section>
          <s-button type="submit" variant="primary" loading={nav.state === "submitting" || undefined}>
            Save
          </s-button>
        </s-section>
      </Form>

      {d.resetAt && (
        <s-section heading="Reset now">
          <s-paragraph>Last reset: {new Date(d.resetAt).toLocaleString("en-GB")}</s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="reset" />
            <s-button type="submit">Reset all shopper allowances</s-button>
          </Form>
        </s-section>
      )}

      <s-section slot="aside" heading="What shoppers see">
        <s-paragraph>
          When a shopper reaches the limit, the popup tells them politely and keeps any images they've already made
          on screen. No credit is used for a blocked attempt.
        </s-paragraph>
      </s-section>
      <s-section slot="aside" heading="Bot protection">
        <s-paragraph>
          Always on. If your store suddenly gets far more previews than a real shopper could make (more than 40 in 10
          minutes), new ones pause for a few minutes and you'll see a warning on your Visully Home page.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
