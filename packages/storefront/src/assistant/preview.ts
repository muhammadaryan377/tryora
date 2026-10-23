/**
 * AI room previews inside the chat. This deliberately calls the same storefront endpoints as the product popup
 * (/preview, /preview/<job>, /ack): the server re-validates the exact product, variant, reference images, quotas,
 * lead capture and credits, and a credit is used only when the delivered image has been displayed and acknowledged.
 */
import { acknowledgeWithRetry, createWithRetry, decodePreview } from "../reliability.js";
import { PROXY } from "./transport.js";
import type { Recommendation } from "./session.js";

export class PreviewError extends Error {
  constructor(readonly code: string) { super(code); }
}

export const PREVIEW_STAGES: Record<string, string> = {
  checking_photo: "Checking your photo…",
  preparing: "Preparing the product reference…",
  generating: "Generating your room preview…",
  checking_result: "Checking the result…",
};

export function previewErrorMessage(code: string): string {
  switch (code) {
    case "BAD_PHOTO": return "This photo isn't suitable for a preview. Try a clear, level photo of the whole space. No credit was used.";
    case "QUOTA_PRODUCT": case "QUOTA_STORE": case "RATE_LIMITED": return "You've reached the preview limit for now. No credit was used.";
    case "CREDITS_EXHAUSTED": case "PLAN_INACTIVE": case "DAILY_CAP": return "New previews are temporarily unavailable. Please try again later.";
    case "BAD_REQUEST": case "NOT_FOUND": return "This exact option can no longer be previewed. Choose another available option. No credit was used.";
    case "RESULT_REJECTED": return "We weren't happy with that image, so we didn't show it. Please try again. No credit was used.";
    default: return "Something went wrong making your preview. No credit was used. Please try again.";
  }
}

async function post(path: string, fields: Record<string, string | Blob>, signal?: AbortSignal) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const response = await fetch(`${PROXY}/${path}`, { method: "POST", body: form, credentials: "same-origin", signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error ?? "REQUEST_FAILED"), { code: body.error ?? "REQUEST_FAILED" });
  return body;
}

/**
 * Generates one preview. Resolves with an object URL once the image has decoded, plus `acknowledge`, which the
 * caller invokes after the image is on screen: like the popup, only a displayed image uses a credit.
 */
export async function generatePreview(input: {
  item: Recommendation;
  photo: Blob;
  visitor: string;
  signal: AbortSignal;
  onStage: (stage: string) => void;
  pollMs?: number;
}): Promise<{ url: string; acknowledge: () => void }> {
  const { item } = input;
  if (!item.previewAvailable || !item.variantId || !item.optionValue) throw new PreviewError("BAD_REQUEST");
  input.onStage("checking_photo");
  let jobId: string;
  try {
    const started = await createWithRetry(() => post("preview", {
      photo: input.photo,
      product: item.productId,
      option: item.optionValue!,
      variant: item.variantId!,
      mappingRevision: "",
      sourceVariant: "",
      visitor: input.visitor,
      key: crypto.randomUUID(),
      leadDone: "0",
    }, input.signal));
    jobId = String(started.jobId);
  } catch (error: any) {
    if (input.signal.aborted) throw error;
    throw new PreviewError(error?.code ?? "REQUEST_FAILED");
  }
  input.onStage("preparing");
  const startedAt = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, input.pollMs ?? 1200));
    if (input.signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (Date.now() - startedAt > 10 * 60_000) throw new PreviewError("TIMEOUT");
    let state: any;
    try {
      const response = await fetch(`${PROXY}/preview/${encodeURIComponent(jobId)}`, { credentials: "same-origin", signal: input.signal });
      if (!response.ok) continue;
      state = await response.json();
    } catch (error) {
      if (input.signal.aborted) throw error;
      continue;
    }
    if (state.stage === "generating" || state.stage === "checking_result") input.onStage(state.stage);
    if (state.stage === "failed" || state.stage === "expired") throw new PreviewError(state.error === "RESULT_REJECTED" ? "RESULT_REJECTED" : "FAILED");
    if (state.stage === "ready") {
      let url = "";
      try {
        const blob = await (await fetch(state.image)).blob();
        url = URL.createObjectURL(blob);
        await decodePreview(url);
      } catch {
        if (url) URL.revokeObjectURL(url);
        throw new PreviewError("FAILED");
      }
      const acknowledge = () => {
        void acknowledgeWithRetry(() => post("ack", { job: jobId, token: state.token }), state.expiresAt ?? Date.now() + 5 * 60_000);
      };
      return { url, acknowledge };
    }
  }
}
