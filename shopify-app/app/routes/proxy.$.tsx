import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  acknowledge,
  captureLead,
  checkPhoto,
  errorCode,
  pollPreview,
  reportIssue,
  startPreview,
  storefrontConfig,
} from "../storefront.server";
import { guardPhotoCheck, guardPreview } from "../guard.server";

/**
 * Storefront API behind the Shopify app proxy: the store's /apps/tryora/<path> arrives here as /proxy/<path>.
 * Shopify signs every proxied request; authenticate.public.appProxy rejects anything unsigned.
 */

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

async function photoFrom(form: FormData): Promise<Uint8Array | null> {
  const f = form.get("photo");
  if (!f || typeof f === "string") return null;
  if (f.size > MAX_PHOTO_BYTES) return null;
  return new Uint8Array(await f.arrayBuffer());
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session || !admin) return json({ error: "NOT_INSTALLED" }, 404);
  const url = new URL(request.url);
  const path = params["*"] ?? "";

  if (path === "config") {
    const productId = url.searchParams.get("product") ?? "";
    return json(await storefrontConfig(admin, session.shop, productId));
  }
  const poll = path.match(/^preview\/([\w-]+)$/);
  if (poll) {
    try { return json(await pollPreview(session.shop, poll[1]!)); }
    catch { return json({ error: "TEMPORARILY_UNAVAILABLE" }, 503); }
  }
  return json({ error: "NOT_FOUND" }, 404);
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session || !admin) return json({ error: "NOT_INSTALLED" }, 404);
  const shopId = session.shop;
  const path = params["*"] ?? "";
  const form = await request.formData();
  const field = (k: string) => String(form.get(k) ?? "");

  try {
    switch (path) {
      case "check": {
        guardPhotoCheck(shopId, field("visitor"));
        const photo = await photoFrom(form);
        if (!photo) return json({ ok: false, reason: "dark_or_blurred" });
        return json(await checkPhoto(admin, photo, shopId, field("product")));
      }
      case "preview": {
        await guardPreview(shopId, field("visitor"));
        const photo = await photoFrom(form);
        if (!photo) return json({ error: "BAD_PHOTO" }, 400);
        return json(
          await startPreview({
            admin,
            shopId,
            productId: field("product"),
            optionValue: field("option"),
            variantId: field("variant") || undefined,
            visitorId: field("visitor"),
            idempotencyKey: field("key"),
            leadStepDone: field("leadDone") === "1",
            room: photo,
          }),
        );
      }
      case "ack":
        await acknowledge(shopId, field("job"), field("token"));
        return json({ ok: true });
      case "lead":
        return json(
          await captureLead(admin, {
            shopId,
            email: field("email").trim(),
            firstName: field("firstName").trim(),
            marketing: field("marketing") === "1",
            wording: field("wording"),
            productId: field("product"),
            optionValue: field("option") || undefined,
          }),
        );
      case "issue":
        return json(await reportIssue(shopId, field("job"), field("category")));
      default:
        return json({ error: "NOT_FOUND" }, 404);
    }
  } catch (e) {
    return json({ error: errorCode(e) }, 400);
  }
};
