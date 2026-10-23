import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopProduct, productRows, refreshPhotoColours, saveProductConfig, swatchesFor } from "../products.server";
import type { Placement } from "../core/index";

const gid = (id: string) => `gid://shopify/Product/${id}`;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const product = await getShopProduct(admin, gid(params.id!));
  if (!product) throw new Response("Product not found", { status: 404 });
  // If the merchant approved auto-fill, read colours from any variant photos not seen before, and cache them.
  const shop = await prisma.shop.findUnique({ where: { id: session.shop } });
  const config = await prisma.productPreviewConfig.findUnique({
    where: { shopId_productId: { shopId: session.shop, productId: product.id } },
  });
  if (shop?.swatchAutoFill && config) {
    const next = await refreshPhotoColours(product, config.visualOptionName, (config.photoColours as any) ?? {});
    if (next) await prisma.productPreviewConfig.update({ where: { id: config.id }, data: { photoColours: next as object } });
  }
  const [row] = await productRows(session.shop, [product]);
  // What each colour would be without the merchant's own picks, so "Clear" can show the fallback.
  const fresh = await prisma.productPreviewConfig.findUnique({
    where: { shopId_productId: { shopId: session.shop, productId: product.id } },
  });
  const auto = Object.fromEntries(
    swatchesFor(product, row!.visualOptionName, {}, row!.swatchAutoFill, (fresh?.photoColours as any) ?? {}).map((s) => [s.value, s]),
  );
  return { row: row!, auto };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const product = await getShopProduct(admin, gid(params.id!));
  if (!product) throw new Response("Product not found", { status: 404 });
  const f = await request.formData();
  const option = String(f.get("visualOptionName") ?? "");
  await saveProductConfig(session.shop, product, {
    enabled: f.get("enabled") === "on",
    itemNoun: String(f.get("itemNoun") ?? ""),
    placement: String(f.get("placement") ?? "replace") as Placement,
    setting: String(f.get("setting") ?? "indoor") as "indoor" | "outdoor" | "either",
    visualOptionName: option && option !== "__none" ? option : null,
    referenceMediaId: String(f.get("referenceMediaId") ?? "") || null,
    swatchColours: parseColours(String(f.get("swatchColours") ?? "{}")),
  });
  return redirect("/app/products");
};

