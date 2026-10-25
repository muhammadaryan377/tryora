import { FabricConfigError } from "./fabric-manager";
import { createHash, randomUUID } from "node:crypto";
import prisma from "../db.server";
import type { AdminGraphql } from "../preview-product.server";
import { nativeSnapshot } from "./reference-resolver.server";
import { canonicalOptions, optionsOf, parseManualMapping, safeShopifyMediaUrl, validateNativeBindings, type ManualMapping } from "./option-model";
import { emptyFabricDraft, isFabricDocument, parseFabricDocument, parseFabricDraft, type FabricDocument, type FabricDraft, type ManagedFabric } from "./fabric-manager";
import { providerSettingsEnabled } from "./provider-config.server";
import { isSampleMedia } from "./media-roles";

export const FABRIC_PRODUCTS_QUERY = `#graphql
query TryoraFabricProducts($after: String) {
  products(first: 25, sortKey: TITLE, after: $after) {
    nodes { id title featuredMedia { preview { image { url } } } }
    pageInfo { hasNextPage endCursor }
  }
}`;
export async function fabricProducts(admin: AdminGraphql, after?: string) {
  if (after && after.length > 1000) throw new Response("Invalid product cursor", { status: 400 });
  const r = await admin.graphql(FABRIC_PRODUCTS_QUERY, { variables: { after: after ?? null } });
  const json = await r.json();
  if (!r.ok || json.errors?.length || !json.data?.products) throw new Response("Shopify products could not be loaded. Refresh to retry.", { status: 502 });
  return json.data.products as { nodes: { id: string; title: string; featuredMedia?: { preview?: { image?: { url: string } } } }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}
export function draftFromMapping(raw: unknown, shopId: string, productId: string): FabricDraft {
  if (isFabricDocument(raw)) return parseFabricDocument(raw, shopId, productId).draft;
  if (!raw) return emptyFabricDraft();
  const mapping = parseManualMapping(raw, shopId, productId);
  const fabrics = new Map<string, ManagedFabric>();
  const colourId = (f: string, c: string) => `c-${createHash("sha256").update(JSON.stringify([f, c])).digest("hex").slice(0, 24)}`;
  for (const e of mapping.entries) {
    if (!fabrics.has(e.fabric.id)) fabrics.set(e.fabric.id, { id: e.fabric.id, name: e.fabric.label, description: "", enabled: true, textureMediaId: null, colours: [] });
    const fabric = fabrics.get(e.fabric.id)!;
    const cid = colourId(e.fabric.id, e.colour.id);
    const existingColour = fabric.colours.find((c) => c.id === cid);
    if (existingColour && existingColour.swatchMediaId !== (e.swatchMediaId ?? null)) throw new FabricConfigError("Existing per-variant samples conflict for one appearance. Review the existing integration before importing it.");
    if (!existingColour) fabric.colours.push({ id: cid, name: e.colour.label, enabled: true, swatchMediaId: e.swatchMediaId ?? null, hex: null });
  }
  return parseFabricDraft({ roles: mapping.roles, fabrics: [...fabrics.values()], bindings: mapping.entries.map((e) => ({ id: e.id, fabricId: e.fabric.id,
    colourId: colourId(e.fabric.id, e.colour.id), variantId: e.variantId, nativeOptions: e.nativeOptions, preserved: e.preserved,
    externalValues: {}, referenceMediaIds: e.referenceMediaIds, reviewed: true })) });
}
export function compileFabricDocument(raw: unknown, shopId: string, productId: string, snapshot: Awaited<ReturnType<typeof nativeSnapshot>>) {
  const draft = parseFabricDraft(raw);
  const media = new Map(snapshot.media.map((m) => [m.id, m]));
  const samples = new Set(draft.fabrics.flatMap((f) => [f.textureMediaId, ...f.colours.map((c) => c.swatchMediaId)]).filter((id): id is string => !!id));
  for (const mid of samples) {
    if (!media.get(mid)?.image?.url || !safeShopifyMediaUrl(media.get(mid)!.image!.url)) throw new FabricConfigError("A fabric/swatches image is stale or does not belong to this product. Select it again.");
    if (!isSampleMedia(media.get(mid))) throw new FabricConfigError("A selected fabric texture or colour sample is a product photo, not a fabric or colour sample. Upload the real sample image instead.");
  }
  const entries: ManualMapping["entries"] = [], diagnostics: Record<string, string> = {};
  for (const b of draft.bindings) {
    for (const mid of b.referenceMediaIds) {
      if (!media.get(mid)?.image?.url || !safeShopifyMediaUrl(media.get(mid)!.image!.url)) throw new FabricConfigError("A product reference is stale or belongs to another product. Select it again.");
      if (samples.has(mid)) throw new FabricConfigError("Texture and swatch samples cannot also approve a full-product reference.");
      if (isSampleMedia(media.get(mid))) throw new FabricConfigError("An uploaded fabric or colour sample cannot be a full furniture reference. Choose a complete product photo.");
    }
    const f = draft.fabrics.find((f) => f.id === b.fabricId)!, c = f.colours.find((c) => c.id === b.colourId)!;
    if (!f.enabled || !c.enabled) { diagnostics[b.id] = "Disabled"; continue; }
    if (!b.variantId || Object.keys(b.externalValues).length) { diagnostics[b.id] = "External configuration is saved; an authenticated native-linked variant is required for preview."; continue; }
    const variant = snapshot.variants.find((v) => v.id === b.variantId);
    if (!variant || canonicalOptions(optionsOf(variant)) !== canonicalOptions(b.nativeOptions)) throw new FabricConfigError("A saved variant/options binding is stale. Select the exact variant again and review its reference.");
    if (b.referenceMediaIds.some((id) => samples.has(id))) throw new FabricConfigError("Texture and swatch samples cannot also approve a full-product reference.");
    if (!b.referenceMediaIds.length || !b.reviewed) { diagnostics[b.id] = "Swatch configured - Preview not ready."; continue; }
    const entry = { id: b.id, variantId: b.variantId, nativeOptions: b.nativeOptions, fabric: { id: f.id, label: f.name }, colour: { id: c.id, label: c.name },
      preserved: b.preserved, referenceMediaIds: b.referenceMediaIds, ...(c.swatchMediaId ? { swatchMediaId: c.swatchMediaId } : {}) };
    entries.push(entry); diagnostics[b.id] = variant.availableForSale ? "Ready for exact preview validation" : "Shopify reports this variant unavailable for sale";
  }
  let published: ManualMapping | null = null;
  if (entries.length) {
    published = parseManualMapping({ schemaVersion: 1, providerId: "manual_mapping", shopId, productId, reviewed: true, roles: draft.roles, entries }, shopId, productId);
    const errors = validateNativeBindings(published, snapshot.variants, snapshot.media);
    if (errors.length) throw new FabricConfigError(errors.slice(0, 4).join(" "));
  }
  const document: FabricDocument = { kind: "fabric_colour_manager", schemaVersion: 1, shopId, productId, draft, published };
  return { document, diagnostics };
}
export async function saveFabricConfiguration(admin: AdminGraphql, shopId: string, productId: string, input: { mode: string; revision: string; draft: unknown }) {
  if (!providerSettingsEnabled(shopId)) throw new FabricConfigError("Manual setup requires the reviewed provider-table rollout and server authorization for this installation. Native previews remain unchanged.");
  if (!["native", "manual"].includes(input.mode)) throw new FabricConfigError("Choose Shopify Native or Manual Setup.");
  const snapshot = await nativeSnapshot(admin, productId);
  // Never update productPreviewConfig: explicit OFF settings and auto-enable behavior remain authoritative.
  const result = input.mode === "manual" ? compileFabricDocument(input.draft, shopId, productId, snapshot)
    : { document: { kind: "fabric_colour_manager" as const, schemaVersion: 1 as const, shopId, productId, draft: emptyFabricDraft(), published: null }, diagnostics: {} };
  await prisma.$transaction(async (db) => {
    const previous = await db.customizationConfig.findUnique({ where: { shopId_productId: { shopId, productId } } });
    if ((previous?.revision ?? "") !== input.revision) throw new FabricConfigError("Configuration changed in another session. Reload before saving.");
    if (input.mode === "manual" && previous?.mapping && !isFabricDocument(previous.mapping)) {
      try { draftFromMapping(previous.mapping, shopId, productId); }
      catch { throw new FabricConfigError("Existing integration cannot be imported safely. Review it in existing integration settings before replacing its mapping."); }
    }
    const providerId = input.mode === "native" ? "shopify_native" : previous?.providerId === "cloudlift" ? "cloudlift" : "manual_mapping";
    const data = { providerId, active: input.mode === "native" || !!result.document.published, revision: randomUUID(), mapping: input.mode === "native" && previous?.mapping ? previous.mapping : JSON.parse(JSON.stringify(result.document)) };
    await db.shop.upsert({ where: { id: shopId }, create: { id: shopId }, update: {} });
    if (previous) {
      const updated = await db.customizationConfig.updateMany({ where: { shopId, productId, revision: input.revision }, data });
      if (updated.count !== 1) throw new FabricConfigError("Configuration changed in another session. Reload before saving.");
    } else await db.customizationConfig.create({ data: { shopId, productId, ...data } });
  });
  return result;
}
