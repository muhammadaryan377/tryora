import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { salesReport, type SalesReport } from "../attribution.server";

/**
 * TEMPORARY development helper (remove before launch): creates a test sofa with 25 colours on the
 * owner's test store so the many-swatch popup can be checked. Refuses to run on any other store.
 */
const TEST_STORE = "test-sofa-site.myshopify.com";

const COLOURS: [string, string][] = [
  ["Oat", "#d8c6ae"], ["Olive", "#6b6a2e"], ["Rust", "#b5532a"], ["Sand", "#cdb79a"], ["Stone", "#a59e93"],
  ["Ivory", "#ece4d6"], ["Chalk", "#e6e1d8"], ["Taupe", "#9c8a78"], ["Mink", "#8b7766"], ["Charcoal", "#4a4a4a"],
  ["Silver", "#b9bcbf"], ["Slate", "#6f7a83"], ["Pebble", "#a69e94"], ["Cocoa", "#6b4a3a"], ["Espresso", "#3e2b22"],
  ["Camel", "#b88a5a"], ["Mustard", "#c9962e"], ["Ochre", "#c08a3e"], ["Terracotta", "#c06a4a"], ["Blush", "#e0b2a8"],
  ["Rose", "#c9a39a"], ["Burgundy", "#7d2533"], ["Sage", "#9aa68a"], ["Forest", "#355e3b"], ["Navy", "#24345a"],
];
const SOLD_OUT = new Set(["Rust", "Rose"]);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (session.shop !== TEST_STORE) throw new Response("Not found", { status: 404 });
  return null;
};

export const action = async (args: ActionFunctionArgs) => {
  try {
    const form = await args.request.clone().formData();
    if (form.get("intent") === "sales") {
      const { admin, session } = await authenticate.admin(args.request);
      if (session.shop !== TEST_STORE) throw new Response("Not found", { status: 404 });
      return { ok: true as const, sales: await salesReport(admin, session.shop, true) };
    }
    return await seed(args);
  } catch (e: any) {
    if (e instanceof Response) throw e;
    const detail = e?.body?.errors?.graphQLErrors?.map((g: any) => g.message) ?? e?.body?.errors ?? e?.message ?? String(e);
    return { ok: false as const, errors: [typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 800)] };
  }
};

