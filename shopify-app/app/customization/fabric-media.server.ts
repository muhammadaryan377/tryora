import { FabricConfigError } from "./fabric-manager";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { AdminGraphql } from "../preview-product.server";
import { safeShopifyMediaUrl } from "./option-model";

export const STAGE_FABRIC_IMAGE = `#graphql
mutation TryoraStageFabricImage($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { message } }
}`;
export const ATTACH_FABRIC_IMAGE = `#graphql
mutation TryoraAttachFabricImage($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
  productUpdate(product: $product, media: $media) { product { id } userErrors { message } }
}`;
export const FABRIC_UPLOAD_STATUS = `#graphql
query TryoraFabricUploadStatus($id: ID!) {
  product(id: $id) { id media(last: 20) { nodes { id alt ... on MediaImage { image { url } } } } }
}`;
async function result(admin: AdminGraphql, query: string, variables: Record<string, unknown>) {
  const r = await admin.graphql(query, { variables }); const json = await r.json();
  if (!r.ok || json.errors?.length || !json.data) throw new FabricConfigError("Shopify media is unavailable. No fabric configuration was changed.");
  return json.data;
}
/** Bound before formData(), including chunked requests. Never write uploaded bytes to disk or Prisma. */
export async function fabricForm(request: Request, limit = 10 * 1024 * 1024) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^(multipart\/form-data|application\/x-www-form-urlencoded)(?:;|$)/i.test(contentType)) throw new Response("Unsupported form encoding", { status: 415 });
  const reader = request.body?.getReader();
  if (!reader) throw new Response("Missing form", { status: 400 });
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > limit) throw new Response("Upload exceeds 8 MB or configuration is too large", { status: 413 }); parts.push(part.value); }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return new Request(request.url, { method: "POST", headers: { "content-type": contentType }, body: Buffer.concat(parts) }).formData();
}
export async function cleanFabricImage(file: Blob): Promise<Uint8Array> {
  if (!file.size || file.size > 8 * 1024 * 1024) throw new FabricConfigError("Choose a JPG, PNG or WebP image under 8 MB.");
  try {
    const image = sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 24_000_000, failOn: "warning" });
    const meta = await image.metadata();
    if (!["jpeg", "png", "webp"].includes(meta.format ?? "") || !meta.width || !meta.height || meta.width < 16 || meta.height < 16 || (meta.pages ?? 1) > 1) throw new FabricConfigError("invalid");
    return await image.rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  } catch { throw new FabricConfigError("This image could not be validated. Use a still JPG, PNG or WebP image of at least 16 by 16 pixels."); }
}
function stagedUrl(value: string) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.port || !["shopify-staged-uploads.storage.googleapis.com", "storage.googleapis.com", "shopify-staged-uploads.s3.amazonaws.com"].includes(u.hostname)) throw new FabricConfigError("Unsupported Shopify staged-upload destination.");
  return u.toString();
}
/** Called only after admin authentication, product ownership, manual-mode and revision checks. */
export async function uploadFabricMedia(admin: AdminGraphql, productId: string, file: Blob, purpose: "sample" | "reference" = "sample") {
  const bytes = await cleanFabricImage(file), marker = `Tryora ${purpose === "sample" ? "fabric sample" : "furniture reference"} ${randomUUID()}`;
  const stage = (await result(admin, STAGE_FABRIC_IMAGE, { input: [{ filename: `${randomUUID()}.jpg`, mimeType: "image/jpeg", resource: "IMAGE", httpMethod: "POST", fileSize: String(bytes.length) }] })).stagedUploadsCreate;
  if (stage?.userErrors?.length || stage?.stagedTargets?.length !== 1) throw new FabricConfigError("Shopify could not prepare this upload. Check your product-write permission and try again.");
  const target = stage.stagedTargets[0];
  const destination = stagedUrl(target.url), resourceUrl = stagedUrl(target.resourceUrl);
  const form = new FormData();
  for (const p of target.parameters ?? []) form.append(p.name, p.value);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), "tryora-merchant-image.jpg");
  const uploaded = await fetch(destination, { method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!uploaded.ok) throw new FabricConfigError("The image upload did not complete. No fabric configuration was changed.");
  const attached = (await result(admin, ATTACH_FABRIC_IMAGE, { product: { id: productId }, media: [{ mediaContentType: "IMAGE", originalSource: resourceUrl, alt: marker }] })).productUpdate;
  if (attached?.userErrors?.length || attached?.product?.id !== productId) throw new FabricConfigError("Shopify could not attach the image to this product. No fabric configuration was changed.");
  for (let attempt = 0; attempt < 4; attempt++) {
    const data = await result(admin, FABRIC_UPLOAD_STATUS, { id: productId });
    if (data.product?.id !== productId) throw new FabricConfigError("Product ownership could not be verified.");
    const image = data.product.media.nodes.find((m: any) => m.alt === marker && m.image?.url && safeShopifyMediaUrl(m.image.url));
    // The marker travels with the new image so the manager keeps samples and full-product photos in separate pickers.
    if (image) return { media: { id: String(image.id), url: String(image.image.url), alt: marker }, pending: false };
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { media: null, pending: true };
}
