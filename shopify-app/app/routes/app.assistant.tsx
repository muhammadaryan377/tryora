import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  MAX_ASSISTANT_KNOWLEDGE,
  parseExclusionList,
  roomAssistantSettings,
  type RoomAssistantSettings,
} from "../room-assistant-settings";
import { assistantProviderReady } from "../room-assistant.server";
import { invalidateAssistantCatalogue } from "../assistant/catalogue.server";
import { invalidateAssistantKnowledge } from "../assistant/knowledge.server";
import type { Prisma } from "@prisma/client";

async function load(shopId: string) {
  const appearance = await prisma.appearance.findFirst({ where: { shopId, scope: "store", scopeId: null } });
  return { settings: roomAssistantSettings(appearance?.copy), providerReady: assistantProviderReady() };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return load(session.shop);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const settings: RoomAssistantSettings = {
    enabled: form.get("enabled") === "on",
    greeting: String(form.get("greeting") ?? "").trim(),
    launcherLabel: String(form.get("launcherLabel") ?? "").trim(),
    launcherPosition: form.get("launcherPosition") === "bottom-left" ? "bottom-left" : "bottom-right",
    launcherColour: String(form.get("launcherColour") ?? "").trim(),
    pages: {
      home: form.get("pageHome") === "on",
      product: form.get("pageProduct") === "on",
      collection: form.get("pageCollection") === "on",
      other: form.get("pageOther") === "on",
    },
    excludedProducts: parseExclusionList(form.get("excludedProducts")),
    excludedCollections: parseExclusionList(form.get("excludedCollections")),
    knowledge: String(form.get("knowledge") ?? "").trim(),
    defaultView: form.get("defaultView") === "fullscreen" ? "fullscreen" : "side",
  };
  const errors: string[] = [];
  if (!settings.greeting || settings.greeting.length > 120) errors.push("Greeting must be between 1 and 120 characters.");
  if (!settings.launcherLabel || settings.launcherLabel.length > 40) errors.push("Launcher label must be between 1 and 40 characters.");
  if (!/^#[0-9a-f]{6}$/i.test(settings.launcherColour)) errors.push("Launcher colour must be a six-digit hex colour.");
  if (settings.enabled && !Object.values(settings.pages).some(Boolean)) errors.push("Choose at least one page type, or turn the assistant off.");
  if (settings.knowledge.length > MAX_ASSISTANT_KNOWLEDGE) errors.push(`Store notes must be ${MAX_ASSISTANT_KNOWLEDGE} characters or fewer.`);
  if (errors.length) return { ok: false as const, errors };

  const existing = await prisma.appearance.findFirst({ where: { shopId: session.shop, scope: "store", scopeId: null } });
  const copy = { ...((existing?.copy as Record<string, unknown>) ?? {}), assistant: settings };
  if (existing) await prisma.appearance.update({ where: { id: existing.id }, data: { copy: copy as unknown as Prisma.InputJsonValue } });
  else await prisma.appearance.create({
    data: { shopId: session.shop, scope: "store", template: "gallery", tokens: {}, launchers: {}, copy: copy as unknown as Prisma.InputJsonValue },
  });
  // Shoppers see the new notes and a fresh catalogue on their next question.
  invalidateAssistantKnowledge(session.shop);
  invalidateAssistantCatalogue(session.shop);
  return { ok: true as const, errors: [] as string[] };
};

export default function AssistantSettings() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const [settings, setSettings] = useState(data.settings);
  const update = <K extends keyof RoomAssistantSettings>(key: K, value: RoomAssistantSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));
  const page = (key: keyof RoomAssistantSettings["pages"], value: boolean) =>
    setSettings((current) => ({ ...current, pages: { ...current.pages, [key]: value } }));
  const value = (event: any) => String(event.currentTarget.value ?? "");
  const checked = (event: any) => !!event.currentTarget.checked;

  return (
    <s-page heading="Room assistant">
      {!data.providerReady && (
        <s-banner tone="warning" heading="AI provider setup is incomplete">
          <s-paragraph>
            Add OPENAI_API_KEY and set OPENAI_ASSISTANT_PRIVACY_ACKNOWLEDGED=true after reviewing provider data controls.
            The assistant stays hidden until both are configured.
          </s-paragraph>
        </s-banner>
      )}
      {result?.ok && <s-banner tone="success" heading="Room assistant settings saved" />}
      {result && !result.ok && (
        <s-banner tone="critical" heading="Please fix the following">
          <s-unordered-list>{result.errors.map((error) => <s-list-item key={error}>{error}</s-list-item>)}</s-unordered-list>
        </s-banner>
      )}
      <Form method="post">
        {settings.enabled && <input type="hidden" name="enabled" value="on" />}
        {settings.pages.home && <input type="hidden" name="pageHome" value="on" />}
        {settings.pages.product && <input type="hidden" name="pageProduct" value="on" />}
        {settings.pages.collection && <input type="hidden" name="pageCollection" value="on" />}
        {settings.pages.other && <input type="hidden" name="pageOther" value="on" />}
        <input type="hidden" name="greeting" value={settings.greeting} />
        <input type="hidden" name="launcherLabel" value={settings.launcherLabel} />
        <input type="hidden" name="launcherPosition" value={settings.launcherPosition} />
        <input type="hidden" name="launcherColour" value={settings.launcherColour} />
        <input type="hidden" name="excludedProducts" value={settings.excludedProducts.join("\n")} />
        <input type="hidden" name="excludedCollections" value={settings.excludedCollections.join("\n")} />
        <input type="hidden" name="knowledge" value={settings.knowledge} />
        <input type="hidden" name="defaultView" value={settings.defaultView} />

        <s-section heading="Availability">
          <s-switch
            label="Enable the AI room assistant"
            checked={settings.enabled || undefined}
            onChange={(event: any) => update("enabled", checked(event))}
            details="Chat and recommendations do not consume preview credits. A credit is used only through the existing preview delivery flow."
          />
          <s-stack gap="base">
            <s-switch label="Product pages" checked={settings.pages.product || undefined} onChange={(event: any) => page("product", checked(event))} />
            <s-switch label="Collection pages" checked={settings.pages.collection || undefined} onChange={(event: any) => page("collection", checked(event))} />
            <s-switch label="Homepage" checked={settings.pages.home || undefined} onChange={(event: any) => page("home", checked(event))} />
            <s-switch label="Other pages" checked={settings.pages.other || undefined} onChange={(event: any) => page("other", checked(event))} />
          </s-stack>
        </s-section>

        <s-section heading="Explicit exclusions">
          <s-paragraph><s-text color="subdued">Exclusions always take precedence. Enter one Shopify handle or GID per line.</s-text></s-paragraph>
          <s-text-area
            label="Excluded products"
            value={settings.excludedProducts.join("\n")}
            rows={4}
            onInput={(event: any) => update("excludedProducts", parseExclusionList(value(event)))}
            details="Example: aria-bed"
          />
          <s-text-area
            label="Excluded collections"
            value={settings.excludedCollections.join("\n")}
            rows={4}
            onInput={(event: any) => update("excludedCollections", parseExclusionList(value(event)))}
            details="Example: clearance"
          />
        </s-section>

        <s-section heading="Store notes for the assistant">
          <s-paragraph>
            <s-text color="subdued">
              The assistant already reads your Shopify policies and published products. Add anything else shoppers
              ask about, such as delivery areas, lead times, showroom details or warranty terms. Only write what is
              true and current: the assistant quotes these notes to shoppers.
            </s-text>
          </s-paragraph>
          <s-text-area
            label="Store notes"
            value={settings.knowledge}
            rows={8}
            maxLength={MAX_ASSISTANT_KNOWLEDGE}
            onInput={(event: any) => update("knowledge", value(event))}
            details={`${settings.knowledge.length} of ${MAX_ASSISTANT_KNOWLEDGE} characters`}
          />
        </s-section>

        <s-section heading="Wording and launcher">
          <s-text-field label="Greeting" value={settings.greeting} maxLength={120} onInput={(event: any) => update("greeting", value(event))} />
          <s-text-field label="Launcher label" value={settings.launcherLabel} maxLength={40} onInput={(event: any) => update("launcherLabel", value(event))} />
          <s-select label="Launcher position" value={settings.launcherPosition} onChange={(event: any) => update("launcherPosition", value(event) === "bottom-left" ? "bottom-left" : "bottom-right")}>
            <s-option value="bottom-right">Bottom right</s-option>
            <s-option value="bottom-left">Bottom left</s-option>
          </s-select>
          <s-select label="Assistant opens as" value={settings.defaultView} onChange={(event: any) => update("defaultView", value(event) === "fullscreen" ? "fullscreen" : "side")}
            details="Shoppers can switch between the side panel and fullscreen at any time. Phones always use fullscreen.">
            <s-option value="side">Side panel (recommended)</s-option>
            <s-option value="fullscreen">Fullscreen</s-option>
          </s-select>
          <s-text-field label="Launcher colour" value={settings.launcherColour} onInput={(event: any) => update("launcherColour", value(event))} details="Six-digit hex colour, for example #6F7046." />
        </s-section>

        <s-section>
          <s-button type="submit" variant="primary" loading={navigation.state === "submitting" || undefined}>Save</s-button>
        </s-section>
      </Form>

      <s-section slot="aside" heading="Catalogue connection">
        <s-paragraph>
          See exactly which products the assistant can find in your store, and any Shopify errors.
        </s-paragraph>
        <s-link href="/app/assistant-diagnostics?q=bed">Check catalogue connection</s-link>
      </s-section>

      <s-section slot="aside" heading="Data and safety">
        <s-paragraph>
          Room photos are normalized in memory and sent to the configured AI provider for the active request. Visully
          does not write photos or chat messages to its database. The assistant can recommend any active product
          published to your Online Store, using live Shopify prices and availability. A recommendation offers an AI
          room preview only when that exact variant passes Visully's preview checks.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
