import OpenAI, { toFile } from "openai";
import type { GenerateRequest, GenerateResult, ImageProvider, ResultAnalysis, RoomAnalysis } from "./core/provider";
import { TryoraError } from "./core/errors";
import { abortable, MAX_IMAGE_BYTES, normaliseImage } from "./preview-images.server";
import { buildFurnitureReplacementPrompt } from "./furniture-prompt.server";

const TIMEOUT_MS = 150_000; // Fits inside the existing three-minute reservation worker deadline.
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

/** Bound SDK JSON buffering, including chunked responses without Content-Length. */
export const boundedOpenAIFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.body) throw new TryoraError("PROVIDER_UNAVAILABLE");
  const reader = response.body.getReader();
  let total = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) { controller.close(); reader.releaseLock(); return; }
        total += value.length;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new TryoraError("PROVIDER_UNAVAILABLE");
        }
        controller.enqueue(value);
      } catch { controller.error(new TryoraError("PROVIDER_UNAVAILABLE")); }
    },
    cancel: () => reader.cancel(),
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
};

export class OpenAIImageProvider implements ImageProvider {
  constructor(private readonly client: OpenAI, private readonly model = "gpt-image-2") {}

  capabilities() {
    return { name: "openai", zeroRetentionConfirmed: false, supportsCancel: true, supportsMaskedEdit: false };
  }

  async analyseRoom(image: Uint8Array, _angle?: string, _context?: unknown, signal?: AbortSignal): Promise<RoomAnalysis> {
    signal?.throwIfAborted();
    await normaliseImage(image);
    // Structural validation only. No semantic room detection or confidence claim in this release.
    return { outcome: "accepted", confidence: 0, costMicros: 0 };
  }

  async generate(req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    const deadline = AbortSignal.timeout(TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      return await abortable(combined, async () => {
        if (req.placement !== "replace" || !req.productReferences.length || req.productReferences.length > 4 ||
            ((req.swatch || req.fabricTexture) && !req.previewOnlyAppearance)) {
          throw new TryoraError("BAD_REQUEST");
        }
        const room = await normaliseImage(req.roomImage);
        // Only the first, selection-specific reference supplies product identity. Generic additional
        // product references can show a different colour and are deliberately excluded.
        const product = await normaliseImage(req.productReferences[0]!);
        const images = [await toFile(room, "room.jpg", { type: "image/jpeg" }),
          await toFile(product, "selected-product.jpg", { type: "image/jpeg" })];
        if (req.swatch) images.push(await toFile(await normaliseImage(req.swatch, "sample"), "selected-colour-sample.jpg", { type: "image/jpeg" }));
        if (req.fabricTexture) images.push(await toFile(await normaliseImage(req.fabricTexture, "sample"), "selected-fabric-texture.jpg", { type: "image/jpeg" }));
        combined.throwIfAborted();
        const response = await this.client.images.edit({
          model: this.model,
          image: images,
          prompt: buildFurnitureReplacementPrompt(req),
          n: 1,
          size: "auto",
          output_format: "jpeg",
        }, { signal: combined, timeout: TIMEOUT_MS, maxRetries: 0 }).withResponse();
        const data = response.data.data;
        const encoded = data?.[0]?.b64_json;
        if (data?.length !== 1 || !encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
            encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
          throw new TryoraError("RESULT_REJECTED");
        }
        const image = await normaliseImage(Buffer.from(encoded, "base64"));
        return { image, mimeType: "image/jpeg", providerRequestId: response.request_id ?? "unavailable",
          model: this.model, costMicros: 0 };
      });
    } catch (error) {
      // Never propagate SDK error bodies, headers, credentials, prompts or customer data.
      if (combined.aborted || error instanceof OpenAI.APIConnectionTimeoutError) throw new TryoraError("PROVIDER_TIMEOUT");
      if (error instanceof TryoraError) throw error;
      throw new TryoraError("PROVIDER_UNAVAILABLE");
    }
  }

  async checkResult(_req: GenerateRequest, result: GenerateResult, signal?: AbortSignal): Promise<ResultAnalysis> {
    signal?.throwIfAborted();
    try {
      await normaliseImage(result.image);
      return { outcome: "accepted", costMicros: 0 };
    } catch { return { outcome: "rejected", costMicros: 0 }; }
  }
}