function parseColours(raw: string): Record<string, string> {
  try {
    const obj = JSON.parse(raw);
    return Object.fromEntries(
      Object.entries(obj).filter(([k, v]) => typeof k === "string" && typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

const SOURCE_LABEL = {
  shopify: "From Shopify",
  merchant: "Set in Tryora",
  photo: "From variant photo",
  guess: "Guessed from name",
  missing: "Shows as name",
} as const;

const PLACEMENTS: { value: Placement; label: string }[] = [
  { value: "replace", label: "Replace an item in the room (sofa, bed, chair, table)" },
  { value: "place", label: "Place into an empty space" },
  { value: "floor_cover", label: "Cover a floor area (rug, flooring)" },
  { value: "wall_cover", label: "Cover a wall (wallpaper, paint, panelling)" },
  { value: "wall_hang", label: "Hang on a wall (art, mirror)" },
  { value: "light", label: "Light fitting (pendant, lamp)" },
];

export default function ProductSetup() {
  const { row, auto } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const [reference, setReference] = useState(row.referenceMediaId ?? "");
  const [noun, setNoun] = useState(row.itemNoun);
  const [enabled, setEnabled] = useState(row.enabled);
  const [placement, setPlacement] = useState<string>(row.placement);
  const [setting, setSetting] = useState<string>(row.setting);
  const [option, setOption] = useState<string>(row.visualOptionName ?? "__none");
  const [colours, setColours] = useState<Record<string, string>>(row.swatchColours);
  const val = (e: any) => e.currentTarget.value as string;
  // Swatches only matter for the option chosen when the page loaded; after changing option, save to see them.
  const swatches =
    option === row.visualOptionName
      ? row.resolvedSwatches.map((s) => {
          const base = auto[s.value] ?? s;
          if (base.source !== "shopify" && colours[s.value]) return { ...base, colour: colours[s.value]!, source: "merchant" as const };
          return base;
        })
      : [];
  const needsColours = swatches.some((s) => s.source !== "shopify");
  const missing = swatches.filter((s) => s.source === "missing").length;

  return (
    <s-page heading={row.title}>
      <s-link slot="breadcrumb-actions" href="/app/products">Products</s-link>
      <s-section heading="Customization provider"><s-paragraph>Native options are the default. Configure a reviewed product-specific mapping or inspect provider compatibility without changing this product’s enabled setting.</s-paragraph><s-link href={`/app/customization?product=${encodeURIComponent(row.id)}`}>Provider settings and native data</s-link></s-section>
      {row.previewOptionStatus.warning && (
        <s-section heading="Preview mapping needs review">
          <s-paragraph>{row.previewOptionStatus.warning}</s-paragraph>
        </s-section>
      )}
      <Form method="post">
        {/* Values are mirrored into plain inputs so the form posts reliably. */}
        {enabled && <input type="hidden" name="enabled" value="on" />}
        <input type="hidden" name="itemNoun" value={noun} />
        <input type="hidden" name="placement" value={placement} />
        <input type="hidden" name="setting" value={setting} />
        <input type="hidden" name="visualOptionName" value={option} />
        <input type="hidden" name="swatchColours" value={JSON.stringify(colours)} />
        <s-section heading="Show this product in Tryora">
          <s-switch
            label="Let shoppers see this product in their room"
            checked={enabled || undefined}
            onChange={(e: any) => setEnabled(!!e.currentTarget.checked)}
            details="It only goes live once a reference photo is chosen."
          />
        </s-section>

        <s-section heading="What shoppers see">
          <s-text-field
            label="What is this product called?"
            value={noun}
            onInput={(e: any) => setNoun(e.currentTarget.value)}
            details={`Used in the popup: "See this ${noun || "item"} in your room".`}
          />
          <s-select label="How it goes into the room" value={placement} onChange={(e: any) => setPlacement(val(e))}>
            {PLACEMENTS.map((p) => (
              <s-option key={p.value} value={p.value}>{p.label}</s-option>
            ))}
          </s-select>
          <s-select label="Where it's used" value={setting} onChange={(e: any) => setSetting(val(e))} details="Shoppers are asked for a photo of the matching kind of space.">
            <s-option value="indoor">Indoors</s-option>
            <s-option value="outdoor">Outdoors (garden, patio, terrace)</s-option>
            <s-option value="either">Either</s-option>
          </s-select>
          <s-select
            label="Option shoppers can switch between"
            value={option}
            onChange={(e: any) => setOption(val(e))}
            details="Usually colour or fabric. Other options, like size, stay fixed."
          >
            <s-option value="__none">No selector – use product reference</s-option>
            {row.previewOptionStatus.state === "stale" && (
              <s-option value={row.visualOptionName!}>Unavailable saved option: {row.visualOptionName}</s-option>
            )}
            {row.options.map((o) => (
              <s-option key={o.name} value={o.name}>
                {o.name} ({o.values.length} choices)
              </s-option>
            ))}
          </s-select>
        </s-section>

        {needsColours && (
          <s-section heading="Colour swatches">
            {missing > 0 ? (
              <s-banner tone="warning" heading={`${missing} colour${missing === 1 ? " shows" : "s show"} as a name in the popup`}>
                <s-paragraph>
                  Shoppers find it easier to choose from colour swatches. Add swatches in Shopify (product options), pick
                  colours below
                  {row.swatchAutoFill ? "." : ", or turn on automatic swatches in Appearance."}
                </s-paragraph>
              </s-banner>
            ) : null}
            <s-paragraph>
              <s-text color="subdued">
                {row.swatchAutoFill
                  ? "Automatic swatches are on: colours with no swatch use their variant photo, or a guess from the colour name. Check them below and change any that look wrong."
                  : "Automatic swatches are off for your store. You can turn them on in Appearance."}
              </s-text>
            </s-paragraph>
            <s-stack gap="small-200">
              {swatches.map((s) => (
                <s-stack key={s.value} direction="inline" gap="base" alignItems="center">
                  <span
                    aria-hidden="true"
                    style={{
                      width: 28, height: 28, borderRadius: 6, border: "1px solid #ccc", flex: "none",
                      background: s.image ? `center / cover url(${s.image})` : (s.colour ?? "repeating-linear-gradient(45deg,#eee 0 4px,#fff 4px 8px)"),
                    }}
                  />
                  <s-text>{s.value}</s-text>
                  <s-badge tone={s.source === "missing" ? "warning" : s.source === "guess" ? "info" : "neutral"}>
                    {SOURCE_LABEL[s.source]}
                  </s-badge>
                  {s.source !== "shopify" && (
                    <input
                      type="color"
                      aria-label={`Swatch colour for ${s.value}`}
                      value={colours[s.value] ?? s.colour ?? "#cccccc"}
                      onChange={(e) => setColours({ ...colours, [s.value]: e.currentTarget.value })}
                      style={{ width: 36, height: 28, padding: 0, border: "none", background: "none", cursor: "pointer" }}
                    />
                  )}
                  {colours[s.value] && (
                    <s-button
                      variant="tertiary"
                      onClick={() => {
                        const { [s.value]: _, ...rest } = colours;
                        setColours(rest);
                      }}
                    >
                      Clear
                    </s-button>
                  )}
                </s-stack>
              ))}
            </s-stack>
          </s-section>
        )}

        <s-section heading="Reference photo">
          <s-paragraph>
            <s-text color="subdued">
              Pick the clearest photo of the whole product, ideally straight on against a plain background. The AI uses
              it to get the shape and details right.
            </s-text>
          </s-paragraph>
          <input type="hidden" name="referenceMediaId" value={reference} />
          {row.media.length === 0 ? (
            <s-banner tone="warning" heading="This product has no photos">
              <s-paragraph>Add photos to the product in Shopify first.</s-paragraph>
            </s-banner>
          ) : (
            <s-grid gridTemplateColumns="repeat(auto-fill, minmax(120px, 1fr))" gap="base">
              {row.media.map((m) => (
                <s-clickable
                  key={m.id}
                  onClick={() => setReference(m.id)}
                  border={reference === m.id ? "large-100 base solid" : "base"}
                  borderRadius="base"
                  padding="small"
                  accessibilityLabel={reference === m.id ? "Selected reference photo" : "Use this photo"}
                >
                  <s-image src={m.url} alt={m.alt ?? row.title} aspectRatio="1/1" objectFit="cover" />
                  {reference === m.id && <s-badge tone="success">Reference</s-badge>}
                </s-clickable>
              ))}
            </s-grid>
          )}
        </s-section>

        <s-section>
          <s-stack direction="inline" gap="base">
            <s-button type="submit" variant="primary" loading={nav.state === "submitting" || undefined}>
              Save
            </s-button>
            <s-button href="/app/products">Cancel</s-button>
          </s-stack>
        </s-section>
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
