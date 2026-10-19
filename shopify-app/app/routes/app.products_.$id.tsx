import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getShopProduct, productRows, saveProductConfig } from "../products.server";
import type { Placement } from "../core/index";
// Imported directly (not via core/index) so no server-only code reaches the browser.
import { resolveSwatches } from "../core/colourGuess";

const gid = (id: string) => `gid://shopify/Product/${id}`;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const product = await getShopProduct(admin, gid(params.id!));
  if (!product) throw new Response("Product not found", { status: 404 });
  const [row] = await productRows(session.shop, [product]);
  return { row: row! };
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
    swatchGuessApproved: f.get("swatchGuessApproved") === "on",
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

const SOURCE_LABEL = { shopify: "From Shopify", merchant: "Set in Tryora", guess: "Guessed from name", missing: "Needs a colour" };

const PLACEMENTS: { value: Placement; label: string }[] = [
  { value: "replace", label: "Replace an item in the room (sofa, bed, chair, table)" },
  { value: "place", label: "Place into an empty space" },
  { value: "floor_cover", label: "Cover a floor area (rug, flooring)" },
  { value: "wall_cover", label: "Cover a wall (wallpaper, paint, panelling)" },
  { value: "wall_hang", label: "Hang on a wall (art, mirror)" },
  { value: "light", label: "Light fitting (pendant, lamp)" },
];

export default function ProductSetup() {
  const { row } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const [reference, setReference] = useState(row.referenceMediaId ?? "");
  const [noun, setNoun] = useState(row.itemNoun);
  const [enabled, setEnabled] = useState(row.enabled);
  const [placement, setPlacement] = useState<string>(row.placement);
  const [setting, setSetting] = useState<string>(row.setting);
  const [option, setOption] = useState<string>(row.visualOptionName ?? "__none");
  const [colours, setColours] = useState<Record<string, string>>(row.swatchColours);
  const [guess, setGuess] = useState(row.swatchGuessApproved);
  const val = (e: any) => e.currentTarget.value as string;
  const chosen = row.options.find((o) => o.name === option);
  const swatches = chosen
    ? resolveSwatches(
        chosen.swatches.map((s) => ({ value: s.value, shopifyColour: s.colour, shopifyImage: s.image })),
        colours,
        guess,
      )
    : [];
  const needsColours = swatches.some((s) => s.source !== "shopify");
  const missing = swatches.filter((s) => s.source === "missing").length;

  return (
    <s-page heading={row.title}>
      <s-link slot="breadcrumb-actions" href="/app/products">Products</s-link>
      <Form method="post">
        {/* Values are mirrored into plain inputs so the form posts reliably. */}
        {enabled && <input type="hidden" name="enabled" value="on" />}
        <input type="hidden" name="itemNoun" value={noun} />
        <input type="hidden" name="placement" value={placement} />
        <input type="hidden" name="setting" value={setting} />
        <input type="hidden" name="visualOptionName" value={option} />
        <input type="hidden" name="swatchColours" value={JSON.stringify(colours)} />
        {guess && <input type="hidden" name="swatchGuessApproved" value="on" />}
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
            <s-option value="__none">None – single style</s-option>
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
              <s-banner tone="warning" heading={`${missing} colour${missing === 1 ? " has" : "s have"} no swatch`}>
                <s-paragraph>
                  Shoppers pick colours from swatches in the popup. Set these in Shopify (product options), pick them
                  below, or let Tryora guess from the colour names. The product won't go live until every colour has one.
                </s-paragraph>
              </s-banner>
            ) : null}
            <s-checkbox
              label="Guess swatch colours from the colour names (e.g. Red, Navy, Oatmeal)"
              checked={guess || undefined}
              onChange={(e: any) => setGuess(!!e.currentTarget.checked)}
              details="Only used for colours with no swatch in Shopify or below. Guesses may not match your fabric exactly – check them here."
            />
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
