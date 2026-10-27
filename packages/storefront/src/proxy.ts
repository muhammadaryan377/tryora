declare const __TRYORA_PROXY__: string | undefined;

/**
 * The storefront app-proxy prefix. Visully production is "/apps/visully". An isolated staging app installed alongside
 * production on the same store needs its own subpath, so `VISULLY_PROXY_PATH=/apps/visully-staging npm run build`
 * bakes a different prefix into that build only (see docs/staging-room-assistant.md).
 */
export const PROXY: string = typeof __TRYORA_PROXY__ === "string" ? __TRYORA_PROXY__ : "/apps/visully";
