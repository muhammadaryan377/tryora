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
  const url = new URL(request.url);
  const rawCursor = url.searchParams.get("before");
  const cursor = rawCursor && /^[a-zA-Z0-9_-]{1,100}$/.test(rawCursor) ? rawCursor : null;
  const [leadsTotal, leadsFailed, leadsPending, consentFailed, rows] = await Promise.all([
    prisma.leadDelivery.count({ where: { shopId, OR: [{ email: { not: null } }, { customerRef: { not: null } }] } }),
    prisma.leadDelivery.count({ where: { shopId, status: "failed", customerRef: null } }),
    prisma.leadDelivery.count({ where: { shopId, status: "queued" } }),
    prisma.leadDelivery.count({ where: { shopId, status: "failed", customerRef: { not: null } } }),
    prisma.leadDelivery.findMany({ where: { shopId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, email: true, firstName: true, marketingOptIn: true, customerRef: true,
        productId: true, optionValue: true, status: true, lastError: true, createdAt: true } }),
  ]);
  const leads = rows.slice(0, 50);
  url.searchParams.set("before", leads.at(-1)?.id ?? "");
  const olderUrl = rows.length > 50 ? `${url.pathname}${url.search}` : null;
  return {
    leadCapture: settings.leadCapture,
    leadTiming: (shop?.leadTiming ?? "before") as "before" | "after",
    lead,
    offer: { on: campaign?.mode === "offer" && campaign.active, code: campaign?.code ?? "", ...copy },
    leadsTotal, leadsFailed, leadsPending, consentFailed, leads, olderUrl,
    customersUrl: `https://${shopId}/admin/customers?query=${encodeURIComponent(`tag:"${lead.customerTag.replace(/["\\]/g, "")}"`)}`,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const f = await request.formData();
  const errors: string[] = [];

  const leadCapture = String(f.get("leadCapture")) as LeadCaptureMode;
  const leadTiming = f.get("leadTiming") === "after" ? "after" : "before";
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
  await prisma.shop.update({ where: { id: shopId }, data: { leadSettings: lead as object, leadTiming } });

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
  const [leadTiming, setLeadTiming] = useState<string>(d.leadTiming);
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
        <input type="hidden" name="leadTiming" value={leadTiming} />
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

        <s-section heading="Collect shoppers' emails">
          <s-switch label="Collect names and emails for previews" checked={leadCapture !== "off" || undefined}
            onChange={(e: any) => setLeadCapture(checked(e) ? "required" : "off")} />
          <s-select
            label="Ask shoppers for their email"
            value={leadCapture}
            onChange={(e: any) => setLeadCapture(val(e))}
            details="Asked once per visit. The image itself is never emailed."
          >
            <s-option value="required">Required</s-option>
            <s-option value="skippable">Optional (shoppers can skip)</s-option>
            <s-option value="off">Off – don't ask</s-option>
          </s-select>
          {leadCapture !== "off" && (
            <s-select
              label="When to ask"
              value={leadTiming}
              onChange={(e: any) => setLeadTiming(val(e))}
              details={
                leadTiming === "after"
                  ? "Shoppers see their first image straight away. The email is asked for on the result (to unlock your offer, if you have one) and before any further images."
                  : "Shoppers enter their email before their first image is made."
              }
            >
              <s-option value="before">Before the first image</s-option>
              <s-option value="after">After the first image</s-option>
            </s-select>
          )}

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

      <s-section heading="Captured leads">
        <s-paragraph>Names and emails submitted through your preview forms are saved here. Turning collection off stops new submissions; existing leads remain available.</s-paragraph>
        {d.leads.length === 0 ? <s-paragraph>No leads captured yet.</s-paragraph> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
              <thead><tr>{["Name", "Email", "Captured", "Marketing choice", "Shopify sync"].map(title => <th key={title} style={{ padding: "12px 8px", borderBottom: "1px solid #ddd" }}>{title}</th>)}</tr></thead>
              <tbody>{d.leads.map(lead => <tr key={lead.id}>
                <td style={{ padding: "12px 8px" }}>{lead.firstName || "Not provided"}</td>
                <td style={{ padding: "12px 8px" }}>{lead.email || "Email not retained (older record)"}</td>
                <td style={{ padding: "12px 8px", whiteSpace: "nowrap" }}>{new Date(lead.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC</td>
                <td style={{ padding: "12px 8px" }}>{lead.email ? lead.marketingOptIn ? "Opted in" : "Not opted in" : "See Shopify"}</td>
                <td style={{ padding: "12px 8px" }}>{lead.status === "accepted" ? "Synced" : lead.customerRef ? "Customer saved; consent not confirmed" : lead.status === "failed" ? lead.email ? "Sync failed; lead kept here" : "Failed; older contact unavailable" : "Not confirmed"}</td>
              </tr>)}</tbody>
            </table>
          </div>
        )}
        {d.olderUrl && <s-paragraph><a href={d.olderUrl}>Older leads</a></s-paragraph>}
      </s-section>
      <s-section slot="aside" heading="Emails captured">
        <s-heading>{d.leadsTotal}</s-heading>
        <s-paragraph>
          <s-text color="subdued">Saved leads, including repeat submissions. Customers synced to Shopify have the tag "{d.lead.customerTag}".</s-text>
        </s-paragraph>
        <s-paragraph><a href={d.customersUrl} target="_top">View customers in Shopify</a></s-paragraph>
        {d.leadsFailed > 0 && <s-paragraph>
          {d.leadsFailed} customer sync attempts failed. New submissions are still saved in the list above.
          Older failed submissions may have no email because contact details were not retained at that time.
        </s-paragraph>}
        {d.leadsPending > 0 && <s-paragraph>{d.leadsPending} customer sync attempts have not been confirmed by Shopify yet.</s-paragraph>}
        {d.consentFailed > 0 && <s-paragraph>
          {d.consentFailed} customers were saved, but their marketing consent could not be confirmed. Do not treat them as subscribed without checking Shopify.
        </s-paragraph>}
      </s-section>
      <s-section slot="aside" heading="Privacy">
        <s-paragraph>
          Tryora never stores shoppers' room photos or generated images. Submitted names, emails, product references and marketing choices are saved in Tryora for this store. Shopify customer sync is attempted separately. Marketing opt-in is never assumed from submitting a preview.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  const headers = new Headers(boundary.headers(headersArgs));
  headers.set("Cache-Control", "no-store");
  return headers;
};
