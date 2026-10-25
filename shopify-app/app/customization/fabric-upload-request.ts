/** Browser side of a merchant image upload to the JSON-only /app/fabrics/upload route. */
export async function requestFabricUpload(input: { productId: string; revision: string; file: File; purpose: "sample" | "reference" }, send: typeof fetch = fetch) {
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
  if (result.pending) throw new Error("Shopify is still processing this image. Refresh from Shopify in a moment, then choose it from your uploaded samples.");
  return result.media as { id: string; url: string; alt?: string | null };
}
