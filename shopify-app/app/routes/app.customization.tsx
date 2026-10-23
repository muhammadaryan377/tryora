import { randomUUID } from "node:crypto";
import { useEffect, useState } from "react";
import { Form, redirect, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopProduct } from "../products.server";
import { providerSettingsEnabled, effectiveSetting } from "../customization/provider-config.server";
import { STORE_DEFAULT, PROVIDERS, PROVIDER_LABELS, isProviderId } from "../customization/provider-catalog";
import { providerDiagnostic } from "../customization/registry.server";
import { nativeSnapshot } from "../customization/reference-resolver.server";
import { parseManualMapping, validateNativeBindings } from "../customization/option-model";

async function scopeFor(request: Request, admin: Parameters<typeof getShopProduct>[0]) {
  const raw = new URL(request.url).searchParams.get("product");
  if (!raw) return STORE_DEFAULT;
  const productId = /^\d+$/.test(raw) ? `gid://shopify/Product/${raw}` : raw;
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId) || !(await getShopProduct(admin, productId))) throw new Response("Product not found", { status: 404 });
  return productId;
}

/** Bounded streamed form reads; do not buffer unbounded merchant JSON. */
async function boundedForm(request: Request) {
  if (!(request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) throw new Response("Unsupported form encoding", { status: 415 });
  const reader = request.body?.getReader();
  if (!reader) throw new Response("Missing form", { status: 400 });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > 1_600_000) throw new Response("Mapping too large", { status: 413 });
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const productId = await scopeFor(request, admin);
  const enabled = providerSettingsEnabled();
  const rows = enabled ? await prisma.customizationConfig.findMany({ where: { shopId: session.shop, productId: { in: [STORE_DEFAULT, productId] } } }) : [];
  const saved = rows.find((r) => r.productId === productId);
  const effective = effectiveSetting(session.shop, productId, rows);
  let catalog: unknown = null;
  let coverage: { mapped: number; total: number; available: number; unmapped: number } | null = null;
  let diagnostic = providerDiagnostic(effective.providerId, effective.active).status;
  if (enabled && productId !== STORE_DEFAULT) {
    try {
      const snapshot = await nativeSnapshot(admin, productId);
      catalog = { shopId: session.shop, productId, options: snapshot.product.options, variants: snapshot.variants, media: snapshot.media };
      if ((effective.providerId === "manual_mapping" || effective.providerId === "cloudlift")) {
        const mapping = parseManualMapping(effective.mapping, session.shop, productId);
        const errors = validateNativeBindings(mapping, snapshot.variants, snapshot.media);
        const boundIds = new Set(mapping.entries.map((e) => e.variantId));
        coverage = { mapped: mapping.entries.length, total: snapshot.variants.length, available: snapshot.variants.filter((v) => v.availableForSale).length,
          unmapped: snapshot.variants.filter((v) => !boundIds.has(v.id)).length };
        diagnostic = errors.length ? "Needs setup: mapping or media is stale" : effective.active ? "Validated against current native data" : "Needs setup: draft mapping";
      }
    } catch { diagnostic = "Needs setup: native data or mapping could not be verified"; }
  }
  return { enabled, productId, shopId: session.shop, savedRevision: saved?.revision ?? "", provider: saved?.providerId ?? (productId === STORE_DEFAULT ? "shopify_native" : "inherit"),
    mapping: saved?.mapping ? JSON.stringify(saved.mapping, null, 2) : "", effectiveProvider: effective.providerId,
    diagnostic, catalog, coverage };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (request.method !== "POST") throw new Response("Method not allowed", { status: 405 });
  if (!providerSettingsEnabled()) throw new Response("Provider settings are not enabled on this installation", { status: 503 });
  const productId = await scopeFor(request, admin);
  const form = await boundedForm(request);
  const provider = form.get("provider") ?? "";
  const intent = form.get("intent");
  if ((!isProviderId(provider) && !(provider === "inherit" && productId !== STORE_DEFAULT)) || !["save", "activate"].includes(intent ?? "")) return { error: "Choose a supported provider setting and action." };
  const revision = form.get("revision") ?? "";
  let mapping: object | null = null;
  let active = provider === "shopify_native";
  try {
    if ((provider === "manual_mapping" || provider === "cloudlift") && productId !== STORE_DEFAULT) {
      const raw = form.get("mapping") ?? "";
      if (raw.length > 512_000) return { error: "Mapping exceeds 512 KB." };
      if (raw.trim()) mapping = parseManualMapping(JSON.parse(raw), session.shop, productId);
      if (intent === "activate") {
        if (form.get("reviewed") !== "yes" || !mapping) return { error: "Review all configuration-equivalence groups and full-product references before activation." };
        const snapshot = await nativeSnapshot(admin, productId);
        const errors = validateNativeBindings(mapping as ReturnType<typeof parseManualMapping>, snapshot.variants, snapshot.media);
        if (errors.length) return { error: errors.slice(0, 10).join(" ") };
        active = true;
      }
    } else if (intent === "activate" && provider !== "shopify_native") return { error: "This provider cannot be activated. External providers require a reviewed product mapping; unsupported options cannot be activated." };
  } catch { return { error: "Mapping is invalid, conflicting, incorrectly scoped, or its native data cannot be verified. No settings were changed." };
  }
  try {
    await prisma.$transaction(async (db) => {
      await db.shop.upsert({ where: { id: session.shop }, create: { id: session.shop, autoEnableProducts: true }, update: {} });
      const where = { shopId: session.shop, productId, revision };
      if (provider === "inherit") {
        if (revision && (await db.customizationConfig.deleteMany({ where })).count !== 1) throw new Error("STALE_SETTINGS");
        return;
      }
      const data = { providerId: provider, revision: randomUUID(), active, mapping: mapping ? JSON.parse(JSON.stringify(mapping)) : undefined };
      if (revision) {
        if ((await db.customizationConfig.updateMany({ where, data })).count !== 1) throw new Error("STALE_SETTINGS");
      } else await db.customizationConfig.create({ data: { shopId: session.shop, productId, ...data } });
    });
  } catch { return { error: "Settings changed in another session or could not be saved. Reload before trying again." };
  }
  return redirect(`/app/customization${productId === STORE_DEFAULT ? "" : `?product=${encodeURIComponent(productId)}`}`);
};

