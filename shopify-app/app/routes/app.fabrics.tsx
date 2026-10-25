import { useEffect } from "react";
import { useLoaderData, useActionData, useNavigate, useLocation, useNavigation, useSubmit, useRouteError, isRouteErrorResponse, redirect, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { FabricColourManager } from "../components/fabric-colour-manager";
import { FabricConfigError, emptyFabricDraft } from "../customization/fabric-manager";
import { fabricProducts, draftFromMapping, compileFabricDocument, saveFabricConfiguration } from "../customization/fabric-manager.server";
import { fabricForm } from "../customization/fabric-media.server";
import { handleFabricUpload, productScope } from "../customization/fabric-upload.server";
import { requestFabricUpload } from "../customization/fabric-upload-request";
import { effectiveSetting, providerSettingsEnabled, providerAccess, STORE_DEFAULT } from "../customization/provider-config.server";
import { nativeSnapshot } from "../customization/reference-resolver.server";
import { nativeSelections } from "../core/customization";
import { discoverNativeOptions } from "../core/native-option-discovery";
import { isSampleMedia } from "../customization/media-roles";
import { sampleMediaIds, savedFabricSampleFiles } from "../customization/fabric-sample-files.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url), productId = productScope(request);
  const products = await fabricProducts(admin, url.searchParams.get("after") ?? undefined);
  const access = providerAccess(session.shop); let installationReady = access.enabled;
  let manualSetupReason = access.reason === "rollout_disabled" ? "The app administrator must complete the reviewed provider-table rollout and enable the server feature gate. Shopify-native previews continue to work."
    : access.reason === "invalid_allowlist" ? "The server customization allowlist is invalid. The app administrator must correct it before enabling Manual Setup. Shopify-native previews continue to work."
    : access.reason ? "The app administrator must authorize this Shopify installation in the server customization allowlist. Shopify-native previews continue to work." : "";
  if (!productId) return { products, installationReady, manualSetupReason, advanced: url.searchParams.get("advanced") === "1", selected: null };
  let snapshot: Awaited<ReturnType<typeof nativeSnapshot>>;
  try { snapshot = await nativeSnapshot(admin, productId); }
  catch { throw new Response("This product could not be refreshed from Shopify. Return to Products or refresh to try again. Saved configuration is unchanged.", { status: 502 }); }
  // The provider table has a separately reviewed migration. A partially deployed installation
  // must not crash the entire merchant screen or silently create/modify its schema.
  const config = await prisma.productPreviewConfig.findUnique({ where: { shopId_productId: { shopId: session.shop, productId } }, include: { choices: true } });
  let rows: Awaited<ReturnType<typeof prisma.customizationConfig.findMany>> = [];
  if (installationReady) {
    try {
      rows = await prisma.customizationConfig.findMany({ where: { shopId: session.shop, productId: { in: [STORE_DEFAULT, productId] } } });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "P2021")) throw error;
      installationReady = false;
      manualSetupReason = "The customization database table is not installed. The app operator must complete the reviewed provider-table rollout before enabling Manual Setup. Shopify Native previews are unaffected.";
    }
  }
  const own = rows.find((r) => r.productId === productId), effective = effectiveSetting(session.shop, productId, rows);
  let importBlocked = false;
  let draft = emptyFabricDraft(), diagnostics: Record<string, string> = {}, warning = "";
  try { draft = draftFromMapping(own?.mapping ?? effective.mapping, session.shop, productId); }
  catch { importBlocked = true; warning = "Existing integration cannot be imported safely. Its settings are preserved. Review existing integration settings before editing this profile."; }
  // Add standalone Shopify Files ONLY for saved sample IDs; keep actual product photos
  // in the original snapshot so fabric swatches never become gallery images.
  try {
    snapshot.media.push(...await savedFabricSampleFiles(admin, sampleMediaIds(draft), new Set(snapshot.media.map((m) => m.id))));
  } catch {
    warning = "Saved Shopify Files samples could not be loaded. Check the app's file permissions and reload before saving.";
  }
  // Older mappings could bind a product photo as a texture or colour sample. Never show or re-save it as a sample.
  const notSamples: string[] = [];
  const keepSample = (id: string | null, label: string) => {
    if (!id || isSampleMedia(snapshot.media.find((m) => m.id === id))) return id;
    notSamples.push(label); return null;
  };
  for (const f of draft.fabrics) {
    f.textureMediaId = keepSample(f.textureMediaId, `${f.name} texture`);
    for (const c of f.colours) c.swatchMediaId = keepSample(c.swatchMediaId, `${f.name} / ${c.name}`);
  }
  const sampleNotice = notSamples.length ? `These samples pointed to product photos, not fabric or colour samples, and were removed: ${notSamples.slice(0, 8).join(", ")}${notSamples.length > 8 ? ` and ${notSamples.length - 8} more` : ""}. Upload the real sample images, then save.` : "";
  if (!importBlocked) try { diagnostics = compileFabricDocument(draft, session.shop, productId, snapshot).diagnostics; }
  catch { warning = "Saved mapping or product media needs review. Existing settings were preserved. Re-select stale variants/references, or inspect existing integration settings."; }
  const model = nativeSelections(snapshot.product.options ?? [], config ? config.visualOptionName : discoverNativeOptions(snapshot.product.options ?? []).recommendedName, snapshot.variants);
  return { products, installationReady, manualSetupReason, advanced: url.searchParams.get("advanced") === "1", selected: {
    productId, title: String(snapshot.product.title), image: snapshot.media[0]?.image?.url ?? null,
    mode: effective.providerId === "shopify_native" ? "native" as const : "manual" as const,
    providerId: effective.providerId, revision: own?.revision ?? "", draft, diagnostics, warning, sampleNotice, importBlocked,
    explicitlyOff: !!config && !config.autoConfigured && !config.enabled,
    options: snapshot.product.options as { name: string; optionValues: { name: string; swatch?: { color?: string; image?: { image?: { url: string } } } }[] }[],
    variants: snapshot.variants, media: snapshot.media.flatMap((m) => m.image?.url ? [{ id: m.id, url: m.image.url, alt: m.alt ?? null }] : []),
    native: { optionName: model.optionName, fabricOptionName: model.fabricOptionName, issue: model.issue ?? null, selections: model.selections.map((s) => ({ ...s, available: snapshot.variants.some((v) => v.availableForSale && Object.entries(s.options).every(([name, value]) => v.selectedOptions.some((o) => o.name === name && o.value === value))) })) },
    syncedAt: new Date().toISOString(), saved: url.searchParams.get("saved") === "1",
  } };
};
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (request.method !== "POST") throw new Response("Method not allowed", { status: 405 });
  const productId = productScope(request);
  if (!productId) throw new Response("Select a product", { status: 400 });
  if (!providerSettingsEnabled(session.shop)) return { error: "Manual/mode settings require the reviewed provider-table rollout and server authorization for this installation. Native previews remain unchanged." };
  const form = await fabricForm(request);
  const revision = String(form.get("revision") ?? "");
  try {
    // The page itself uploads through the JSON-only /app/fabrics/upload route; this keeps direct action callers working.
    if (form.get("intent") === "upload") return await handleFabricUpload(admin, session.shop, productId, form);
    if (form.get("intent") !== "save") throw new FabricConfigError("Choose a supported configuration action.");
    const raw = String(form.get("draft") ?? "");
    if (raw.length > 900_000) throw new FabricConfigError("Configuration is too large.");
    let draft: unknown;
    try { draft = JSON.parse(raw); } catch { throw new FabricConfigError("Invalid fabric configuration. Reload and try again."); }
    await saveFabricConfiguration(admin, session.shop, productId, { mode: String(form.get("mode") ?? ""), revision, draft });
    return redirect(`/app/fabrics?product=${encodeURIComponent(productId)}&saved=1`);
  } catch (e) {
    return { error: e instanceof FabricConfigError ? e.message : "Configuration could not be verified or saved. Refresh the product and review its mappings; no checkout or product availability settings were changed." };
  }
};
export default function FabricsPage() {
  const data = useLoaderData<typeof loader>(), actionData = useActionData<typeof action>(), navigation = useNavigation(), submit = useSubmit();
  const navigate = useNavigate(), location = useLocation();
  // Use SPA navigation inside Shopify's embedded iframe; a server/browser redirect
  // can lose the Shopify session and appear as an empty HTTP 200 page.
  const chooseFirst = !data.selected && !new URLSearchParams(location.search).has("browse") &&
    !new URLSearchParams(location.search).has("after") ? data.products.nodes[0]?.id : null;
  useEffect(() => {
    if (chooseFirst) navigate(`/app/fabrics?product=${encodeURIComponent(chooseFirst)}`, { replace: true });
  }, [chooseFirst, navigate]);
  return <FabricColourManager data={data} error={actionData && "error" in actionData ? actionData.error : undefined} busy={navigation.state !== "idle"}
    selectProduct={(productId) => navigate(`/app/fabrics?product=${encodeURIComponent(productId)}`)}
    save={(mode, draft) => submit({ intent: "save", mode, revision: data.selected?.revision ?? "", draft: JSON.stringify(draft) }, { method: "post" })}
    upload={(file, purpose) => requestFabricUpload({ productId: data.selected?.productId ?? "", revision: data.selected?.revision ?? "", file, purpose })} />;
}

/** Show a useful recovery screen rather than an empty Shopify embedded app on a loader failure. */
export function ErrorBoundary() {
  const error = useRouteError();
  const detail = isRouteErrorResponse(error)
    ? error.status === 502 ? "The Shopify product or media request failed. Try refreshing the product."
      : error.status === 404 ? "This product is no longer available to this Shopify installation."
      : `The page could not load (HTTP ${error.status}).`
    : "The Fabrics & Colours page could not load its current product settings. Check the app installation and provider-table rollout.";
  return <s-page heading="Fabrics & Colours">
    <s-section heading="Configuration temporarily unavailable">
      <s-banner heading="Couldn't open the fabric manager" tone="critical"><p role="alert">{detail}</p></s-banner>
      <p>No product configuration has been changed by this failed page load.</p>
      <s-link href="/app/fabrics">Return to product selection</s-link>
    </s-section>
  </s-page>;
}