async function seed({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  if (session.shop !== TEST_STORE) throw new Response("Not found", { status: 404 });

  // Don't create a second copy.
  const existing: any = await (await admin.graphql(`#graphql
    query { products(first: 5, query: "title:\\"Form Sofa (Tryora test)\\"") { nodes { id handle title } } }`)).json();
  if (existing.data?.products?.nodes?.some((n: any) => n.title === "Form Sofa (Tryora test)")) {
    return { ok: false as const, errors: [`Test sofa already exists (${existing.data.products.nodes[0].handle}).`] };
  }

  // Reuse a photo already in the store as the product photo.
  const imgRes = await admin.graphql(`#graphql
    query { products(first: 20, query: "title:*sofa* OR product_type:*sofa*") { nodes { featuredMedia { preview { image { url } } } } }
            fallback: products(first: 1) { nodes { featuredMedia { preview { image { url } } } } } }`);
  const imgJson: any = await imgRes.json();
  const imageUrl =
    imgJson.data?.products?.nodes?.find((n: any) => n.featuredMedia)?.featuredMedia.preview.image.url ??
    imgJson.data?.fallback?.nodes?.[0]?.featuredMedia?.preview?.image?.url;

  const res = await admin.graphql(
    `#graphql
    mutation Seed($input: ProductSetInput!) {
      productSet(synchronous: true, input: $input) {
        product { id title handle media(first: 1) { nodes { id } } }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: {
          title: "Form Sofa (Tryora test)",
          productType: "Sofas",
          vendor: "Tryora test",
          status: "ACTIVE",
          tags: ["tryora-test"],
          descriptionHtml: "<p>Test product for checking Tryora's colour swatches. Safe to delete.</p>",
          productOptions: [
            { name: "Colour", values: COLOURS.map(([name]) => ({ name })) },
          ],
          files: imageUrl ? [{ originalSource: imageUrl, contentType: "IMAGE", alt: "Form Sofa" }] : [],
          variants: COLOURS.map(([name]) => ({
            optionValues: [{ optionName: "Colour", name }],
            price: "1299.00",
            inventoryPolicy: SOLD_OUT.has(name) ? "DENY" : "CONTINUE",
            inventoryItem: { tracked: SOLD_OUT.has(name) },
          })),
        },
      },
    },
  );
  const json: any = await res.json();
  const errors = json.errors?.map((e: any) => e.message) ?? json.data?.productSet?.userErrors?.map((e: any) => e.message) ?? [];
  const product = json.data?.productSet?.product;
  if (!product) return { ok: false as const, errors: errors.length ? errors : ["Unknown error"] };

  // Publish to the Online Store so it shows on the storefront.
  await admin.graphql(
    `#graphql
    mutation Pub($id: ID!) {
      publishablePublishToCurrentChannel(id: $id) { userErrors { message } }
    }`,
    { variables: { id: product.id } },
  ).catch(() => null);

  let mediaId: string | null = product.media?.nodes?.[0]?.id ?? null;
  for (let i = 0; !mediaId && i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const m: any = await (await admin.graphql(
      `#graphql
      query M($id: ID!) { product(id: $id) { media(first: 1) { nodes { id } } } }`,
      { variables: { id: product.id } },
    )).json();
    mediaId = m.data?.product?.media?.nodes?.[0]?.id ?? null;
  }

  await prisma.shop.upsert({ where: { id: session.shop }, create: { id: session.shop }, update: {} });
  await prisma.productPreviewConfig.upsert({
    where: { shopId_productId: { shopId: session.shop, productId: product.id } },
    create: {
      shopId: session.shop, productId: product.id, enabled: true, itemNoun: "sofa", placement: "replace", setting: "indoor",
      visualOptionName: "Colour", visualOptionType: "colour", referenceMediaId: mediaId,
      readiness: mediaId ? "ready" : "needs_attention", readinessReasons: mediaId ? [] : ["Choose a reference photo"], frozenContext: {},
    },
    update: { enabled: true, visualOptionName: "Colour", referenceMediaId: mediaId, readiness: mediaId ? "ready" : "needs_attention" },
  });
  return { ok: true as const, handle: product.handle as string, errors, mediaReady: !!mediaId };
}

export default function DevSeed() {
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  return (
    <s-page heading="Test product (development only)">
      {result?.ok && "sales" in result && (
        <s-banner tone="info" heading="Sales report (raw numbers)">
          <s-paragraph>{JSON.stringify(result.sales as SalesReport | null)}</s-paragraph>
        </s-banner>
      )}
      {result?.ok && "handle" in result && (
        <s-banner tone="success" heading="Test sofa created">
          <s-paragraph>
            Handle: {result.handle}. {result.mediaReady ? "Tryora is on for it." : "Photo still processing – set it up in Products."}
          </s-paragraph>
        </s-banner>
      )}
      {result && !result.ok && (
        <s-banner tone="critical" heading="Couldn't create it">
          <s-paragraph>{result.errors.join(" · ")}</s-paragraph>
        </s-banner>
      )}
      <s-section>
        <s-paragraph>Recalculates "Sales from Tryora" now and shows the raw numbers, even below the 3× / 3-order threshold.</s-paragraph>
        <Form method="post">
          <input type="hidden" name="intent" value="sales" />
          <s-button type="submit">Check sales report</s-button>
        </Form>
      </s-section>
      <s-section>
        <s-paragraph>Creates "Form Sofa (Tryora test)" with 25 colours (2 sold out) and turns Tryora on for it.</s-paragraph>
        <Form method="post">
          <s-button type="submit" variant="primary" loading={nav.state === "submitting" || undefined}>
            Create test sofa
          </s-button>
        </Form>
      </s-section>
    </s-page>
  );
}