export default function CustomizationSettings() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const [provider, setProvider] = useState(data.provider);
  useEffect(() => { setProvider(data.provider); }, [data.provider, data.productId, data.savedRevision]);
  return <s-page heading="Product customization providers">
    <s-link slot="breadcrumb-actions" href="/app/products">Products</s-link>
    {!data.enabled && <s-section heading="Installation setup required"><s-paragraph>Provider settings are disabled. A reviewed database rollout and server opt-in are required. Existing native previews continue unchanged.</s-paragraph></s-section>}
    <s-section heading={data.productId === STORE_DEFAULT ? "Store default" : "Product override"}>
      <s-paragraph>Effective provider: {data.effectiveProvider}. Status: {data.diagnostic}.</s-paragraph>
      {data.coverage && <s-paragraph>{data.coverage.mapped} reviewed bindings out of {data.coverage.total} native variants; {data.coverage.unmapped} unmapped variants are not offered by this profile. Shopify currently reports {data.coverage.available} native variants available for sale.</s-paragraph>}
      <s-paragraph>Cloudlift native-linked mode supports only merchant-reviewed Shopify variants and full-product references. Independent Cloudlift custom options are NOT supported. Browser events never authorize a preview.</s-paragraph>
      <s-paragraph>Saving a provider that needs setup pauses Tryora previews for products using that setting. A store default affects inheriting products; explicit product overrides remain in effect. Manual drafts need validation and activation. Shopify checkout and existing product ON/OFF settings are unchanged.</s-paragraph>
      {result?.error && <p role="alert">{result.error}</p>}
      <Form method="post" key={`${data.productId}:${data.savedRevision}`}>
        <input type="hidden" name="provider" value={provider} />
        <input type="hidden" name="revision" value={data.savedRevision} />
        <s-select label="Product options provider" value={provider} disabled={!data.enabled} onChange={(e: any) => setProvider(e.currentTarget.value)}>
          {data.productId !== STORE_DEFAULT && <s-option value="inherit">Use store default</s-option>}
          {PROVIDERS.map((id) => <s-option key={id} value={id}>{PROVIDER_LABELS[id]}</s-option>)}
        </s-select>
        {(provider === "manual_mapping" || provider === "cloudlift") && data.productId !== STORE_DEFAULT && <>
          <s-paragraph>Paste a reviewed native-variant mapping profile. Cloudlift may display these Shopify variants, but Cloudlift-only custom properties are not supported. Every entry requires exact native options, preserved dimensions and an approved full-product reference. No external URLs or inferred colour associations.</s-paragraph>
          <details><summary>Mapping format and review requirements</summary>
            <s-paragraph>This is an inactive template, not verified product data. Replace every placeholder using the complete native evidence below. Remove optional roles that do not exist. Include every native option in each tuple. Use the same preservation-dimension names in every entry, and review all composite suffix fields before approving equivalent configurations.</s-paragraph>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify({ schemaVersion: 1, providerId: "manual_mapping", shopId: data.shopId, productId: data.productId, reviewed: false,
              roles: { size: "<exact native size option name>", fabric: "<exact native fabric option name>", composite: "<exact native composite option name>" },
              entries: [{ id: "<stable entry ID>", variantId: "<exact Shopify ProductVariant GID>", nativeOptions: { "<every exact native option name>": "<complete exact native value>" },
                fabric: { id: "<stable fabric ID>", label: "<reviewed fabric label>" }, colour: { id: "<stable colour ID>", label: "<reviewed colour label>" },
                preserved: { "<reviewed non-appearance dimension>": "<exact configuration value>" }, referenceMediaIds: ["<approved full-product MediaImage GID>"], swatchMediaId: "<optional distinct product-media swatch GID>" }] }, null, 2)}</pre>
            <s-paragraph>Set reviewed to true only after reviewing the complete mapping. A swatch cannot also serve as a full-product reference. Product-media IDs must belong to this product. Missing samples use text labels; missing product references block activation.</s-paragraph>
          </details>
          <label>Mapping JSON<textarea name="mapping" aria-label="Mapping JSON" rows={18} maxLength={512000} defaultValue={data.mapping} style={{ width: "100%", fontFamily: "monospace" }} /></label>
          <label><input type="checkbox" name="reviewed" value="yes" /> I verified the complete values, equivalent headboard/storage/other choices, swatch sources and full-product references for every entry.</label>
        </>}
        <s-stack direction="inline" gap="base">
          <button type="submit" name="intent" value="save" disabled={!data.enabled || nav.state !== "idle"}>Save setting / draft</button>
          {(provider === "manual_mapping" || provider === "cloudlift") && data.productId !== STORE_DEFAULT && <button type="submit" name="intent" value="activate" disabled={!data.enabled || nav.state !== "idle"}>Validate and activate mapping</button>}
        </s-stack>
        {nav.state !== "idle" && <p role="status">Validating or saving customization settings…</p>}
      </Form>
    </s-section>
    {data.catalog !== null && <s-section heading="Current native Shopify evidence"><details><summary>Inspect complete native option values, variant IDs, availability and product media</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(data.catalog, null, 2)}</pre></details></s-section>}
  </s-page>;
}
