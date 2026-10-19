import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { tryora } from "../tryora.server";
import type { LeadCaptureMode } from "../core/index";

interface LeadSettings {
  showOptIn: boolean;
  optInWording: string;
  customerTag: string;
}

interface OfferCopy {
  headline: string;
  details: string;
}

const defaultOptIn = (shopName: string) =>
  `Email me offers and updates from ${shopName}. I can unsubscribe at any time.`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const settings = await tryora.ensureSettings(shopId);
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  const shopName = shopId.replace(".myshopify.com", "").replace(/-/g, " ");
  const lead: LeadSettings = {
    showOptIn: true,
    optInWording: defaultOptIn(shopName),
    customerTag: "tryora-lead",
    ...((shop?.leadSettings as object) ?? {}),
  };
  const campaign = await prisma.campaign.findFirst({ where: { shopId }, orderBy: { updatedAt: "desc" } });
  const copy: OfferCopy = { headline: "15% off this {item}", details: "This {item} only. Cannot be combined.", ...((campaign?.copy as object) ?? {}) };
  const leadsTotal = await prisma.leadDelivery.count({ where: { shopId } });
  return {
    leadCapture: settings.leadCapture,
    lead,
    offer: { on: campaign?.mode === "offer" && campaign.active, code: campaign?.code ?? "", ...copy },
    leadsTotal,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const f = await request.formData();
  const errors: string[] = [];

  const leadCapture = String(f.get("leadCapture")) as LeadCaptureMode;
  const lead: LeadSettings = {
    showOptIn: f.get("showOptIn") === "on",
    optInWording: String(f.get("optInWording") ?? "").trim(),
    customerTag: String(f.get("customerTag") ?? "").trim() || "tryora-lead",
  };
  if (lead.showOptIn && !lead.optInWording) errors.push("Add the wording for the marketing checkbox.");

  const offerOn = f.get("offerOn") === "on";
  const code = String(f.get("code") ?? "").trim().toUpperCase();
  const copy: OfferCopy = {
    headline: String(f.get("headline") ?? "").trim(),
    details: String(f.get("details") ?? "").trim(),
  };
  if (offerOn && !code) errors.push("Add the discount code shoppers should use.");
  if (offerOn && !copy.headline) errors.push("Add a headline for the offer.");
  if (errors.length) return { ok: false as const, errors };

  const settings = await tryora.ensureSettings(shopId);
  await tryora.updateSettings({ ...settings, leadCapture });
  await prisma.shop.update({ where: { id: shopId }, data: { leadSettings: lead as object } });

  const existing = await prisma.campaign.findFirst({ where: { shopId }, orderBy: { updatedAt: "desc" } });
  const data = { mode: offerOn ? "offer" : "off", code: code || null, copy: copy as object, active: offerOn };
  if (existing) await prisma.campaign.update({ where: { id: existing.id }, data });
  else await prisma.campaign.create({ data: { shopId, ...data } });
  return { ok: true as const, errors: [] as string[] };
};

export default function Leads() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const [leadCapture, setLeadCapture] = useState<string>(d.leadCapture);
  const [showOptIn, setShowOptIn] = useState(d.lead.showOptIn);
  const [optInWording, setOptInWording] = useState(d.lead.optInWording);
  const [customerTag, setCustomerTag] = useState(d.lead.customerTag);
  const [offerOn, setOfferOn] = useState(d.offer.on);
  const [code, setCode] = useState(d.offer.code);
  const [headline, setHeadline] = useState(d.offer.headline);
  const [details, setDetails] = useState(d.offer.details);
  const val = (e: any) => e.currentTarget.value as string;
  const checked = (e: any) => !!e.currentTarget.checked;

  return (
    <s-page heading="Leads & offers">
      <Form method="post">
        <input type="hidden" name="leadCapture" value={leadCapture} />
        {showOptIn && <input type="hidden" name="showOptIn" value="on" />}
        <input type="hidden" name="optInWording" value={optInWording} />
        <input type="hidden" name="customerTag" value={customerTag} />
        {offerOn && <input type="hidden" name="offerOn" value="on" />}
        <input type="hidden" name="code" value={code} />
        <input type="hidden" name="headline" value={headline} />
        <input type="hidden" name="details" value={details} />

        {result?.ok && (
          <s-banner tone="success" heading="Saved">
            <s-paragraph>Your shoppers will see these changes straight away.</s-paragraph>
          </s-banner>
        )}
        {result && !result.ok && (
          <s-banner tone="critical" heading="Please fix the following">
            <s-unordered-list>
              {result.errors.map((e) => (
                <s-list-item key={e}>{e}</s-list-item>
              ))}
            </s-unordered-list>
          </s-banner>
        )}

        <s-section heading="Email before the first preview">
          <s-select
            label="Ask shoppers for their email"
            value={leadCapture}
            onChange={(e: any) => setLeadCapture(val(e))}
            details="Asked once per visit, just before their first image is made. The image itself is never emailed."
          >
            <s-option value="required">Required</s-option>
            <s-option value="skippable">Optional (shoppers can skip)</s-option>
            <s-option value="off">Off</s-option>
          </s-select>

          {leadCapture !== "off" && (
            <s-stack gap="base">
              <s-switch
                label="Show a marketing opt-in checkbox"
                checked={showOptIn || undefined}
                onChange={(e: any) => setShowOptIn(checked(e))}
                details="Always unticked. Shoppers who don't tick it are saved without marketing consent."
              />
              {showOptIn && (
                <s-text-field label="Checkbox wording" value={optInWording} onInput={(e: any) => setOptInWording(val(e))} />
              )}
              <s-text-field
                label="Tag for new customers"
                value={customerTag}
                onInput={(e: any) => setCustomerTag(val(e))}
                details="Emails are saved as customers in Shopify with this tag, so you can find and segment them."
              />
            </s-stack>
          )}
        </s-section>

        <s-section heading="Offer after the preview">
          <s-switch
            label="Show an offer card after the shopper sees their room"
            checked={offerOn || undefined}
            onChange={(e: any) => setOfferOn(checked(e))}
          />
          {offerOn && (
            <s-stack gap="base">
              <s-text-field
                label="Discount code"
                value={code}
                onInput={(e: any) => setCode(val(e))}
                details="Use a code you've already created in Shopify Discounts. Shoppers can copy it or apply it in one click."
              />
              <s-text-field
                label="Headline"
                value={headline}
                onInput={(e: any) => setHeadline(val(e))}
                details="{item} becomes the product word, e.g. 'sofa'."
              />
              <s-text-field label="Small print" value={details} onInput={(e: any) => setDetails(val(e))} />
            </s-stack>
          )}
        </s-section>

        <s-section>
          <s-button type="submit" variant="primary" loading={nav.state === "submitting" || undefined}>
            Save
          </s-button>
        </s-section>
      </Form>

      <s-section slot="aside" heading="Emails captured">
        <s-heading>{d.leadsTotal}</s-heading>
        <s-paragraph>
          <s-text color="subdued">All time. Find them in Customers with the tag "{d.lead.customerTag}".</s-text>
        </s-paragraph>
      </s-section>
      <s-section slot="aside" heading="Privacy">
        <s-paragraph>
          Tryora never stores shoppers' room photos or generated images. Only the email, the product and colour they
          looked at, and their marketing choice are saved to your Shopify customers.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
