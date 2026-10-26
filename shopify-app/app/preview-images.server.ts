import sharp from "sharp";
import { TryoraError } from "./core/index";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;

/** Decode in memory, reject malformed/animated/oversized files, and discard EXIF. */
export async function normaliseImage(bytes: Uint8Array, kind: "photo" | "sample" = "photo"): Promise<Uint8Array> {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new TryoraError("BAD_PHOTO");
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "warning" });
    const meta = await image.metadata();
    if (!meta.width || !meta.height || meta.width < (kind === "sample" ? 16 : 400) || meta.height < (kind === "sample" ? 16 : 300) || (meta.pages ?? 1) > 1 ||
        !["jpeg", "png", "webp", "heif"].includes(meta.format ?? "")) throw new Error("invalid image");
    return await image.rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer();
  } catch {
    throw new TryoraError("BAD_PHOTO");
  }
}

/** Only download Shopify-hosted references, with a streamed size limit and no redirects. */
export async function downloadReference(url: string, signal: AbortSignal, kind: "photo" | "sample" = "photo"): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "cdn.shopify.com" || parsed.username || parsed.password || parsed.port) {
    throw new TryoraError("PROVIDER_UNAVAILABLE");
  }
  const res = await fetch(parsed, { signal, redirect: "error" });
  if (!res.ok || !res.body || Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) {
    await res.body?.cancel();
    throw new TryoraError("BAD_PHOTO");
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_IMAGE_BYTES) throw new TryoraError("BAD_PHOTO");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return normaliseImage(Buffer.concat(chunks), kind);
}

/** Settles even when a faulty provider ignores cancellation; late results are discarded. */
export async function abortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new TryoraError("PROVIDER_TIMEOUT"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work(), stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}
