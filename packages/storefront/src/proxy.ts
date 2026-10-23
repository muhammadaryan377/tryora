declare const __TRYORA_PROXY__: string | undefined;

/**
 * The storefront app-proxy prefix. Production is "/apps/tryora". An isolated staging app installed alongside
 * production on the same store needs its own subpath, so `TRYORA_PROXY_PATH=/apps/tryora-staging npm run build`
 * bakes a different prefix into that build only (see docs/staging-room-assistant.md).
 */
export const PROXY: string = typeof __TRYORA_PROXY__ === "string" ? __TRYORA_PROXY__ : "/apps/tryora";
