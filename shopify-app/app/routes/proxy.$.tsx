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
import { guardAssistant, guardAssistantRead, guardPhotoCheck, guardPreview } from "../guard.server";
import { productOptionsForAssistant } from "../assistant/options.server";
import {
  answerRoomAssistant,
  assistantStorefrontConfig,
  requireAssistantEnabled,
} from "../room-assistant.server";
import {
  assistantInputFrom,
  cancelAssistantTurn,
  readAssistantTurn,
  startAssistantTurn,
  streamAssistantTurn,
} from "../assistant/turn-routes.server";
import { warmAssistantCatalogue } from "../assistant/catalogue.server";
import { loadCatalogueWelcome } from "../assistant/suggestions.server";
import { logAssistant } from "../assistant/log.server";

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
  if (path === "assistant/config") {
    const config = await assistantStorefrontConfig(session.shop, {
      pageType: url.searchParams.get("pageType") ?? "",
      productId: url.searchParams.get("product") || undefined,
      productHandle: url.searchParams.get("productHandle") || undefined,
      collectionId: url.searchParams.get("collection") || undefined,
      collectionHandle: url.searchParams.get("collectionHandle") || undefined,
    });
    // Load the shop's catalogue in the background so the first question does not wait for it.
    if (config.enabled) warmAssistantCatalogue(admin, session.shop);
    return json(config);
  }
  if (path === "assistant/suggestions") {
    try {
      guardAssistantRead(session.shop, url.searchParams.get("visitor") ?? "");
      await requireAssistantEnabled(session.shop);
      return json(await loadCatalogueWelcome(admin, session.shop, url.searchParams.get("product") ?? undefined));
    } catch {
      return json({ suggestions: [] });
    }
  }
  if (path === "assistant/options") {
    try {
      guardAssistantRead(session.shop, url.searchParams.get("visitor") ?? "");
      return json(await productOptionsForAssistant(admin, session.shop, url.searchParams.get("product") ?? ""));
    } catch (e) {
      const code = errorCode(e);
      return json({ error: code }, code === "RATE_LIMITED" ? 429 : code === "NOT_FOUND" || code === "BAD_REQUEST" ? 404 : 503);
    }
  }
  const turn = path.match(/^assistant\/turn\/([\w-]+)$/);
  if (turn) {
    try {
      return json(await readAssistantTurn(session.shop, url.searchParams.get("visitor") ?? "", turn[1]!, Number(url.searchParams.get("after") ?? 0)));
    } catch (e) {
      const code = errorCode(e);
      return json({ error: code === "NOT_FOUND" ? "NOT_FOUND" : "TEMPORARILY_UNAVAILABLE" }, code === "NOT_FOUND" ? 404 : 503);
    }
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
    const cancel = path.match(/^assistant\/turn\/([\w-]+)\/cancel$/);
    if (cancel) return json(await cancelAssistantTurn(shopId, field("visitor"), cancel[1]!));
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
            sourceVariantId: field("sourceVariant") || undefined,
            mappingRevision: field("mappingRevision") || undefined,
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
      case "assistant/turn":
        return json(await startAssistantTurn(admin, shopId, form));
      case "assistant/stream":
        return await streamAssistantTurn(admin, shopId, form);
      case "assistant/message": {
        // JSON, non-streaming: kept for storefront bundles published before streamed turns.
        guardAssistant(shopId, field("visitor"));
        const settings = await requireAssistantEnabled(shopId);
        return json(await answerRoomAssistant({ ...await assistantInputFrom(form, admin, shopId), settings }));
      }
      default:
        return json({ error: "NOT_FOUND" }, 404);
    }
  } catch (e) {
    const code = errorCode(e);
    if (path.startsWith("assistant/") && code === "RATE_LIMITED") logAssistant("rate_limited", { shop: shopId, reason: "request_window" });
    const status = code === "RATE_LIMITED" ? 429 :
      code === "PROVIDER_UNAVAILABLE" || code === "PROVIDER_TIMEOUT" ? 503 : 400;
    return json({ error: code }, status);
  }
};
