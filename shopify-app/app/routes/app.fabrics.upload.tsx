import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { fabricForm, findUploadedMedia, UPLOAD_MARKER } from "../customization/fabric-media.server";
import { FabricConfigError } from "../customization/fabric-manager";
import { handleFabricUpload, productScope } from "../customization/fabric-upload.server";
import { providerSettingsEnabled } from "../customization/provider-config.server";

/**
 * Resource route for merchant image uploads. A plain fetch POST to the Fabrics page itself is answered with the
 * rendered HTML document, so uploads come here and every outcome, including errors, is JSON.
 */
/** Status of one upload that Shopify was still processing, found by its unique marker. Always JSON. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  try {
    const productId = productScope(request), marker = new URL(request.url).searchParams.get("marker") ?? "";
    if (!productId || !UPLOAD_MARKER.test(marker)) return Response.json({ error: "Upload not recognised. Refresh the page." }, { status: 400 });
    if (!providerSettingsEnabled(session.shop)) return Response.json({ error: "Manual setup is not enabled for this installation." }, { status: 403 });
    const media = await findUploadedMedia(admin, productId, marker);
    return Response.json(media ? { pending: false, media } : { pending: true, marker });
  } catch (e) {
    // A temporary Shopify error while checking is not a failed upload: the browser simply checks again.
    return Response.json(e instanceof FabricConfigError ? { error: e.message } : { pending: true }, { status: e instanceof FabricConfigError ? 400 : 200 });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  try {
    const productId = productScope(request);
    if (!productId) return Response.json({ error: "Select a product before uploading." }, { status: 400 });
    if (!providerSettingsEnabled(session.shop)) return Response.json({ error: "Manual setup requires the reviewed provider-table rollout and server authorization for this installation. Native previews remain unchanged." }, { status: 403 });
    const result = await handleFabricUpload(admin, session.shop, productId, await fabricForm(request));
    return Response.json(result, { status: "error" in result ? 400 : 200 });
  } catch (e) {
    const status = e instanceof Response ? e.status : 500;
    return Response.json({ error: status === 413 ? "Choose a JPG, PNG or WebP image under 8 MB." : status === 400 ? "This product could not be verified. Reload the page and try again." : "The upload could not be read. Try again." }, { status });
  }
};
