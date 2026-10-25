/** Browser side of a merchant image upload to the JSON-only /app/fabrics/upload route. */
export async function requestFabricUpload(input: { productId: string; revision: string; file: File; purpose: "sample" | "reference" }, send: typeof fetch = fetch,
  wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {
  const form = new FormData();
  form.set("mode", "manual"); form.set("purpose", input.purpose); form.set("revision", input.revision); form.set("image", input.file);
  const response = await send(`/app/fabrics/upload?product=${encodeURIComponent(input.productId)}`, { method: "POST", body: form, credentials: "same-origin" });
  // An expired session or a proxy error page is HTML; explain it instead of failing to parse it as JSON.
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
    throw new Error(response.status === 401 || response.status === 403 || response.status === 302
      ? "Your Shopify session expired. Refresh the page, then upload the image again."
      : "The upload didn't reach Tryora. Refresh the page and try again; nothing was changed.");
  }
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error ?? "Upload failed. Please try again.");
  if (!result.pending) return result.media as { id: string; url: string; alt?: string | null };
  // Uploaded and attached; Shopify is still processing it. Keep checking (about a minute) and use it when ready.
  for (let check = 0; check < 24 && result.marker; check += 1) {
    await wait(2500);
    const status = await send(`/app/fabrics/upload?product=${encodeURIComponent(input.productId)}&marker=${encodeURIComponent(result.marker)}`, { credentials: "same-origin" }).catch(() => null);
    if (!status || !(status.headers.get("content-type") ?? "").includes("application/json")) continue;
    const body = await status.json().catch(() => ({}));
    if (body.error) throw new Error(body.error);
    if (!body.pending && body.media) return body.media as { id: string; url: string; alt?: string | null };
  }
  throw new Error("Shopify is still processing this image. It will appear under \"Choose an uploaded sample\" in a minute; select it there.");
}
