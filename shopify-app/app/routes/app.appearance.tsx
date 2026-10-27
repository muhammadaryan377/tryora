import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopProduct, refreshPhotoColours } from "../products.server";
import {
  DEFAULT_WORDING,
  defaultLauncher,
  validateLauncher,
  type LauncherSettings,
  type TemplateName,
} from "../core/index";

const STYLES: { id: TemplateName; name: string; mood: string }[] = [
  { id: "gallery", name: "Gallery", mood: "Minimal and clean. Fits almost any store." },
  { id: "atelier", name: "Atelier", mood: "Luxury, editorial serif type." },
  { id: "noir", name: "Noir", mood: "Premium dark mode with a bright accent." },
  { id: "hearth", name: "Hearth", mood: "Warm, natural and friendly." },
  { id: "studio", name: "Studio", mood: "Bold type and clear choices." },
];

interface Tokens {
  accent: string | null; // null = the style's own accent
  useThemeFont: boolean;
}

async function load(shopId: string) {
  const row = await prisma.appearance.findFirst({ where: { shopId, scope: "store", scopeId: null } });
  const template = (row?.template as TemplateName) ?? "gallery";
  const tokens: Tokens = { accent: null, useThemeFont: true, ...((row?.tokens as object) ?? {}) };
  const launcher: LauncherSettings = { ...defaultLauncher(template), ...((row?.launchers as object) ?? {}) };
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  return { saved: !!row, template, tokens, launcher, swatchAutoFill: shop?.swatchAutoFill ?? false };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return load(session.shop);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shopId = session.shop;
  const f = await request.formData();
  const template = String(f.get("template")) as TemplateName;
  const base = defaultLauncher(template);
  const launcher: LauncherSettings = {
    ...base,
    mode: String(f.get("mode") ?? "tryora") as LauncherSettings["mode"],
    type: String(f.get("type") ?? "overlay") as LauncherSettings["type"],
    wording: String(f.get("wording") ?? DEFAULT_WORDING),
    showIcon: f.get("showIcon") === "on",
    showOnDesktop: f.get("showOnDesktop") === "on",
    showOnMobile: f.get("showOnMobile") === "on",
    position: String(f.get("position") ?? "bottom-right") as LauncherSettings["position"],
    background: f.get("useThemeButton") === "on" ? null : base.background,
    text: f.get("useThemeButton") === "on" ? null : base.text,
  };
  const errors = validateLauncher(launcher);
  if (errors.length) return { ok: false as const, errors };

  const accent = String(f.get("accent") ?? "");
  const tokens: Tokens = {
    accent: /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : null,
    useThemeFont: f.get("useThemeFont") === "on",
  };
  const swatchAutoFill = f.get("swatchAutoFill") === "on";
  const before = await prisma.shop.findUnique({ where: { id: shopId } });
  await prisma.shop.upsert({ where: { id: shopId }, create: { id: shopId, swatchAutoFill }, update: { swatchAutoFill } });
  if (swatchAutoFill && !before?.swatchAutoFill) {
    // Read variant-photo colours for live products now, so shoppers see swatches straight away.
    const configs = await prisma.productPreviewConfig.findMany({ where: { shopId, enabled: true }, take: 50 });
    for (const c of configs) {
      const product = await getShopProduct(admin, c.productId);
      if (!product) continue;
      const next = await refreshPhotoColours(product, c.visualOptionName, (c.photoColours as any) ?? {});
      if (next) await prisma.productPreviewConfig.update({ where: { id: c.id }, data: { photoColours: next as object } });
    }
  }
  const existing = await prisma.appearance.findFirst({ where: { shopId, scope: "store", scopeId: null } });
  const data = { template, tokens: tokens as object, launchers: launcher as object,
    copy: ((existing?.copy as object) ?? {}) };
  if (existing) await prisma.appearance.update({ where: { id: existing.id }, data });
  else await prisma.appearance.create({ data: { shopId, scope: "store", ...data } });
  return { ok: true as const, errors: [] as string[] };
};

