/**
 * Product navigation is storefront-local, not a model-controlled external URL.
 * The server emits only /products/<encoded Shopify handle>[?variant=<numeric ID>].
 * Revalidate here because replies and sessionStorage can contain stale or tampered data.
 */
export function safeProductUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/products/") || /[\x00-\x20\x7f\\]/.test(value)) return null;
  try {
    const url = new URL(value, "https://visully.invalid");
    const match = /^\/products\/([^/?#]+)$/.exec(url.pathname);
    if (url.origin !== "https://visully.invalid" || !match || url.hash) return null;
    if (url.search && !/^\?variant=\d{1,20}$/.test(url.search)) return null;
    const handle = decodeURIComponent(match[1]!);
    if (!/^[\p{L}\p{N}_-]{1,255}$/u.test(handle)) return null;
    if (url.pathname !== `/products/${encodeURIComponent(handle)}`) return null;
    return `${url.pathname}${url.search}`;
  } catch { return null; }
}

/** Do not place model/merchant supplied protocols such as data: or javascript: in image markup. */
export function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
