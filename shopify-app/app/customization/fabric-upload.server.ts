import prisma from "../db.server";
import type { AdminGraphql } from "../preview-product.server";
import { FabricConfigError } from "./fabric-manager";
import { logUploadFailure, shopifyMessages, uploadFabricMedia } from "./fabric-media.server";
import { nativeSnapshot } from "./reference-resolver.server";

/** The verified product from ?product=, as a Product GID; null when absent. */
export function productScope(request: Request) {
  const raw = new URL(request.url).searchParams.get("product");
  if (!raw) return null;
  const id = /^\d+$/.test(raw) ? `gid://shopify/Product/${raw}` : raw;
  if (!/^gid:\/\/shopify\/Product\/\d{1,20}$/.test(id)) throw new Response("Invalid product", { status: 400 });
  return id;
}

/**
 * One merchant sample or reference upload, after admin authentication and the installation check.
 * Uploads do not activate a mapping, alter provider mode or authorize a preview.
 */
export async function handleFabricUpload(admin: AdminGraphql, shopId: string, productId: string, form: FormData) {
  let step = "request";
  try {
    // A merchant may upload a sample while preparing an unsaved Manual Setup draft.
    if (form.get("mode") !== "manual") throw new FabricConfigError("Select Manual Setup before uploading a fabric or colour sample.");
    // Ownership is read from this authenticated shop, never a submitted shop ID.
    step = "product";
    await nativeSnapshot(admin, productId, false);
    step = "settings";
    const saved = await prisma.customizationConfig.findUnique({ where: { shopId_productId: { shopId, productId } } });
    if ((saved?.revision ?? "") !== String(form.get("revision") ?? "")) throw new FabricConfigError("Product settings changed in another session. Reload before uploading.");
    if (saved && !["shopify_native", "manual_mapping", "cloudlift"].includes(saved.providerId)) throw new FabricConfigError("Review this product's existing provider before uploading samples.");
    const purpose = form.get("purpose");
    if (purpose !== "sample" && purpose !== "reference") throw new FabricConfigError("Choose fabric sample or full-product reference image.");
    const file = form.get("image");
    if (!(file instanceof Blob)) throw new FabricConfigError("Choose an image to upload.");
    step = "upload";
    return await uploadFabricMedia(admin, productId, file, purpose);
  } catch (e) {
    if (e instanceof FabricConfigError) return { error: e.message };
    // Unexpected failures are logged with their step so the cause is visible in the server log.
    logUploadFailure(step, e);
    const detail = shopifyMessages(e).join(" ");
    return { error: step === "product" ? `This product could not be read from Shopify${detail ? `: ${detail}` : "."} Refresh the page and try again.`
      : step === "settings" ? "Tryora's settings could not be read just now. Try again in a moment; no configuration was changed."
        : `The image could not be uploaded to Shopify${detail ? `: ${detail}` : "."} Refresh the product and try again; no configuration was changed.` };
  }
}
