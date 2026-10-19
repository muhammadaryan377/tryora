import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getShopProduct, productRows, saveProductConfig } from "../products.server";
import type { Placement } from "../core/index";

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
  });
  return redirect("/app/products");
};

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
  const val = (e: any) => e.currentTarget.value as string;

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
