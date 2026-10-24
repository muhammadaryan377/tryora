import { useLoaderData, useActionData, useNavigation, useSubmit, redirect, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { FabricColourManager } from "../components/fabric-colour-manager";
import { FabricConfigError, emptyFabricDraft } from "../customization/fabric-manager";
import { fabricProducts, draftFromMapping, compileFabricDocument, saveFabricConfiguration } from "../customization/fabric-manager.server";
import { fabricForm, uploadFabricMedia } from "../customization/fabric-media.server";
import { effectiveSetting, providerSettingsEnabled, providerAccess, STORE_DEFAULT } from "../customization/provider-config.server";
import { nativeSnapshot } from "../customization/reference-resolver.server";
import { nativeSelections } from "../core/customization";
import { discoverNativeOptions } from "../core/native-option-discovery";

function productScope(request: Request) {
  const raw = new URL(request.url).searchParams.get("product");
  if (!raw) return null;
  const id = /^\d+$/.test(raw) ? `gid://shopify/Product/${raw}` : raw;
  if (!/^gid:\/\/shopify\/Product\/\d{1,20}$/.test(id)) throw new Response("Invalid product", { status: 400 });
  return id;
}
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url), productId = productScope(request);
  const products = await fabricProducts(admin, url.searchParams.get("after") ?? undefined);
  const access = providerAccess(session.shop), installationReady = access.enabled;
  const manualSetupReason = access.reason === "rollout_disabled" ? "The app administrator must complete the reviewed provider-table rollout and enable the server feature gate. Shopify-native previews continue to work."
    : access.reason === "invalid_allowlist" ? "The server customization allowlist is invalid. The app administrator must correct it before enabling Manual Setup. Shopify-native previews continue to work."
    : access.reason ? "The app administrator must authorize this Shopify installation in the server customization allowlist. Shopify-native previews continue to work." : "";
  if (!productId) return { products, installationReady, manualSetupReason, selected: null };
  let snapshot: Awaited<ReturnType<typeof nativeSnapshot>>;
  try { snapshot = await nativeSnapshot(admin, productId); }
  catch { throw new Response("This product could not be refreshed from Shopify. Return to Products or refresh to try again. Saved configuration is unchanged.", { status: 502 }); }
  const [rows, config] = await Promise.all([
    installationReady ? prisma.customizationConfig.findMany({ where: { shopId: session.shop, productId: { in: [STORE_DEFAULT, productId] } } }) : Promise.resolve([]),
    prisma.productPreviewConfig.findUnique({ where: { shopId_productId: { shopId: session.shop, productId } }, include: { choices: true } }),
  ]);
  const own = rows.find((r) => r.productId === productId), effective = effectiveSetting(session.shop, productId, rows);
  let importBlocked = false;
  let draft = emptyFabricDraft(), diagnostics: Record<string, string> = {}, warning = "";
  try { draft = draftFromMapping(own?.mapping ?? effective.mapping, session.shop, productId); }
  catch { importBlocked = true; warning = "Existing integration cannot be imported safely. Its settings are preserved. Review existing integration settings before editing this profile."; }
  if (!importBlocked) try { diagnostics = compileFabricDocument(draft, session.shop, productId, snapshot).diagnostics; }
  catch { warning = "Saved mapping or product media needs review. Existing settings were preserved. Re-select stale variants/references, or inspect existing integration settings."; }
  const model = nativeSelections(snapshot.product.options ?? [], config ? config.visualOptionName : discoverNativeOptions(snapshot.product.options ?? []).recommendedName, snapshot.variants);
  return { products, installationReady, manualSetupReason, selected: {
    productId, title: String(snapshot.product.title), image: snapshot.media[0]?.image?.url ?? null,
    mode: effective.providerId === "shopify_native" ? "native" as const : "manual" as const,
    providerId: effective.providerId, revision: own?.revision ?? "", draft, diagnostics, warning, importBlocked,
    explicitlyOff: !!config && !config.autoConfigured && !config.enabled,
    options: snapshot.product.options as { name: string; optionValues: { name: string; swatch?: { color?: string; image?: { image?: { url: string } } } }[] }[],
    variants: snapshot.variants, media: snapshot.media.flatMap((m) => m.image?.url ? [{ id: m.id, url: m.image.url }] : []),
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
    if (form.get("intent") === "upload") {
      // Ownership is read from this authenticated shop, never a submitted shop ID.
      await nativeSnapshot(admin, productId, false);
      const saved = await prisma.customizationConfig.findUnique({ where: { shopId_productId: { shopId: session.shop, productId } } });
      if (!saved || saved.revision !== revision || !["manual_mapping", "cloudlift"].includes(saved.providerId)) throw new FabricConfigError("Save Manual Setup for this product before uploading; reload if another session changed it.");
      const file = form.get("image");
      if (!(file instanceof Blob)) throw new FabricConfigError("Choose an image to upload.");
      return await uploadFabricMedia(admin, productId, file);
    }
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
  return <FabricColourManager data={data} error={actionData && "error" in actionData ? actionData.error : undefined} busy={navigation.state !== "idle"}
    save={(mode, draft) => submit({ intent: "save", mode, revision: data.selected?.revision ?? "", draft: JSON.stringify(draft) }, { method: "post" })}
    upload={async (file) => {
      const form = new FormData(); form.set("intent", "upload"); form.set("revision", data.selected?.revision ?? ""); form.set("image", file);
      const response = await fetch(window.location.href, { method: "POST", body: form, credentials: "same-origin" });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error ?? "Upload failed. Please try again.");
      if (result.pending) throw new Error("Shopify is processing this image. Refresh from Shopify, then select the new image; do not upload it again.");
      return result.media;
    }} />;
}
