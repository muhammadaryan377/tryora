import { FabricConfigError } from "./fabric-manager";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { AdminGraphql } from "../preview-product.server";
import { safeShopifyMediaUrl } from "./option-model";

export const STAGE_FABRIC_IMAGE = `#graphql
mutation TryoraStageFabricImage($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { message } }
}`;
// Samples belong to Shopify Files, NOT the product's media gallery. fileCreate
// requires the merchant-approved write_files (or write_images) scope.
export const CREATE_FABRIC_SAMPLE = `#graphql
mutation TryoraCreateFabricSample($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files { id fileStatus alt ... on MediaImage { image { url } } }
    userErrors { message }
  }
}`;
export const FABRIC_FILE_UPLOAD_STATUS = `#graphql
query TryoraFabricFileUploadStatus($id: ID!) {
  node(id: $id) {
    ... on MediaImage { id alt fileStatus image { url } }
  }
}`;
export const ATTACH_FABRIC_IMAGE = `#graphql
mutation TryoraAttachFabricImage($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
  productUpdate(product: $product, media: $media) { product { id } userErrors { message } }
}`;
export const FABRIC_UPLOAD_STATUS = `#graphql
query TryoraFabricUploadStatus($id: ID!) {
  product(id: $id) { id media(first: 250, reverse: true) { nodes { id alt status ... on MediaImage { image { url } } } } }
}`;
/** Shopify's own error text from a GraphQL body, a thrown GraphqlQueryError, or a list of userErrors. */
export function shopifyMessages(source: unknown): string[] {
  const body = (source as any)?.body ?? (source as any)?.response?.body ?? source;
  const list = Array.isArray(body) ? body : Array.isArray(body?.errors) ? body.errors : Array.isArray(body?.errors?.graphQLErrors) ? body.errors.graphQLErrors : [];
  const messages: string[] = list.map((entry: any) => typeof entry === "string" ? entry : entry?.message).filter((m: unknown): m is string => typeof m === "string" && !!m.trim());
  if (!messages.length && source instanceof Error && source.message && !/^[A-Z_]+$/.test(source.message)) messages.push(source.message);
  return messages.map((m) => m.replace(/\s+/g, " ").trim().slice(0, 200)).slice(0, 3);
}
/** One server log line per failed upload step: never image bytes, tokens or shopper data. */
export function logUploadFailure(step: string, error: unknown, extra: Record<string, unknown> = {}) {
  console.warn(JSON.stringify({ component: "fabric-upload", event: "failed", step, errorClass: error instanceof Error ? error.name : typeof error, messages: shopifyMessages(error), ...extra }));
}
/** A Shopify refusal the merchant can act on, with Shopify's own words when it gave any. */
function refused(step: string, what: string, source: unknown, extra: Record<string, unknown> = {}) {
  logUploadFailure(step, source, extra);
  const messages = shopifyMessages(source);
  return new FabricConfigError(`Shopify could not ${what}${messages.length ? `: ${messages.join(" ")}` : "."} No fabric configuration was changed.`);
}
// The Shopify library throws GraphqlQueryError (body attached) instead of returning top-level errors.
async function result(admin: AdminGraphql, query: string, variables: Record<string, unknown>, step: string, what: string) {
  let r: Response, json: any;
  try { r = await admin.graphql(query, { variables }); json = await r.json(); }
  catch (error) { throw refused(step, what, error); }
  if (!r.ok || json?.errors?.length || !json?.data) throw refused(step, what, json, { status: r.status });
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
  const bytes = await cleanFabricImage(file), marker = `Visully ${purpose === "sample" ? "fabric sample" : "furniture reference"} ${randomUUID()}`;
  const stage = (await result(admin, STAGE_FABRIC_IMAGE, { input: [{ filename: `${randomUUID()}.jpg`, mimeType: "image/jpeg", resource: "IMAGE", httpMethod: "POST", fileSize: String(bytes.length) }] }, "stage", "prepare this upload")).stagedUploadsCreate;
  if (stage?.userErrors?.length || stage?.stagedTargets?.length !== 1) throw refused("stage", "prepare this upload", stage?.userErrors ?? []);
  const target = stage.stagedTargets[0];
  const destination = stagedUrl(target.url), resourceUrl = stagedUrl(target.resourceUrl);
  const form = new FormData();
  for (const p of target.parameters ?? []) form.append(p.name, p.value);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), "tryora-merchant-image.jpg");
  let uploaded: Response;
  try { uploaded = await fetch(destination, { method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
  catch (error) { logUploadFailure("transfer", error, { host: new URL(destination).hostname }); throw new FabricConfigError("The image could not be sent to Shopify's upload storage. Check the connection and try again; no fabric configuration was changed."); }
  if (!uploaded.ok) { logUploadFailure("transfer", null, { status: uploaded.status, host: new URL(destination).hostname }); throw new FabricConfigError(`Shopify's upload storage refused the image (HTTP ${uploaded.status}). Try again; no fabric configuration was changed.`); }
  if (purpose === "sample") {
    // A sample is a palette/texture reference, not a purchasable product photo.
    // Never fall back to productUpdate when Shopify Files permission is missing.
    const created = (await result(admin, CREATE_FABRIC_SAMPLE, { files: [{ contentType: "IMAGE", originalSource: resourceUrl, alt: marker }] }, "create-file", "save the sample to Shopify Files")).fileCreate;
    const fileId = created?.files?.[0]?.id;
    if (created?.userErrors?.length || !/^gid:\/\/shopify\/MediaImage\/\d{1,20}$/.test(fileId ?? "") || created.files.length !== 1) {
      throw refused("create-file", "save the sample to Shopify Files", created?.userErrors ?? []);
    }
    for (const delay of UPLOAD_STATUS_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const media = await findUploadedMedia(admin, productId, marker, fileId).catch((error) => {
        if (error instanceof FabricConfigError) throw error;
        logUploadFailure("file-status", error);
        return null;
      });
      if (media) return { media, pending: false };
    }
    return { media: null, pending: true, marker, fileId };
  }
  // Only complete furniture reference photos may be attached to product media.
  const attached = (await result(admin, ATTACH_FABRIC_IMAGE, { product: { id: productId }, media: [{ mediaContentType: "IMAGE", originalSource: resourceUrl, alt: marker }] }, "attach", "attach the image to this product")).productUpdate;
  if (attached?.userErrors?.length || attached?.product?.id !== productId) throw refused("attach", "attach the image to this product", attached?.userErrors ?? []);
  // The image is now attached; Shopify processes it in the background. Wait a little, never failing the upload on a
  // slow or briefly failing status check: the browser keeps checking the marker until the image is ready.
  for (const delay of UPLOAD_STATUS_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const media = await findUploadedMedia(admin, productId, marker).catch((error) => { if (error instanceof FabricConfigError) throw error; logUploadFailure("status", error); return null; });
    if (media) return { media, pending: false };
  }
  return { media: null, pending: true, marker };
}

/** Waits before each status check after attaching (first check immediately; about 12 seconds in total). Tests may shorten it. */
export const UPLOAD_STATUS_DELAYS_MS = [0, 1000, 1500, 2000, 3000, 4000];
// Accept newly branded uploads and legacy Tryora media already in Shopify. Retain the strict UUID and role checks.
export const UPLOAD_MARKER = /^(?:Visully|Tryora) (fabric sample|furniture reference) [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The processed image carrying this upload's marker, or null while Shopify is still processing it. */
export async function findUploadedMedia(admin: AdminGraphql, productId: string, marker: string, fileId?: string) {
  if (fileId) {
    if (!/^gid:\/\/shopify\/MediaImage\/\d{1,20}$/.test(fileId) || !UPLOAD_MARKER.test(marker) || !/(?:^Visully|^Tryora) fabric sample /.test(marker)) {
      throw new FabricConfigError("Invalid isolated sample upload.");
    }
    const response = await admin.graphql(FABRIC_FILE_UPLOAD_STATUS, { variables: { id: fileId } });
    const json: any = await response.json();
    if (!response.ok || json?.errors?.length || !json?.data) throw new Error("Shopify Files upload status unavailable.");
    const file = json.data.node;
    if (!file || file.id !== fileId || file.alt !== marker) throw new FabricConfigError("Isolated sample upload could not be verified.");
    if (file.fileStatus === "FAILED") throw new FabricConfigError("Shopify could not process this fabric sample. Try another image.");
    return file.fileStatus === "READY" && file.image?.url && safeShopifyMediaUrl(file.image.url)
      ? { id: fileId, url: file.image.url as string, alt: marker } : null;
  }
  // Any Shopify error here only means "not confirmed yet" (thrown as a plain error); callers check again.
  const response = await admin.graphql(FABRIC_UPLOAD_STATUS, { variables: { id: productId } });
  const json: any = await response.json();
  if (!response.ok || json?.errors?.length || !json?.data) throw Object.assign(new Error("Upload status unavailable"), { body: json });
  const data = json.data;
  if (data.product?.id !== productId) throw new FabricConfigError("Product ownership could not be verified.");
  // Shopify rejects "media(last:)" without "before". Newest first with reverse: true, and up to 250 so the marker is
  // found on any product whatever its media order.
  const node = data.product.media.nodes.find((m: any) => m?.alt === marker);
  if (node?.status === "FAILED") throw new FabricConfigError("Shopify could not process this image. Try a different JPG or PNG; no fabric configuration was changed.");
  const image = node?.image?.url && safeShopifyMediaUrl(node.image.url) ? node : null;
  // The marker travels with the new image so the manager keeps samples and full-product photos in separate pickers.
  return image ? { id: String(image.id), url: String(image.image.url), alt: marker } : null;
}