export default function Appearance() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const [template, setTemplate] = useState<TemplateName>(d.template);
  const [mode, setMode] = useState(d.launcher.mode);
  const [type, setType] = useState(d.launcher.type);
  const [wording, setWording] = useState(d.launcher.wording);
  const [showIcon, setShowIcon] = useState(d.launcher.showIcon);
  const [desktop, setDesktop] = useState(d.launcher.showOnDesktop);
  const [mobile, setMobile] = useState(d.launcher.showOnMobile);
  const [position, setPosition] = useState(d.launcher.position);
  const [themeButton, setThemeButton] = useState(d.launcher.background === null);
  const [accent, setAccent] = useState(d.tokens.accent ?? "");
  const [themeFont, setThemeFont] = useState(d.tokens.useThemeFont);
  const [autoSwatch, setAutoSwatch] = useState(d.swatchAutoFill);
  const val = (e: any) => e.currentTarget.value as string;
  const checked = (e: any) => !!e.currentTarget.checked;
  const showVisullyButton = mode !== "own";

  return (
    <s-page heading="Appearance">
      <Form method="post">
        <input type="hidden" name="template" value={template} />
        <input type="hidden" name="mode" value={mode} />
        <input type="hidden" name="type" value={type} />
        <input type="hidden" name="wording" value={wording} />
        <input type="hidden" name="position" value={position} />
        <input type="hidden" name="accent" value={accent} />
        {showIcon && <input type="hidden" name="showIcon" value="on" />}
        {desktop && <input type="hidden" name="showOnDesktop" value="on" />}
        {mobile && <input type="hidden" name="showOnMobile" value="on" />}
        {themeButton && <input type="hidden" name="useThemeButton" value="on" />}
        {themeFont && <input type="hidden" name="useThemeFont" value="on" />}
        {autoSwatch && <input type="hidden" name="swatchAutoFill" value="on" />}

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

        <s-section heading="Popup style">
          <s-grid gridTemplateColumns="repeat(auto-fill, minmax(220px, 1fr))" gap="base">
            {STYLES.map((s) => (
              <s-clickable
                key={s.id}
                onClick={() => setTemplate(s.id)}
                border={template === s.id ? "large-100 strong solid" : "base"}
                borderRadius="base"
                padding="small"
                accessibilityLabel={`${s.name} style${template === s.id ? ", selected" : ""}`}
              >
                <s-stack gap="small-200">
                  <s-image src={`/styles/${s.id}.jpg`} alt={`${s.name} popup`} aspectRatio="16/9" objectFit="cover" borderRadius="base" />
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                    <s-heading>{s.name}</s-heading>
                    {template === s.id && <s-badge tone="success">Selected</s-badge>}
                  </s-stack>
                  <s-text color="subdued">{s.mood}</s-text>
                </s-stack>
              </s-clickable>
            ))}
          </s-grid>
        </s-section>

        <s-section heading="Brand">
          <s-switch
            label="Use my theme's fonts"
            checked={themeFont || undefined}
            onChange={(e: any) => setThemeFont(checked(e))}
            details="Off uses the style's own typeface."
          />
          <s-text-field
            label="Accent colour (optional)"
            placeholder="#2F4B3C"
            value={accent}
            onInput={(e: any) => setAccent(val(e))}
            details="Used for the main buttons. Leave empty to keep the style's colour."
          />
        </s-section>

        <s-section heading="Colour swatches">
          <s-switch
            label="Fill missing swatches automatically"
            checked={autoSwatch || undefined}
            onChange={(e: any) => setAutoSwatch(checked(e))}
            details="For colours with no swatch in Shopify, Visully uses the colour of that variant's photo, or guesses from the name (e.g. Navy, Oatmeal). Check them on each product and change any that look wrong. When off, those colours show as their name."
          />
        </s-section>

        <s-section heading="How shoppers open Visully">
          <s-select label="Launch method" value={mode} onChange={(e: any) => setMode(val(e) as typeof mode)}>
            <s-option value="tryora">Visully button</s-option>
            <s-option value="own">My own button only</s-option>
            <s-option value="both">Both</s-option>
          </s-select>

          {showVisullyButton && (
            <s-stack gap="base">
              <s-select label="Button type" value={type} onChange={(e: any) => setType(val(e) as typeof type)}>
                <s-option value="overlay">On the product image</s-option>
                <s-option value="floating">Floating button</s-option>
                <s-option value="inline">Under the colour options</s-option>
              </s-select>
              {type === "floating" && (
                <s-select label="Position" value={position} onChange={(e: any) => setPosition(val(e) as typeof position)}>
                  <s-option value="bottom-right">Bottom right</s-option>
                  <s-option value="bottom-left">Bottom left (use if a chat widget is bottom right)</s-option>
                </s-select>
              )}
              <s-text-field label="Button wording" value={wording} onInput={(e: any) => setWording(val(e))} maxLength={40} />
              <s-switch label="Show camera icon" checked={showIcon || undefined} onChange={(e: any) => setShowIcon(checked(e))} />
              <s-switch
                label="Use my theme's button colour"
                checked={themeButton || undefined}
                onChange={(e: any) => setThemeButton(checked(e))}
              />
              <s-stack direction="inline" gap="large">
                <s-switch label="Show on desktop" checked={desktop || undefined} onChange={(e: any) => setDesktop(checked(e))} />
                <s-switch label="Show on mobile" checked={mobile || undefined} onChange={(e: any) => setMobile(checked(e))} />
              </s-stack>
            </s-stack>
          )}

          {mode !== "tryora" && (
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-heading>Using your own button</s-heading>
              <s-paragraph>
                Link any button, image or text on your product page to <s-text type="strong">#tryora</s-text> and it will open
                Visully. For example, in your theme editor set a button's link to <s-text type="strong">#tryora</s-text>.
              </s-paragraph>
            </s-box>
          )}
        </s-section>

        <s-section>
          <s-button type="submit" variant="primary" loading={nav.state === "submitting" || undefined}>
            Save
          </s-button>
        </s-section>
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
